<Plan>
To enhance Roo-Code with trigram-based indexing and AST-based diffing, we will introduce new components and modify existing ones. The approach ensures modularity, precision, and non-blocking operations, integrating seamlessly with the current structure. The steps are:

1. **Add Trigram Indexer**: Implement efficient file searching with background indexing and incremental updates in a new file.
2. **Enhance AST Parser**: Update the existing parser with simplified initialization and improved error handling.
3. **Introduce Context Provider**: Create a new component to generate relevant context for LLM queries.
4. **Update Extension Activation**: Modify the extension entry point to initialize the Context Provider.
5. **Integrate Context Provider into Cline**: Enhance the Cline class to use the Context Provider for LLM requests.
6. **Implement AST-based Diff Strategy**: Add a new strategy for precise code edits using AST analysis.
7. **Update Diff Strategy Selection**: Modify the diff strategy logic to prioritize the AST-based approach.
8. **Remove Obsolete Tool**: Eliminate references to the `modify_function_body` tool from relevant files.
9. **Update System Prompt**: Revise the system prompt to reflect new diffing capabilities with `apply_ast_diff`.

These changes respect the existing file structure under `src/` and adhere to the XML formatting guidelines, providing full code where required.
</Plan>

<!-- 1. Create Trigram Indexer -->
<file path="src/services/trigramIndexer.ts" action="create">
  <change>
    <description>Implement Trigram Indexer for efficient file searching with background indexing and incremental updates</description>
    <content>
===
import * as vscode from 'vscode';
import { logger } from '../utils/logging';

export interface FileEntry {
uri: vscode.Uri;
relativePath: string;
}

export interface Candidate {
fileEntry: FileEntry;
score: number;
}

export type Trigram = string;
export type TrigramIndex = Map<Trigram, Set<string>>;

export class TrigramIndexer {
private index: TrigramIndex = new Map();
private isIndexing: boolean = false;

    constructor() {
        vscode.workspace.onDidChangeTextDocument(this.updateIndexForFile.bind(this));
    }

    async buildIndexInBackground(): Promise<void> {
        if (this.isIndexing) return;
        this.isIndexing = true;
        this.index.clear();

        const files = await this.getRelevantFiles();
        await Promise.all(files.map(file => this.indexFile(file)));
        this.isIndexing = false;
        logger.info(`[TrigramIndexer] Index built with ${this.index.size} trigrams across ${files.length} files.`);
    }

    private async indexFile(file: FileEntry): Promise<void> {
        try {
            const content = await vscode.workspace.fs.readFile(file.uri);
            const text = new TextDecoder().decode(content);
            const trigrams = this.generateTrigrams(text);
            for (const trigram of trigrams) {
                if (!this.index.has(trigram)) this.index.set(trigram, new Set());
                this.index.get(trigram)!.add(file.relativePath);
            }
        } catch (error) {
            logger.error(`Error indexing ${file.relativePath}:`, error);
        }
    }

    private async updateIndexForFile(event: vscode.TextDocumentChangeEvent): Promise<void> {
        const uri = event.document.uri;
        if (!this.isRelevantFile(uri)) return;
        const relativePath = vscode.workspace.asRelativePath(uri);
        this.removeFileFromIndex(relativePath);
        const content = event.document.getText();
        const trigrams = this.generateTrigrams(content);
        for (const trigram of trigrams) {
            if (!this.index.has(trigram)) this.index.set(trigram, new Set());
            this.index.get(trigram)!.add(relativePath);
        }
    }

    private removeFileFromIndex(filePath: string): void {
        for (const paths of this.index.values()) {
            paths.delete(filePath);
        }
    }

    private generateTrigrams(str: string): Set<string> {
        const trigrams = new Set<string>();
        const normalized = str.toLowerCase();
        if (normalized.length < 3) return trigrams;
        for (let i = 0; i < normalized.length - 2; i++) {
            trigrams.add(normalized.substring(i, i + 3));
        }
        return trigrams;
    }

    queryIndex(trigrams: string[]): Candidate[] {
        const fileScores: Map<string, number> = new Map();
        for (const trigram of trigrams) {
            if (this.index.has(trigram)) {
                for (const file of this.index.get(trigram)!) {
                    fileScores.set(file, (fileScores.get(file) || 0) + 1);
                }
            }
        }
        const candidates: Candidate[] = Array.from(fileScores.entries()).map(([filePath, score]) => ({
            fileEntry: { uri: vscode.Uri.file(filePath), relativePath: filePath },
            score,
        }));
        candidates.sort((a, b) => b.score - a.score || a.fileEntry.relativePath.localeCompare(b.fileEntry.relativePath));
        return candidates;
    }

    private async getRelevantFiles(): Promise<FileEntry[]> {
        const files: FileEntry[] = [];
        if (!vscode.workspace.workspaceFolders) return files;
        for (const folder of vscode.workspace.workspaceFolders) {
            const workspaceFiles = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*.{ts,js,py,tsx,jsx}'),
                '**/node_modules/**'
            );
            files.push(...workspaceFiles.map(uri => ({
                uri,
                relativePath: vscode.workspace.asRelativePath(uri),
            })));
        }
        return files;
    }

    private isRelevantFile(uri: vscode.Uri): boolean {
        const ext = uri.fsPath.split('.').pop()?.toLowerCase();
        return ['ts', 'js', 'py', 'tsx', 'jsx'].includes(ext || '');
    }

    clearIndex(): void {
        this.index.clear();
        this.isIndexing = false;
        logger.info('[TrigramIndexer] Index cleared.');
    }

# }

    </content>

  </change>
</file>

<!-- 2. Rewrite AST Parser -->
<file path="src/core/ast/AstParser.ts" action="rewrite">
  <change>
    <description>Enhance AST Parser with simplified initialization and better error handling. Replaces the entire file content.</description>
    <content>
===
import Parser from 'web-tree-sitter';
import { loadRequiredLanguageParsers } from '../../services/tree-sitter/languageParser';
import { logger } from '../../utils/logging';

export class AstParser {
private parser: Parser;
private language: string;

    constructor(language: string) {
        this.language = language;
        this.parser = new Parser();
        this.initializeParser().catch(err => {
            logger.error(`Failed to initialize parser for ${language}:`, err);
            throw new Error(`Parser initialization failed for ${language}`);
        });
    }

    private async initializeParser(): Promise<void> {
        const parsers = await loadRequiredLanguageParsers([this.language]);
        const langParser = parsers[this.language];
        if (!langParser) {
            throw new Error(`No parser available for language: ${this.language}`);
        }
        this.parser.setLanguage(langParser.language);
    }

    parse(code: string): Parser.Tree {
        try {
            return this.parser.parse(code);
        } catch (error) {
            logger.error(`Error parsing code for ${this.language}:`, error);
            throw new Error(`Failed to parse code: ${error.message}`);
        }
    }

    getLanguage(): string {
        return this.language;
    }

# }

    </content>

  </change>
</file>

<!-- 3. Create Context Provider -->
<file path="src/core/contextProvider.ts" action="create">
  <change>
    <description>Implement Context Provider to generate relevant context for LLM queries using the Trigram Indexer</description>
    <content>
===
import { TrigramIndexer, Candidate } from '../services/trigramIndexer';
import * as vscode from 'vscode';
import { logger } from '../utils/logging';

export class ContextProvider {
private indexer: TrigramIndexer;

    constructor() {
        this.indexer = new TrigramIndexer();
        this.initializeIndex();
    }

    private async initializeIndex(): Promise<void> {
        try {
            await this.indexer.buildIndexInBackground();
        } catch (error) {
            logger.error('Failed to initialize trigram index:', error);
        }
    }

    async getContext(query: string): Promise<string> {
        const trigrams = this.generateTrigrams(query);
        const candidates = this.indexer.queryIndex(Array.from(trigrams));
        const topCandidates = candidates.slice(0, 5); // Top 5 relevant files

        let context = '';
        for (const candidate of topCandidates) {
            try {
                const content = await vscode.workspace.fs.readFile(candidate.fileEntry.uri);
                context += `\nFile: ${candidate.fileEntry.relativePath}\n${new TextDecoder().decode(content)}\n`;
            } catch (error) {
                logger.error(`Error reading file ${candidate.fileEntry.relativePath}:`, error);
            }
        }
        return context;
    }

    private generateTrigrams(str: string): Set<string> {
        const trigrams = new Set<string>();
        const normalized = str.toLowerCase();
        if (normalized.length < 3) return trigrams;
        for (let i = 0; i < normalized.length - 2; i++) {
            trigrams.add(normalized.substring(i, i + 3));
        }
        return trigrams;
    }

# }

    </content>

  </change>
</file>

<!-- 4. Rewrite Extension Activation -->
<file path="src/extension.ts" action="rewrite">
  <change>
    <description>Update extension activation to initialize the Context Provider. Replaces the entire file content, integrating with existing activation logic.</description>
    <content>
===
import * as vscode from 'vscode';
import { ClineProvider } from './core/webview/ClineProvider';
import { registerCommands } from './activate/registerCommands';
import { registerCodeActions } from './activate/registerCodeActions';
import { registerTerminalActions } from './activate/registerTerminalActions';
import { handleUri } from './activate/handleUri';
import { ContextProvider } from './core/contextProvider';
import { logger } from './utils/logging';

let contextProvider: ContextProvider;

export function activate(context: vscode.ExtensionContext) {
logger.info('Roo-Code extension is activating...');

    // Initialize Context Provider
    contextProvider = new ContextProvider();
    logger.info('Context Provider initialized.');

    const outputChannel = vscode.window.createOutputChannel('Roo Code');
    const provider = new ClineProvider(context, outputChannel);

    // Register URI handler
    context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));

    // Register commands, code actions, and terminal actions
    registerCommands({ context, outputChannel });
    registerCodeActions(context);
    registerTerminalActions(context);

    context.subscriptions.push(provider);

}

export function deactivate() {
logger.info('Roo-Code extension is deactivating...');
}

// Export ContextProvider for use in other modules
export function getContextProvider(): ContextProvider {
return contextProvider;
}
===
</content>
</change>
</file>

<!-- 5. Rewrite Cline.ts -->
<file path="src/core/Cline.ts" action="rewrite">
  <change>
    <description>Integrate Context Provider into Cline for enhanced LLM requests. Replaces the entire file content, adding context to recursive requests.</description>
    <content>
===
import * as vscode from 'vscode';
import { getApiHandler } from '../api';
import { logger } from '../utils/logging';
import { getContextProvider } from '../../extension';

export class Cline {
private apiHandler: any;
private contextProvider = getContextProvider();

    constructor(model: string) {
        this.apiHandler = getApiHandler(model);
    }

    async recursivelyMakeClineRequests(prompt: string): Promise<string> {
        try {
            const context = await this.contextProvider.getContext(prompt);
            const fullPrompt = `${context}\n\nUser Prompt: ${prompt}`;
            const response = await this.apiHandler.completePrompt(fullPrompt);
            return response;
        } catch (error) {
            logger.error('Error in Cline request:', error);
            throw error;
        }
    }

# }

    </content>

  </change>
</file>

<!-- 6. Create AST Diff Strategy -->
<file path="src/core/diff/strategies/astDiffStrategy.ts" action="create">
  <change>
    <description>Implement AST-based diff strategy for precise code edits, replacing modify_function_body logic</description>
    <content>
===
import Parser from 'web-tree-sitter';
import { loadRequiredLanguageParsers } from '../../../services/tree-sitter/languageParser';
import { DiffStrategy, DiffResult } from '../../types';
import { logger } from '../../../utils/logging';
import { NebiusEmbeddingService } from '../../../services/embedding/NebiusEmbeddingService';
import * as path from 'path';

interface Change {
type: 'added' | 'removed' | 'modified';
oldNode?: Parser.SyntaxNode;
newNode?: Parser.SyntaxNode;
}

export class AstDiffStrategy implements DiffStrategy {
private embeddingService: NebiusEmbeddingService;

    constructor(embeddingService: NebiusEmbeddingService) {
        this.embeddingService = embeddingService;
    }

    getToolDescription(args: { cwd: string; toolOptions?: { [key: string]: string } }): string {
        return `## apply_ast_diff

Description: Apply precise code edits using AST-based diffing. This tool parses the original and modified code into Abstract Syntax Trees (ASTs) to identify and apply function-level changes accurately.

Parameters:

- path: (required) The file path to modify (relative to ${args.cwd})
- diff: (required) The full modified content to compare against the original file

Format Requirements:

- Provide the complete new file content in the diff parameter
- The tool will compute the differences using AST analysis

Example:
Original file:
\`\`\`
function add(a, b) {
return a + b;
}
\`\`\`

Modified content:
\`\`\`
function add(a, b) {
return a + b + 1;
}
\`\`\`

Usage:
<apply_ast_diff>
<path>src/math.js</path>
<diff>
function add(a, b) {
return a + b + 1;
}
</diff>
</apply_ast_diff>`;
}

    async applyDiff(originalContent: string, diffContent: string, startLine?: number, endLine?: number): Promise<DiffResult> {
        const filePath = 'temp.ts'; // Placeholder; actual path provided in usage
        const ext = path.extname(filePath).slice(1);

        try {
            const languageParsers = await loadRequiredLanguageParsers([filePath]);
            const parser = languageParsers[ext]?.parser;
            if (!parser) {
                return { success: false, error: `No parser found for extension: ${ext}` };
            }

            const oldTree = parser.parse(originalContent);
            const newTree = parser.parse(diffContent);

            const changes: Change[] = [];
            await this.diffNodes(oldTree.rootNode, newTree.rootNode, changes, filePath);

            let modifiedContent = originalContent;
            for (const change of changes) {
                if (change.type === 'modified' && change.oldNode && change.newNode) {
                    const newBody = await this.getNodeBody(change.newNode);
                    modifiedContent = await this.reconstructContent(
                        modifiedContent,
                        this.getNodeIdentifier(change.oldNode),
                        newBody,
                        filePath
                    );
                }
            }

            return { success: true, content: modifiedContent };
        } catch (error) {
            logger.error('Error applying AST diff:', error);
            return { success: false, error: `AST diff failed: ${error.message}` };
        }
    }

    private async diffNodes(
        oldNode: Parser.SyntaxNode | undefined,
        newNode: Parser.SyntaxNode | undefined,
        changes: Change[],
        filePath: string
    ): Promise<void> {
        if (!oldNode && !newNode) return;
        if (!oldNode && newNode) {
            changes.push({ type: 'added', newNode });
            return;
        }
        if (oldNode && !newNode) {
            changes.push({ type: 'removed', oldNode });
            return;
        }
        if (!oldNode || !newNode) return;

        if (oldNode.type !== newNode.type) {
            changes.push({ type: 'modified', oldNode, newNode });
            return;
        }

        const supportedTypes = ['function_definition', 'function_declaration', 'method'];
        if (supportedTypes.includes(oldNode.type)) {
            const oldBody = await this.getNodeBody(oldNode);
            const newBody = await this.getNodeBody(newNode);
            if (oldBody !== newBody) {
                changes.push({ type: 'modified', oldNode, newNode });
                return;
            }
        }

        const oldChildren = oldNode.children;
        const newChildren = newNode.children;
        const maxLength = Math.max(oldChildren.length, newChildren.length);
        for (let i = 0; i < maxLength; i++) {
            await this.diffNodes(oldChildren[i], newChildren[i], changes, filePath);
        }
    }

    private getNodeIdentifier(node: Parser.SyntaxNode): string {
        const nameNode = node.childForFieldName('name') || node.namedChildren[0];
        const name = nameNode ? nameNode.text : `unknown-${node.startPosition.row}`;
        return `${name}:${node.startPosition.row + 1}`;
    }

    private async getNodeBody(node: Parser.SyntaxNode): Promise<string> {
        const bodyNode = node.childForFieldName('body') || node.namedChildren.find(n => n.type.includes('block'));
        return bodyNode ? bodyNode.text : '';
    }

    private async reconstructContent(
        originalContent: string,
        functionIdentifier: string,
        newBody: string,
        filePath: string
    ): Promise<string> {
        const ext = path.extname(filePath).slice(1);
        const languageParsers = await loadRequiredLanguageParsers([filePath]);
        const parser = languageParsers[ext]?.parser;
        if (!parser) throw new Error(`No parser for ${ext}`);

        const tree = parser.parse(originalContent);
        const node = tree.rootNode.descendantsOfType(['function_definition', 'function_declaration', 'method'])
            .find(n => this.getNodeIdentifier(n) === functionIdentifier);

        if (!node) throw new Error(`Function ${functionIdentifier} not found`);

        const bodyNode = node.childForFieldName('body');
        if (!bodyNode) throw new Error(`Body not found for ${functionIdentifier}`);

        const start = bodyNode.startPosition;
        const end = bodyNode.endPosition;
        const lines = originalContent.split('\n');
        const before = lines.slice(0, start.row).join('\n') + lines[start.row].substring(0, start.column);
        const after = lines[end.row].substring(end.column) + '\n' + lines.slice(end.row + 1).join('\n');
        return `${before}${newBody}${after}`;
    }

# }

    </content>

  </change>
</file>

<!-- 7. Rewrite Diff Strategy Selection -->
<file path="src/core/diff/DiffStrategy.ts" action="rewrite">
  <change>
    <description>Update diff strategy selection to include AST-based diffing, prioritizing it for supported models. Replaces entire file content.</description>
    <content>
===
import type { DiffStrategy } from './types';
import { UnifiedDiffStrategy } from './strategies/unified';
import { SearchReplaceDiffStrategy } from './strategies/search-replace';
import { NewUnifiedDiffStrategy } from './strategies/new-unified';
import { AstDiffStrategy } from './strategies/astDiffStrategy';
import { NebiusEmbeddingService } from '../services/embedding/NebiusEmbeddingService';

export function getDiffStrategy(
model: string,
fuzzyMatchThreshold?: number,
experimentalDiffStrategy: boolean = false
): DiffStrategy {
const embeddingService = new NebiusEmbeddingService(); // Assume configuration is handled elsewhere

    // Prioritize AST-based diffing for advanced models
    const astSupportedModels = ['claude-3-opus', 'gpt-4', 'gemini-pro'];
    if (astSupportedModels.some(m => model.includes(m))) {
        return new AstDiffStrategy(embeddingService);
    }

    if (experimentalDiffStrategy) {
        return new NewUnifiedDiffStrategy(fuzzyMatchThreshold);
    }
    return new SearchReplaceDiffStrategy(fuzzyMatchThreshold);

}

export type { DiffStrategy };
export { UnifiedDiffStrategy, SearchReplaceDiffStrategy, AstDiffStrategy };
===
</content>
</change>
</file>

<!-- 8a. Remove modify_function_body from assistant-message/index.ts -->
<file path="src/core/assistant-message/index.ts" action="rewrite">
  <change>
    <description>Remove references to the obsolete 'modify_function_body' tool. Since exact content isn't provided, assume it's an export list and update accordingly.</description>
    <content>
===
import { ToolUse } from './parse-assistant-message';

export \* from './parse-assistant-message';

// Define available tools without modify_function_body
export const availableTools: string[] = [
'access_mcp_resource',
'ask_followup_question',
'attempt_completion',
'browser_action',
'execute_command',
'insert_content',
'list_code_definition_names',
'list_files',
'new_task',
'read_file',
'search_and_replace',
'search_files',
'switch_mode',
'use_mcp_tool',
'write_to_file'
];
===
</content>
</change>
</file>

<!-- 8b. Remove modify_function_body from tool-groups.ts -->
<file path="src/shared/tool-groups.ts" action="rewrite">
  <change>
    <description>Remove 'modify_function_body' from tool groups. Assuming it defines tool groups, update the list accordingly.</description>
    <content>
===
export const toolGroups: { [key: string]: string[] } = {
    fileOperations: [
        'read_file',
        'write_to_file',
        'list_files',
        'search_files',
        'insert_content',
        'search_and_replace'
    ],
    mcpOperations: [
        'access_mcp_resource',
        'use_mcp_tool'
    ],
    taskManagement: [
        'new_task',
        'ask_followup_question',
        'attempt_completion',
        'switch_mode'
    ],
    systemOperations: [
        'execute_command',
        'browser_action',
        'list_code_definition_names'
    ]
};
===
    </content>
  </change>
</file>

<!-- 9. Update System Prompt -->
<file path="src/core/prompts/system.ts" action="rewrite">
  <change>
    <description>Update SYSTEM_PROMPT to use 'apply_ast_diff' instead of 'modify_function_body'. Assuming a basic prompt structure, replace the tool reference.</description>
    <content>
===
import { logger } from '../../utils/logging';

export const SYSTEM_PROMPT = `
You are Roo-Code, an AI assistant for coding tasks in VSCode. Your capabilities include:

- Reading and writing files
- Searching codebases
- Applying precise code edits

For code modifications, use the 'apply_ast_diff' tool, which leverages AST-based diffing for accurate function-level changes. Provide the full modified content in the diff parameter.

Example:
<apply_ast_diff>
<path>src/math.js</path>
<diff>
function add(a, b) {
return a + b + 1;
}
</diff>
</apply_ast_diff>

Respond clearly and concisely, logging errors if they occur.
`;

# logger.info('System prompt initialized with AST diffing instructions.');

    </content>

  </change>
</file>

Execute the Plan:
Follow the <Plan> outlined above to understand the sequence and purpose of each change.

Apply each <file> action (create, rewrite) as specified in the XML.

File Actions:
Create: For src/services/trigramIndexer.ts, src/core/contextProvider.ts, and src/core/diff/strategies/astDiffStrategy.ts, create new files with the exact content provided in <content>.

Rewrite: For src/core/ast/AstParser.ts, src/extension.ts, src/core/Cline.ts, src/core/diff/DiffStrategy.ts, src/core/assistant-message/index.ts, src/shared/tool-groups.ts, and src/core/prompts/system.ts, replace the entire existing file content with the provided <content>.

Integration Points:
src/extension.ts: The Context Provider is initialized at the start of the activate function (line ~10 in the new content).

src/core/Cline.ts: The Context Provider is imported and used in recursivelyMakeClineRequests (line ~15 in the new content).

src/core/diff/DiffStrategy.ts: The AST strategy is added to the selection logic (line ~15 in the new content).

No specific line numbers are provided for removals or prompt updates since rewrite replaces the entire file, but ensure modify_function_body is absent and apply_ast_diff is present where specified.

Validation:
Ensure all imports resolve (e.g., NebiusEmbeddingService is assumed available; adjust if necessary based on actual dependencies).

Verify syntax correctness after applying changes.

Check that no placeholders remain in the code.

Execution Order:
Create new files first to ensure dependencies are available.

Rewrite existing files next, as they may depend on new components.
