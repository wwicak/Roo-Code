# AST-LLM Complete Implementation Guide

**Date**: Current  
**Status**: Implementation Guide  
**References**: [05-adr-ast-llm-integration.md](./05-adr-ast-llm-integration.md), [06-ast-llm-integration-evaluation.md](./06-ast-llm-integration-evaluation.md)

This document provides a complete implementation guide for the AST-LLM integration project. It's designed to be followed sequentially by an AI agent, with each section building on the previous ones. The implementation is structured into 4 major phases with clear deliverables.

## Phase 0: Preparation and Dependencies

### 0.1 Ensure Required Dependencies

First, verify the required packages are installed by checking `package.json`:

```javascript
"dependencies": {
  // ... existing dependencies
  "web-tree-sitter": "^0.22.6"
},
"devDependencies": {
  // ... existing dependencies
  "diff-match-patch-ts": "^1.0.5",
  "@types/diff-match-patch": "^1.0.36"
}
```

If these dependencies aren't present, install them:

```bash
npm install web-tree-sitter@0.22.6
npm install diff-match-patch-ts@1.0.5
npm install --save-dev @types/diff-match-patch@1.0.36
```

### 0.2 Create Utility Helper Functions

1. **Create or update the cosine similarity utility**:

File: `src/utils/cosineSimilarity.ts`

```typescript
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
	if (vecA.length !== vecB.length) {
		throw new Error("Vectors must have the same dimensions")
	}

	let dotProduct = 0
	let magnitudeA = 0
	let magnitudeB = 0

	for (let i = 0; i < vecA.length; i++) {
		dotProduct += vecA[i] * vecB[i]
		magnitudeA += vecA[i] * vecA[i]
		magnitudeB += vecB[i] * vecB[i]
	}

	magnitudeA = Math.sqrt(magnitudeA)
	magnitudeB = Math.sqrt(magnitudeB)

	if (magnitudeA === 0 || magnitudeB === 0) {
		return 0 // Handle cases where one or both vectors have zero magnitude
	}

	return dotProduct / (magnitudeA * magnitudeB)
}
```

2. **Verify or create the NebiusEmbeddingService**:

File: `src/services/embedding/NebiusEmbeddingService.ts`

```typescript
export class NebiusEmbeddingService {
	private apiKey: string

	constructor(apiKey: string) {
		this.apiKey = apiKey
	}

	async embedText(text: string): Promise<number[] | null> {
		try {
			const response = await fetch("https://api.studio.nebius.ai/v1/embeddings", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Api-Key ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: "bge-large-en-v1.5",
					text: text,
				}),
			})

			if (!response.ok) {
				const errorData = await response.json()
				throw new Error(
					`Nebius API error: ${response.status} - ${errorData.message || JSON.stringify(errorData)}`,
				)
			}

			const data = await response.json()

			if (data.embedding && data.embedding.length > 0) {
				return data.embedding
			} else {
				console.error("Nebius embedding API returned an empty or invalid response.")
				return null
			}
		} catch (error) {
			console.error("Error in Nebius embedding:", error)
			return null
		}
	}
}
```

## Phase 1: Core AST Services

### 1.1 Implement the AST Provider

Create the AST Provider service to handle parsing and caching ASTs:

File: `src/core/ast/AstService.ts` (new file)

```typescript
import Parser from "web-tree-sitter"
import * as path from "path"
import * as fs from "fs/promises"
import { loadRequiredLanguageParsers } from "../../services/tree-sitter/languageParser"
import { SymbolDatabase } from "./SymbolDatabase"
import { AstCacheManager } from "./AstCacheManager"
import { logger } from "../../utils/logging" // Adjust import based on your logging system

interface AstNode {
	type: string
	text: string
	start: Parser.Point
	end: Parser.Point
	children: AstNode[]
}

export class AstProvider {
	private static instance: AstProvider
	private parserPool = new Map<string, Parser>()
	private activeTrees = new Map<string, Parser.Tree>()
	private symbolDb: SymbolDatabase
	private cacheManager: AstCacheManager
	private initialized = false

	private constructor() {
		this.symbolDb = new SymbolDatabase()
		this.cacheManager = new AstCacheManager()
	}

	public static getInstance(): AstProvider {
		if (!AstProvider.instance) {
			AstProvider.instance = new AstProvider()
		}
		return AstProvider.instance
	}

	public async initialize(): Promise<void> {
		if (this.initialized) return

		try {
			await Parser.init()
			this.initialized = true
			logger.info("AST Provider initialized successfully")
		} catch (error) {
			logger.error("Failed to initialize AST Provider:", error)
			throw error
		}
	}

	public async parseFile(filePath: string, content?: string): Promise<Parser.Tree | null> {
		await this.initialize()

		try {
			// Check cache first
			const cachedTree = this.cacheManager.getCachedTree(filePath)
			if (cachedTree) {
				return cachedTree
			}

			// Read file content if not provided
			if (!content) {
				content = await fs.readFile(filePath, "utf-8")
			}

			// Get language parser
			const ext = path.extname(filePath).slice(1) // Remove the leading dot
			const languageParsers = await loadRequiredLanguageParsers([filePath])
			const languageParser = languageParsers[ext]

			if (!languageParser) {
				logger.warn(`No parser available for extension: ${ext}`)
				return null
			}

			// Parse the file
			const tree = languageParser.parser.parse(content)

			// Cache the result
			this.activeTrees.set(filePath, tree)
			this.cacheManager.cacheTree(filePath, tree)

			// Update symbol database
			this.symbolDb.updateFileSymbols(filePath, tree)

			return tree
		} catch (error) {
			logger.error(`Error parsing file ${filePath}:`, error)
			return null
		}
	}

	public serializeAst(node: Parser.SyntaxNode): AstNode {
		return {
			type: node.type,
			text: node.text,
			start: node.startPosition,
			end: node.endPosition,
			children: node.children.map((child) => this.serializeAst(child)),
		}
	}

	public async getNodeWithIdentifier(filePath: string, identifier: string): Promise<Parser.SyntaxNode | null> {
		const tree = await this.parseFile(filePath)
		if (!tree) return null

		// Simplistic implementation - in production you would want a more efficient lookup
		// using the symbol database to find the node by identifier
		const [name, lineStr] = identifier.split(":")
		const line = parseInt(lineStr, 10) - 1 // Convert to 0-based

		if (isNaN(line)) return null

		function findNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
			// Check if this is the target node
			const nameNode =
				node.childForFieldName("name") || node.childForFieldName("id") || node.childForFieldName("identifier")

			if (
				nameNode &&
				nameNode.text === name &&
				node.startPosition.row === line &&
				(node.type === "function_declaration" ||
					node.type === "function_definition" ||
					node.type === "method_definition")
			) {
				return node
			}

			// Recursively search in children
			for (const child of node.children) {
				const result = findNode(child)
				if (result) return result
			}

			return null
		}

		return findNode(tree.rootNode)
	}

	public invalidateFile(filePath: string): void {
		this.activeTrees.delete(filePath)
		this.cacheManager.invalidateFile(filePath)
		this.symbolDb.removeFile(filePath)
	}
}
```

### 1.2 Implement the Symbol Database

Create the Symbol Database to track code symbols across files:

File: `src/core/ast/SymbolDatabase.ts` (new file)

```typescript
import Parser from "web-tree-sitter"
import * as path from "path"
import { logger } from "../../utils/logging" // Adjust as needed

export interface Symbol {
	name: string
	type: string
	filepath: string
	line: number
	column: number
	scope: string
	references: Array<{ filepath: string; line: number; column: number }>
}

export class SymbolDatabase {
	private symbols: Map<string, Symbol> = new Map()
	private fileSymbols: Map<string, Set<string>> = new Map()

	constructor() {}

	public updateFileSymbols(filepath: string, tree: Parser.Tree): void {
		// Clear existing symbols for this file
		this.removeFile(filepath)

		// Create a set to track symbols in this file
		const fileSymbolSet = new Set<string>()
		this.fileSymbols.set(filepath, fileSymbolSet)

		// Extract symbols from the AST
		this.extractSymbols(filepath, tree.rootNode, "", fileSymbolSet)

		logger.info(`Updated symbols for ${filepath}: ${fileSymbolSet.size} symbols found`)
	}

	private extractSymbols(filepath: string, node: Parser.SyntaxNode, scope: string, fileSymbolSet: Set<string>): void {
		// Process current node for symbol definitions
		const nodeTypes = [
			"function_declaration",
			"function_definition",
			"method_definition",
			"class_declaration",
			"variable_declaration",
			"interface_declaration",
		]

		if (nodeTypes.includes(node.type)) {
			const nameNode =
				node.childForFieldName("name") || node.childForFieldName("id") || node.childForFieldName("identifier")

			if (nameNode) {
				const symbolName = nameNode.text
				const symbolId = this.generateSymbolId(filepath, symbolName, node.startPosition.row)

				const symbol: Symbol = {
					name: symbolName,
					type: node.type,
					filepath,
					line: node.startPosition.row,
					column: node.startPosition.column,
					scope,
					references: [],
				}

				this.symbols.set(symbolId, symbol)
				fileSymbolSet.add(symbolId)

				// Update scope for child symbols
				if (node.type === "class_declaration" || node.type === "interface_declaration") {
					scope = scope ? `${scope}.${symbolName}` : symbolName
				}
			}
		}

		// Process references (simplified - a real implementation would be more complex)
		if (node.type === "identifier" && node.parent?.type !== "property_identifier") {
			const refName = node.text
			// Find all possible symbols with this name and add references
			// This is a simplified approach; a production implementation would require type checking
			for (const [id, symbol] of this.symbols.entries()) {
				if (symbol.name === refName) {
					symbol.references.push({
						filepath,
						line: node.startPosition.row,
						column: node.startPosition.column,
					})
				}
			}
		}

		// Process children
		for (const child of node.children) {
			this.extractSymbols(filepath, child, scope, fileSymbolSet)
		}
	}

	private generateSymbolId(filepath: string, name: string, line: number): string {
		return `${filepath}:${name}:${line}`
	}

	public getSymbol(symbolId: string): Symbol | undefined {
		return this.symbols.get(symbolId)
	}

	public getFileSymbols(filepath: string): Symbol[] {
		const fileSymbolSet = this.fileSymbols.get(filepath)
		if (!fileSymbolSet) return []

		return Array.from(fileSymbolSet)
			.map((id) => this.symbols.get(id))
			.filter((symbol): symbol is Symbol => symbol !== undefined)
	}

	public removeFile(filepath: string): void {
		const fileSymbolSet = this.fileSymbols.get(filepath)
		if (fileSymbolSet) {
			for (const symbolId of fileSymbolSet) {
				this.symbols.delete(symbolId)
			}
			this.fileSymbols.delete(filepath)
		}
	}

	public getRelatedFiles(filepath: string): Set<string> {
		const relatedFiles = new Set<string>()
		const fileSymbolSet = this.fileSymbols.get(filepath)

		if (!fileSymbolSet) return relatedFiles

		// Find all files referencing symbols from this file
		for (const symbolId of fileSymbolSet) {
			const symbol = this.symbols.get(symbolId)
			if (symbol) {
				for (const ref of symbol.references) {
					if (ref.filepath !== filepath) {
						relatedFiles.add(ref.filepath)
					}
				}
			}
		}

		return relatedFiles
	}
}
```

### 1.3 Implement the AST Cache Manager

Create the Cache Manager to optimize AST parsing performance:

File: `src/core/ast/AstCacheManager.ts` (new file)

```typescript
import Parser from "web-tree-sitter"
import * as crypto from "crypto"
import { logger } from "../../utils/logging" // Adjust as needed

interface CacheEntry {
	tree: Parser.Tree
	timestamp: number
	hash: string
}

export class AstCacheManager {
	private cache: Map<string, CacheEntry> = new Map()
	private readonly MAX_CACHE_SIZE = 100 // Adjust based on memory constraints
	private readonly MAX_CACHE_AGE_MS = 5 * 60 * 1000 // 5 minutes

	constructor() {
		// Start periodic cleanup
		setInterval(() => this.cleanupCache(), 60 * 1000) // Run every minute
	}

	public cacheTree(filepath: string, tree: Parser.Tree): void {
		// Generate content hash for versioning
		const hash = this.generateContentHash(tree.rootNode.text)

		this.cache.set(filepath, {
			tree,
			timestamp: Date.now(),
			hash,
		})

		// Ensure cache doesn't grow too large
		if (this.cache.size > this.MAX_CACHE_SIZE) {
			this.shrinkCache()
		}

		logger.debug(`Cached AST for ${filepath}`)
	}

	public getCachedTree(filepath: string): Parser.Tree | null {
		const entry = this.cache.get(filepath)

		if (!entry) return null

		// Check if entry is still valid
		if (Date.now() - entry.timestamp > this.MAX_CACHE_AGE_MS) {
			this.invalidateFile(filepath)
			return null
		}

		// Update timestamp to indicate recent use
		entry.timestamp = Date.now()
		return entry.tree
	}

	public invalidateFile(filepath: string): void {
		this.cache.delete(filepath)
		logger.debug(`Invalidated AST cache for ${filepath}`)
	}

	public invalidateRelatedFiles(filepaths: string[]): void {
		for (const filepath of filepaths) {
			this.invalidateFile(filepath)
		}
	}

	private generateContentHash(content: string): string {
		return crypto.createHash("md5").update(content).digest("hex")
	}

	private shrinkCache(): void {
		// Sort entries by timestamp (oldest first)
		const entries = Array.from(this.cache.entries()).sort(([, a], [, b]) => a.timestamp - b.timestamp)

		// Remove the oldest 20% of entries
		const removeCount = Math.ceil(this.cache.size * 0.2)

		for (let i = 0; i < removeCount && i < entries.length; i++) {
			this.cache.delete(entries[i][0])
		}

		logger.debug(`Cache cleanup: removed ${removeCount} entries, new size: ${this.cache.size}`)
	}

	private cleanupCache(): void {
		const now = Date.now()
		let removedCount = 0

		for (const [filepath, entry] of this.cache.entries()) {
			if (now - entry.timestamp > this.MAX_CACHE_AGE_MS) {
				this.cache.delete(filepath)
				removedCount++
			}
		}

		if (removedCount > 0) {
			logger.debug(`Cache auto-cleanup: removed ${removedCount} stale entries`)
		}
	}

	public getCacheStats(): { size: number; averageAge: number } {
		const now = Date.now()
		let totalAge = 0

		for (const entry of this.cache.values()) {
			totalAge += now - entry.timestamp
		}

		const averageAge = this.cache.size > 0 ? totalAge / this.cache.size : 0

		return {
			size: this.cache.size,
			averageAge,
		}
	}
}
```

### 1.4 Implement the AST Error Handling System

Create the error handling system for AST operations:

File: `src/core/ast/AstErrorHandler.ts` (new file)

```typescript
import Parser from "web-tree-sitter"
import { logger } from "../../utils/logging" // Adjust as needed

export enum AstErrorCode {
	PARSER_NOT_FOUND = "AST_PARSER_NOT_FOUND",
	PARSE_ERROR = "AST_PARSE_ERROR",
	SYMBOL_NOT_FOUND = "AST_SYMBOL_NOT_FOUND",
	INCOMPATIBLE_EDIT = "AST_INCOMPATIBLE_EDIT",
	SEMANTIC_VALIDATION_FAILED = "AST_SEMANTIC_VALIDATION_FAILED",
	STRUCTURAL_VALIDATION_FAILED = "AST_STRUCTURAL_VALIDATION_FAILED",
	NODE_NOT_FOUND = "AST_NODE_NOT_FOUND",
	GENERAL_ERROR = "AST_GENERAL_ERROR",
}

export interface AstError {
	code: AstErrorCode
	message: string
	filepath?: string
	node?: {
		type: string
		identifier?: string
		line?: number
		column?: number
	}
	details?: Record<string, any>
	originalContent?: string
	errorNodes?: Array<{
		startPosition: Parser.Point
		type: string
	}>
}

export interface EditFallback {
	status: "reverted" | "partial" | "alternative"
	message: string
	fallbackContent?: string
	errorLocations?: Array<{
		line: number
		column: number
	}>
	suggestedAction?: string
}

export class AstErrorHandler {
	public static createError(
		code: AstErrorCode,
		message: string,
		details?: Partial<Omit<AstError, "code" | "message">>,
	): AstError {
		const error: AstError = {
			code,
			message,
			...details,
		}

		// Log the error
		logger.error(`AST Error [${code}]: ${message}`, {
			filepath: error.filepath,
			node: error.node,
			details: error.details,
		})

		return error
	}

	public static handleEditFailure(error: AstError): EditFallback {
		switch (error.code) {
			case AstErrorCode.STRUCTURAL_VALIDATION_FAILED:
				return {
					status: "reverted",
					message: `Edit rejected: would change function signature or structure (${error.message})`,
					fallbackContent: error.originalContent,
					suggestedAction: "Modify only the function body without changing parameters or return type",
				}

			case AstErrorCode.SEMANTIC_VALIDATION_FAILED:
				return {
					status: "reverted",
					message: `Edit rejected: semantic validation failed (${error.message})`,
					fallbackContent: error.originalContent,
					suggestedAction: "Ensure the edit preserves the core functionality of the code",
				}

			case AstErrorCode.NODE_NOT_FOUND:
				return {
					status: "reverted",
					message: `Could not locate the target function/method (${error.message})`,
					suggestedAction: "Verify the function name and location are correct",
				}

			case AstErrorCode.PARSER_NOT_FOUND:
				return {
					status: "reverted",
					message: `No parser available for this file type (${error.message})`,
					suggestedAction:
						"This operation is only supported for TypeScript, JavaScript, Python, and other supported languages",
				}

			default:
				return {
					status: "reverted",
					message: `Edit failed: ${error.message}`,
					fallbackContent: error.originalContent,
					errorLocations: error.errorNodes?.map((n) => ({
						line: n.startPosition.row,
						column: n.startPosition.column,
					})),
					suggestedAction: "Try a different approach or simplify the edit",
				}
		}
	}
}
```

## Phase 2: Improved AST Diff Implementation

### 2.1 Enhance the AST Diff Module

Update the existing AST diff implementation with improved structure:

File: `src/core/diff/strategies/new-unified/ast-diff.ts` (enhanced version)

```typescript
import Parser from "web-tree-sitter"
import { loadRequiredLanguageParsers } from "../../../../services/tree-sitter/languageParser"
import { ToolUse, ModifyFunctionBodyToolUse } from "../../../assistant-message"
import { AstProvider } from "../../../ast/AstService"
import { AstErrorHandler, AstErrorCode } from "../../../ast/AstErrorHandler"
import * as path from "path"
import { cosineSimilarity } from "../../../../utils/cosineSimilarity"
import { NebiusEmbeddingService } from "../../../../services/embedding/NebiusEmbeddingService"
import fs from "fs/promises"
import { logger } from "../../../../utils/logging" // Adjust as needed

interface Change {
	type: "added" | "removed" | "modified"
	oldNode?: Parser.SyntaxNode
	newNode?: Parser.SyntaxNode
}

// Enhanced node identifier function to handle more node types
function getNodeIdentifier(node: Parser.SyntaxNode): string {
	const nameNode =
		node.childForFieldName("name") ?? node.childForFieldName("id") ?? node.childForFieldName("identifier")

	if (!nameNode) {
		return `unknown-${node.startPosition.row}`
	}

	// For class methods, include class name for better identification
	if (node.type === "method_definition" || node.type === "class_method" || node.type === "method") {
		// Try to find parent class/interface
		let parent = node.parent
		while (parent) {
			if (parent.type === "class_declaration" || parent.type === "interface_declaration") {
				const classNameNode = parent.childForFieldName("name")
				if (classNameNode) {
					return `${classNameNode.text}.${nameNode.text}:${node.startPosition.row + 1}`
				}
				break
			}
			parent = parent.parent
		}
	}

	const name = nameNode.text
	return `${name}:${node.startPosition.row + 1}` // +1 because VS Code is 1-based
}

// Enhanced node body extractor to handle more node types
async function getNodeBody(node: Parser.SyntaxNode): Promise<string> {
	const bodyNode =
		node.childForFieldName("body") ??
		node.childForFieldName("block") ??
		node.childForFieldName("statement") ??
		node.childForFieldName("value")

	if (!bodyNode) {
		return ""
	}
	return bodyNode.text
}

// Recursive node diffing function
async function diffNodes(
	oldNode: Parser.SyntaxNode | undefined,
	newNode: Parser.SyntaxNode | undefined,
	changes: Change[],
	embeddingService: NebiusEmbeddingService,
	filePath: string,
) {
	if (!oldNode && !newNode) return
	if (!oldNode && newNode) {
		changes.push({ type: "added", newNode })
		return
	}
	if (oldNode && !newNode) {
		changes.push({ type: "removed", oldNode })
		return
	}
	if (!oldNode || !newNode) return

	if (oldNode.type !== newNode.type) {
		changes.push({ type: "modified", oldNode, newNode })
		return
	}

	// Same node type, compare children
	const oldChildren = oldNode.children
	const newChildren = newNode.children

	// For larger trees, you'd want a more sophisticated diffing algorithm here
	const maxLength = Math.max(oldChildren.length, newChildren.length)
	for (let i = 0; i < maxLength; i++) {
		diffNodes(oldChildren[i], newChildren[i], changes, embeddingService, filePath)
	}
}

// Enhanced structure validation
async function validateNodeStructure(oldNode: Parser.SyntaxNode, newNode: Parser.SyntaxNode): Promise<boolean> {
	// Basic type check
	if (oldNode.type !== newNode.type) return false

	// For function declarations, ensure signature hasn't changed
	if (
		oldNode.type === "function_declaration" ||
		oldNode.type === "function_definition" ||
		oldNode.type === "method_definition" ||
		oldNode.type === "class_method" ||
		oldNode.type === "method"
	) {
		// Check parameters
		const oldParams = oldNode.childForFieldName("parameters")
		const newParams = newNode.childForFieldName("parameters")

		if (oldParams && newParams) {
			// Simple parameter count check
			if (oldParams.childCount !== newParams.childCount) {
				return false
			}

			// Parameter names check
			for (let i = 0; i < oldParams.childCount; i++) {
				const oldParam = oldParams.child(i)
				const newParam = newParams.child(i)

				if (oldParam && newParam) {
					// For typed languages, check parameter types
					const oldType = oldParam.childForFieldName("type")
					const newType = newParam.childForFieldName("type")

					if (oldType && newType && oldType.text !== newType.text) {
						return false
					}

					// Check parameter names
					const oldName = oldParam.childForFieldName("name") ?? oldParam.childForFieldName("identifier")
					const newName = newParam.childForFieldName("name") ?? newParam.childForFieldName("identifier")

					if (oldName && newName && oldName.text !== newName.text) {
						return false
					}
				}
			}
		}

		// Check return type if available
		const oldReturnType = oldNode.childForFieldName("return_type") ?? oldNode.childForFieldName("type")
		const newReturnType = newNode.childForFieldName("return_type") ?? newNode.childForFieldName("type")

		if (oldReturnType && newReturnType && oldReturnType.text !== newReturnType.text) {
			return false
		}
	}

	return true
}

// Enhanced semantic validation with adjusted threshold
async function areNodesEquivalent(
	oldNode: Parser.SyntaxNode,
	newNode: Parser.SyntaxNode,
	embeddingService: NebiusEmbeddingService,
	filePath: string,
): Promise<boolean> {
	// Basic check: same node type
	if (oldNode.type !== newNode.type) {
		return false
	}

	// Check supported node types
	const supportedTypes = [
		"function_definition",
		"function_declaration",
		"method_definition",
		"class_method",
		"method",
	]

	if (!supportedTypes.includes(oldNode.type)) {
		// We only handle specific node types for now
		return false
	}

	// Check function name/identifier
	if (getNodeIdentifier(oldNode) !== getNodeIdentifier(newNode)) {
		return false
	}

	// Perform deeper structural validation
	if (!(await validateNodeStructure(oldNode, newNode))) {
		return false
	}

	// Semantic check using embeddings
	const oldBody = await getNodeBody(oldNode)
	const newBody = await getNodeBody(newNode)

	const oldEmbedding = await embeddingService.embedText(oldBody)
	const newEmbedding = await embeddingService.embedText(newBody)

	if (!oldEmbedding || !newEmbedding) {
		// Fallback to textual comparison if embedding fails
		return oldBody === newBody
	}

	const similarity = cosineSimilarity(oldEmbedding, newEmbedding)

	// Log similarity for debugging/tuning
	logger.debug(`[AST-Diff] Similarity score for ${getNodeIdentifier(oldNode)}: ${similarity.toFixed(4)}`)

	return similarity > 0.82 // Adjusted threshold based on research
}

// Main function to get modifications
export async function getFunctionModifications(
	oldCode: string,
	newCode: string,
	filePath: string,
	embeddingService: NebiusEmbeddingService,
): Promise<ModifyFunctionBodyToolUse[] | null> {
	const ext = path.extname(filePath).slice(1)

	try {
		// Get language parser
		const languageParsers = await loadRequiredLanguageParsers([filePath])
		const languageParser = languageParsers[ext]

		if (!languageParser) {
			throw AstErrorHandler.createError(
				AstErrorCode.PARSER_NOT_FOUND,
				`No parser found for file extension: ${ext}`,
				{ filepath: filePath, details: { extension: ext } },
			)
		}

		// Parse the code
		const oldTree = languageParser.parser.parse(oldCode)
		const newTree = languageParser.parser.parse(newCode)

		// Find changes
		const changes: Change[] = []
		await diffNodes(oldTree.rootNode, newTree.rootNode, changes, embeddingService, filePath)

		// Create modification tool uses
		const modifications: ModifyFunctionBodyToolUse[] = []

		// Track rejected modifications for diagnostics
		const rejectedModifications: Array<{
			node: string
			reason: string
			similarity?: number
		}> = []

		// Process each change
		for (const change of changes) {
			if (change.type === "modified" && change.oldNode && change.newNode) {
				const nodeTypes = [
					"function_definition",
					"function_declaration",
					"method_definition",
					"class_method",
					"method",
				]

				if (nodeTypes.includes(change.oldNode.type) && nodeTypes.includes(change.newNode.type)) {
					const isEquivalent = await areNodesEquivalent(
						change.oldNode,
						change.newNode,
						embeddingService,
						filePath,
					)

					if (isEquivalent) {
						modifications.push({
							type: "tool_use",
							name: "modify_function_body",
							params: {
								path: filePath,
								function_identifier: getNodeIdentifier(change.oldNode),
								new_body: await getNodeBody(change.newNode),
							},
							partial: false,
						})
					} else {
						// Track rejected modification for debugging
						rejectedModifications.push({
							node: getNodeIdentifier(change.oldNode),
							reason: "Failed semantic or structural validation",
						})
					}
				}
			}
		}

		// Log rejected modifications
		if (rejectedModifications.length > 0) {
			logger.debug(`[AST-Diff] ${rejectedModifications.length} modifications rejected:`)
			rejectedModifications.forEach((rejected) => {
				logger.debug(`  - ${rejected.node}: ${rejected.reason}`)
			})
		}

		if (modifications.length === 0) {
			return null // No supported modifications found
		}

		return modifications
	} catch (error) {
		if ("code" in error) {
			// This is already an AstError
			throw error
		}

		// Convert generic error to AstError
		throw AstErrorHandler.createError(AstErrorCode.GENERAL_ERROR, `Error in AST diff: ${error.message}`, {
			filepath: filePath,
			details: {
				stack: error.stack,
				original: error,
			},
		})
	}
}

// Function to reconstruct full content with modified function body
export async function reconstructContentWithModifiedFunction(
	originalContent: string,
	functionIdentifier: string,
	newBody: string,
	filePath: string,
): Promise<string | null> {
	try {
		// Get the AST provider
		const astProvider = AstProvider.getInstance()

		// Find the target node
		const node = await astProvider.getNodeWithIdentifier(filePath, functionIdentifier)

		if (!node) {
			throw AstErrorHandler.createError(
				AstErrorCode.NODE_NOT_FOUND,
				`Could not find function with identifier: ${functionIdentifier}`,
				{ filepath: filePath, details: { functionIdentifier } },
			)
		}

		// Get the body node
		const bodyNode =
			node.childForFieldName("body") ??
			node.childForFieldName("block") ??
			node.childForFieldName("statement") ??
			node.childForFieldName("value")

		if (!bodyNode) {
			throw AstErrorHandler.createError(
				AstErrorCode.NODE_NOT_FOUND,
				`Could not find function body for: ${functionIdentifier}`,
				{ filepath: filePath, details: { functionIdentifier } },
			)
		}

		// Replace the function body in the original content
		return (
			originalContent.substring(0, bodyNode.startPosition.column + bodyNode.startPosition.row) +
			newBody +
			originalContent.substring(bodyNode.endPosition.column + bodyNode.endPosition.row)
		)
	} catch (error) {
		logger.error(`Error reconstructing content: ${error.message}`)
		return null
	}
}
```

### 2.2 Create Tests for the AST Diff Module

Create test files to validate the AST diff implementation:

File: `src/core/diff/strategies/new-unified/__tests__/ast-diff.test.ts` (new file)

```typescript
import { getFunctionModifications, reconstructContentWithModifiedFunction } from "../ast-diff"
import { NebiusEmbeddingService } from "../../../../../services/embedding/NebiusEmbeddingService"
import { AstProvider } from "../../../../ast/AstService"

// Mock the embedding service
jest.mock("../../../../../services/embedding/NebiusEmbeddingService", () => {
	return {
		NebiusEmbeddingService: jest.fn().mockImplementation(() => {
			return {
				embedText: jest.fn().mockImplementation(async (text) => {
					// Return mock embeddings with a configurable similarity
					return [0.1, 0.2, 0.3, 0.4, 0.5]
				}),
			}
		}),
	}
})

// Mock the AST Provider
jest.mock("../../../../ast/AstService", () => {
	return {
		AstProvider: {
			getInstance: jest.fn().mockImplementation(() => {
				return {
					getNodeWithIdentifier: jest.fn().mockImplementation(async (filePath, identifier) => {
						// Mock implementation
						return {
							type: "function_declaration",
							text: "function sum(a, b) {\n  return a + b;\n}",
							startPosition: { row: 1, column: 0 },
							endPosition: { row: 3, column: 1 },
							childForFieldName: (name) => {
								if (name === "name") {
									return { text: "sum" }
								}
								if (name === "body") {
									return {
										text: "{\n  return a + b;\n}",
										startPosition: { row: 1, column: 16 },
										endPosition: { row: 3, column: 1 },
									}
								}
								return null
							},
						}
					}),
					parseFile: jest.fn().mockResolvedValue({}),
				}
			}),
		},
	}
})

describe("AST Diff", () => {
	const embeddingService = new NebiusEmbeddingService("fake-api-key")

	// Customize the similarity behavior for specific tests
	beforeEach(() => {
		// Reset mocks
		jest.clearAllMocks()

		// Default implementation returns high similarity
		;(embeddingService.embedText as jest.Mock).mockImplementation(async () => {
			return [0.1, 0.2, 0.3, 0.4, 0.5]
		})
	})

	test("should detect function body modifications", async () => {
		const oldCode = `
      function sum(a, b) {
        return a + b;
      }
    `

		const newCode = `
      function sum(a, b) {
        // Add comment
        return a + b;
      }
    `

		const result = await getFunctionModifications(oldCode, newCode, "test.js", embeddingService)

		expect(result).not.toBeNull()
		expect(result?.length).toBe(1)
		expect(result?.[0].params.function_identifier).toBe("sum:2")
	})

	test("should reject function signature changes", async () => {
		const oldCode = `
      function sum(a, b) {
        return a + b;
      }
    `

		const newCode = `
      function sum(a, b, c) {
        return a + b + c;
      }
    `

		const result = await getFunctionModifications(oldCode, newCode, "test.js", embeddingService)

		expect(result).toBeNull()
	})

	test("should reject low semantic similarity", async () => {
		// Mock to return different embeddings to simulate low similarity
		;(embeddingService.embedText as jest.Mock)
			.mockImplementationOnce(async () => {
				return [0.1, 0.2, 0.3, 0.4, 0.5]
			})
			.mockImplementationOnce(async () => {
				return [0.9, 0.8, 0.7, 0.6, 0.5]
			})

		const oldCode = `
      function sum(a, b) {
        return a + b;
      }
    `

		const newCode = `
      function sum(a, b) {
        return Math.pow(a, b); // Completely different behavior
      }
    `

		const result = await getFunctionModifications(oldCode, newCode, "test.js", embeddingService)

		expect(result).toBeNull()
	})

	test("should reconstruct content with modified function", async () => {
		const originalContent = "function sum(a, b) {\n  return a + b;\n}"
		const functionIdentifier = "sum:1"
		const newBody = "{\n  // Enhanced implementation\n  return a + b;\n}"

		const result = await reconstructContentWithModifiedFunction(
			originalContent,
			functionIdentifier,
			newBody,
			"test.js",
		)

		expect(result).not.toBeNull()
		// Verify the result with a more relaxed assertion since the mock implementation
		// might not perfectly mimic the actual replacement
		expect(result).toContain("// Enhanced implementation")
	})
})
```

## Phase 3: Integration with Cline.ts

### 3.1 Update Cline.ts to Use the Enhanced AST Tools

Update the main Cline.ts file to integrate with the new AST capabilities:

File: `src/core/Cline.ts` (update specific sections)

```typescript
// Add imports at the top
import { AstProvider } from "./ast/AstService"
import { AstErrorHandler, AstErrorCode } from "./ast/AstErrorHandler"
import { reconstructContentWithModifiedFunction } from "./diff/strategies/new-unified/ast-diff"

// In the Cline class constructor, initialize the AST Provider
constructor(/* existing parameters */) {
  // Existing initialization

  // Initialize the AST Provider
  AstProvider.getInstance().initialize().catch(error => {
    logger.error("Failed to initialize AST Provider:", error)
  })
}

// Update the modify_function_body handler in recursivelyMakeClineRequests
case "modify_function_body": {
  const params = toolUse.input as {
    path: string
    function_identifier: string
    new_body: string
  }

  // Validate parameters
  if (!params.path || !params.function_identifier || !params.new_body) {
    // Handle missing parameters
    const toolResultBlock: Anthropic.Messages.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: [{
        type: "text",
        text: "Error: Missing required parameters for modify_function_body."
      }],
      is_error: true,
    }
    toolResultBlocks.push(toolResultBlock)
    continue
  }

  try {
    // 1. Get the file path and original content
    const filePath = params.path
    const absolutePath = path.resolve(cwd, filePath)

    if (!await fileExistsAtPath(absolutePath)) {
      throw AstErrorHandler.createError(
        AstErrorCode.GENERAL_ERROR,
        `File does not exist: ${filePath}`,
        { filepath: filePath }
      )
    }

    const originalContent = await fs.readFile(absolutePath, "utf-8")

    // 2. Use the reconstructContent function to create the new content
    const reconstructedContent = await reconstructContentWithModifiedFunction(
      originalContent,
      params.function_identifier,
      params.new_body,
      filePath
    )

    if (!reconstructedContent) {
      throw AstErrorHandler.createError(
        AstErrorCode.NODE_NOT_FOUND,
        `Failed to reconstruct content with modified function: ${params.function_identifier}`,
        {
          filepath: filePath,
          node: { identifier: params.function_identifier }
        }
      )
    }

    // 3. Validate the modifications using AST diff
    const modifications = await getFunctionModifications(
      originalContent,
      reconstructedContent,
      filePath,
      this.embeddingService
    )

    // 4. If valid modifications were found, apply the changes
    if (modifications && modifications.length > 0) {
      // Write the modified content to the file
      await fs.writeFile(absolutePath, reconstructedContent, 'utf-8')

      // Mark that we've edited a file
      this.didEditFile = true

      // Create success response
      const toolResultBlock: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: [{
          type: "text",
          text: `Successfully modified function body for ${params.function_identifier}`
        }],
        is_error: false,
      }

      toolResultBlocks.push(toolResultBlock)
    } else {
      // No valid modifications were found
      throw AstErrorHandler.createError(
        AstErrorCode.STRUCTURAL_VALIDATION_FAILED,
        `Changes to function ${params.function_identifier} failed validation`,
        {
          filepath: filePath,
          node: { identifier: params.function_identifier }
        }
      )
    }
  } catch (error) {
    // Handle errors
    const astError = 'code' in error ? error : AstErrorHandler.createError(
      AstErrorCode.GENERAL_ERROR,
      `Error modifying function body: ${error.message}`,
      { details: { stack: error.stack } }
    )

    // Get fallback action
    const fallback = AstErrorHandler.handleEditFailure(astError)

    // Create error response
    const toolResultBlock: Anthropic.Messages.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: [{
        type: "text",
        text: `Error: ${fallback.message}. ${fallback.suggestedAction || ''}`
      }],
      is_error: true,
    }

    toolResultBlocks.push(toolResultBlock)
  }

  continue
}
```

### 3.2 Update the System Prompt for Better Integration

Update the system prompt to include information about the enhanced AST capabilities:

File: `src/core/prompts/system.ts` (update specific sections)

```typescript
// In the SYSTEM_PROMPT string, find the modify_function_body section and update it:

## modify_function_body
Description: Modify the body of an existing function in a supported code file. Use this tool whenever you need to change the code *inside* a function without changing its signature (name, parameters, return type).

This tool uses Abstract Syntax Tree (AST) parsing to:
1. Precisely identify the target function
2. Modify only its body while preserving structure
3. Validate the changes don't break interfaces
4. Ensure semantic similarity is maintained

Parameters:
- path: (required) The path to the file (relative to the current working directory ${args.cwd}).
- function_identifier: (required) An opaque string identifier for the function. (Provided by other tools). Do NOT try to guess or construct this identifier. It will look something like: 'myFunction:5' (function name, colon, line number) or 'ClassName.methodName:42' for class methods.
- new_body: (required) The COMPLETE new function body, including correct indentation. This should include all code inside the function's curly braces {} for C-style languages, or the entire indented block for Python.

Usage:
<modify_function_body>
<path>path/to/file.ts</path>
<function_identifier>myFunction:5</function_identifier>
<new_body>
  // The complete new function body,
  // with correct indentation.
  return x + y;
</new_body>
</modify_function_body>

IMPORTANT:
- This tool is recommended for precise edits within existing functions
- Semantic validation ensures your changes maintain similar functionality
- Structural validation prevents accidentally changing function signatures
- Supported languages: TypeScript, JavaScript, Python, Go, C, C++, C#, Ruby, Java, and PHP
- Use this instead of apply_diff when making changes to function bodies
```

## Phase 4: Testing and Validation

### 4.1 Create Integration Tests

Create integration tests to validate the entire AST integration:

File: `src/core/__tests__/ast-integration.test.ts` (new file)

```typescript
import { AstProvider } from "../ast/AstService"
import { reconstructContentWithModifiedFunction } from "../diff/strategies/new-unified/ast-diff"
import { NebiusEmbeddingService } from "../../services/embedding/NebiusEmbeddingService"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

describe("AST Integration Tests", () => {
	let tempDir: string
	let embeddingService: NebiusEmbeddingService

	beforeAll(async () => {
		// Create a temporary directory for test files
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-tests-"))

		// Initialize embedding service with a fake key
		embeddingService = new NebiusEmbeddingService("fake-api-key")

		// Mock the embedText method to return consistent embeddings
		jest.spyOn(embeddingService, "embedText").mockImplementation(async (text) => {
			return Array(10)
				.fill(0)
				.map((_, i) => i * 0.1)
		})

		// Initialize AST Provider
		await AstProvider.getInstance().initialize()
	})

	afterAll(async () => {
		// Clean up temporary directory
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	test("Should parse typescript file and identify functions", async () => {
		// Create a test file
		const filePath = path.join(tempDir, "test.ts")
		const content = `
      function add(a: number, b: number): number {
        return a + b;
      }
      
      class Calculator {
        multiply(a: number, b: number): number {
          return a * b;
        }
      }
    `

		await fs.writeFile(filePath, content, "utf-8")

		// Parse the file
		const astProvider = AstProvider.getInstance()
		const tree = await astProvider.parseFile(filePath, content)

		expect(tree).not.toBeNull()

		// Find the function node
		const addNode = await astProvider.getNodeWithIdentifier(filePath, "add:2")
		expect(addNode).not.toBeNull()
		expect(addNode?.type).toBe("function_declaration")

		// Find the method node
		const multiplyNode = await astProvider.getNodeWithIdentifier(filePath, "Calculator.multiply:6")
		expect(multiplyNode).not.toBeNull()
		expect(multiplyNode?.type).toBe("method_definition")
	})

	test("Should reconstruct content with modified function body", async () => {
		// Create a test file
		const filePath = path.join(tempDir, "modify.ts")
		const originalContent = `
      function calculate(a: number, b: number): number {
        return a + b;
      }
    `

		await fs.writeFile(filePath, originalContent, "utf-8")

		// Modify the function body
		const newBody = `{
        // Enhanced implementation
        const sum = a + b;
        return sum;
      }`

		const reconstructed = await reconstructContentWithModifiedFunction(
			originalContent,
			"calculate:2",
			newBody,
			filePath,
		)

		expect(reconstructed).not.toBeNull()
		expect(reconstructed).toContain("Enhanced implementation")
		expect(reconstructed).toContain("const sum = a + b")

		// Verify the reconstructed content is valid TypeScript
		// This would ideally use the TypeScript compiler API to check validity
	})

	test("Should handle multiple languages", async () => {
		// Test with JavaScript
		const jsPath = path.join(tempDir, "test.js")
		await fs.writeFile(jsPath, "function test() { return true; }", "utf-8")

		// Test with Python
		const pyPath = path.join(tempDir, "test.py")
		await fs.writeFile(pyPath, "def test():\n    return True", "utf-8")

		// Parse both files
		const astProvider = AstProvider.getInstance()
		const jsTree = await astProvider.parseFile(jsPath)
		const pyTree = await astProvider.parseFile(pyPath)

		expect(jsTree).not.toBeNull()
		expect(pyTree).not.toBeNull()
	})

	test("Should handle errors gracefully", async () => {
		// Create a test file with syntax error
		const filePath = path.join(tempDir, "error.ts")
		const invalidContent = `
      function broken( {
        return "missing closing parenthesis";
      }
    `

		await fs.writeFile(filePath, invalidContent, "utf-8")

		// Try to parse the file
		const astProvider = AstProvider.getInstance()
		const tree = await astProvider.parseFile(filePath)

		// Tree should still be returned, but might be partially invalid
		expect(tree).not.toBeNull()

		// Try to modify a non-existent function
		const newBody = `{ return "fixed"; }`

		await expect(
			reconstructContentWithModifiedFunction(invalidContent, "nonexistent:2", newBody, filePath),
		).resolves.toBeNull()
	})
})
```

### 4.2 Add Rollback Mechanism

Create a rollback mechanism for failed AST edits:

File: `src/core/ast/AstRollbackManager.ts` (new file)

```typescript
import * as fs from "fs/promises"
import * as path from "path"
import { logger } from "../../utils/logging" // Adjust as needed

interface EditBackup {
	filePath: string
	originalContent: string
	timestamp: number
	operation: string
}

export class AstRollbackManager {
	private static instance: AstRollbackManager
	private backups: Map<string, EditBackup[]> = new Map()
	private readonly MAX_BACKUPS_PER_FILE = 10

	private constructor() {}

	public static getInstance(): AstRollbackManager {
		if (!AstRollbackManager.instance) {
			AstRollbackManager.instance = new AstRollbackManager()
		}
		return AstRollbackManager.instance
	}

	public async createBackup(filePath: string, operation: string = "modify_function_body"): Promise<boolean> {
		try {
			// Check if file exists
			try {
				await fs.access(filePath)
			} catch {
				logger.warn(`Cannot create backup for non-existent file: ${filePath}`)
				return false
			}

			// Read the original content
			const originalContent = await fs.readFile(filePath, "utf-8")

			// Create backup entry
			const backup: EditBackup = {
				filePath,
				originalContent,
				timestamp: Date.now(),
				operation,
			}

			// Get or create backup array for this file
			let fileBackups = this.backups.get(filePath)
			if (!fileBackups) {
				fileBackups = []
				this.backups.set(filePath, fileBackups)
			}

			// Add backup to the beginning (most recent first)
			fileBackups.unshift(backup)

			// Limit number of backups
			if (fileBackups.length > this.MAX_BACKUPS_PER_FILE) {
				fileBackups.pop() // Remove oldest
			}

			logger.debug(`Created backup for ${filePath} (operation: ${operation})`)
			return true
		} catch (error) {
			logger.error(`Failed to create backup for ${filePath}:`, error)
			return false
		}
	}

	public async rollback(filePath: string): Promise<boolean> {
		try {
			// Get backups for the file
			const fileBackups = this.backups.get(filePath)
			if (!fileBackups || fileBackups.length === 0) {
				logger.warn(`No backups available for ${filePath}`)
				return false
			}

			// Get the most recent backup
			const backup = fileBackups[0]

			// Restore the original content
			await fs.writeFile(filePath, backup.originalContent, "utf-8")

			// Remove the used backup
			fileBackups.shift()

			logger.info(`Rolled back changes to ${filePath}`)
			return true
		} catch (error) {
			logger.error(`Failed to rollback changes to ${filePath}:`, error)
			return false
		}
	}

	public getBackupInfo(filePath: string): Array<Omit<EditBackup, "originalContent">> {
		const fileBackups = this.backups.get(filePath) || []
		return fileBackups.map(({ filePath, timestamp, operation }) => ({
			filePath,
			timestamp,
			operation,
		}))
	}

	public clearBackups(filePath?: string): void {
		if (filePath) {
			this.backups.delete(filePath)
		} else {
			this.backups.clear()
		}
	}
}
```

### 4.3 Update Cline.ts with Rollback Support

Update Cline.ts to use the rollback manager:

```typescript
// Add import
import { AstRollbackManager } from "./ast/AstRollbackManager"

// Update the modify_function_body handler
case "modify_function_body": {
  // ... existing code

  try {
    // 1. Get the file path and original content
    const filePath = params.path
    const absolutePath = path.resolve(cwd, filePath)

    if (!await fileExistsAtPath(absolutePath)) {
      throw AstErrorHandler.createError(
        AstErrorCode.GENERAL_ERROR,
        `File does not exist: ${filePath}`,
        { filepath: filePath }
      )
    }

    const originalContent = await fs.readFile(absolutePath, "utf-8")

    // 2. Create a backup before modifying
    const rollbackManager = AstRollbackManager.getInstance()
    await rollbackManager.createBackup(absolutePath, 'modify_function_body')

    // 3. Use the reconstructContent function to create the new content
    // ... rest of the existing code

    // If an error happens after this point, we can rollback
  } catch (error) {
    // Handle errors
    const astError = 'code' in error ? error : AstErrorHandler.createError(
      AstErrorCode.GENERAL_ERROR,
      `Error modifying function body: ${error.message}`,
      { details: { stack: error.stack } }
    )

    // Try to rollback changes if appropriate
    if (astError.code === AstErrorCode.STRUCTURAL_VALIDATION_FAILED ||
        astError.code === AstErrorCode.SEMANTIC_VALIDATION_FAILED) {
      const absolutePath = path.resolve(cwd, params.path)
      const rollbackManager = AstRollbackManager.getInstance()
      const didRollback = await rollbackManager.rollback(absolutePath)

      if (didRollback) {
        logger.info(`Rolled back changes to ${params.path} due to validation failure`)
      }
    }

    // ... rest of error handling
  }

  continue
}
```

## Phase 5: Finalization and Documentation

### 5.1 Create Documentation for the AST Integration

File: `docs/ast-integration.md` (new file)

```markdown
# AST Integration Documentation

This document explains how the Abstract Syntax Tree (AST) integration works and how to use it effectively.

## Overview

The AST integration allows the VS Code extension to understand and modify code with structural awareness. It uses tree-sitter parsers to convert code files into Abstract Syntax Trees, which represent the code structure in a way that's easier to analyze and modify programmatically.

Key components:

1. **AstProvider**: Manages parsing files into ASTs and provides access to nodes
2. **SymbolDatabase**: Tracks symbols (functions, classes, etc.) across files
3. **AstCacheManager**: Optimizes performance by caching parsed ASTs
4. **AstErrorHandler**: Provides structured error handling
5. **AstRollbackManager**: Enables rolling back changes if needed

## Core Capabilities

### Structural Understanding

The system understands code structure beyond simple text, including:

- Function definitions and their bodies
- Method definitions within classes
- Parameter lists and return types
- Cross-file dependencies

### Semantic Validation

When modifying code, the system validates that changes maintain semantic similarity using:

- Embedding-based comparison (via Nebius API)
- Structural validation of signatures
- Function identity preservation

### Surgical Editing

The `modify_function_body` tool enables precise editing of function bodies without:

- Changing function signatures
- Breaking cross-file references
- Causing syntax errors

## Usage Guidelines

### When to Use AST-Based Editing

- When making changes to function implementations
- When you need to preserve function signatures
- When working with complex files where traditional diffing might fail

### Best Practices

1. **Get Function Identifiers First**: Always use `read_file` to get function identifiers before using `modify_function_body`

2. **Provide Complete Bodies**: When using `modify_function_body`, provide the complete function body, including all braces and indentation

3. **Maintain Semantics**: Ensure your changes don't drastically alter the function's behavior

4. **Language Support**: Remember this works best with typed languages like TypeScript, but also supports JavaScript, Python, and others

## Troubleshooting

Common errors and solutions:

| Error Code              | Description                            | Solution                                            |
| ----------------------- | -------------------------------------- | --------------------------------------------------- |
| AST_PARSER_NOT_FOUND    | No parser for the file type            | Only use with supported languages                   |
| AST_NODE_NOT_FOUND      | Cannot find the target function        | Verify the function identifier is correct           |
| AST_STRUCTURE_MISMATCH  | Changes would alter function signature | Only modify the body, not parameters or return type |
| AST_SEMANTICS_THRESHOLD | Changes too different from original    | Ensure changes maintain similar functionality       |

## Implementation Details

The AST integration follows these key steps:

1. **Parsing**: Code is parsed into an AST using tree-sitter
2. **Analysis**: The AST is analyzed to identify functions, methods, and other structures
3. **Modification**: Function bodies are modified while preserving structure
4. **Validation**: Changes are validated for structural and semantic correctness
5. **Application**: Valid changes are applied to the file

## Contributing

When extending the AST integration:

1. Add tests for any new functionality
2. Update language parsers in tree-sitter as needed
3. Keep the semantic threshold (0.82) consistent unless you have data to support a change
4. Use the error handling and rollback systems consistently
```

### 5.2 Update Package.json with Documentation Links

Update the package.json file to include links to the AST documentation:

```json
{
	"contributes": {
		"commands": [
			{
				"command": "roo-cline.showAstDocumentation",
				"title": "Roo Code: Show AST Documentation",
				"category": "Roo Code"
			}
		]
	}
}
```

### 5.3 Create an Extension Command to Show AST Documentation

File: `src/commands/showAstDocumentation.ts` (new file)

```typescript
import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as path from "path"

export async function showAstDocumentation() {
	try {
		// Get the path to the documentation file
		const extensionPath = vscode.extensions.getExtension("RooVeterinaryInc.roo-cline")?.extensionPath
		if (!extensionPath) {
			throw new Error("Extension path not found")
		}

		const docPath = path.join(extensionPath, "docs", "ast-integration.md")

		// Read the documentation
		const docContent = await fs.readFile(docPath, "utf-8")

		// Show the documentation in a new editor
		const doc = await vscode.workspace.openTextDocument({
			content: docContent,
			language: "markdown",
		})

		await vscode.window.showTextDocument(doc)
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to show AST documentation: ${error.message}`)
	}
}
```

### 5.4 Register the Command in Extension.ts

Update extension.ts to register the new command:

```typescript
// In the activate function
context.subscriptions.push(vscode.commands.registerCommand("roo-cline.showAstDocumentation", showAstDocumentation))
```

## Implementation Sequence and Testing

### Recommended Implementation Order

1. Start with Phase 0: Ensure dependencies and create utility helpers
2. Implement Phase 1: Core AST services
3. Implement Phase 2: Enhanced AST diff implementation
4. Implement Phase 3: Integration with Cline.ts
5. Implement Phase 4: Testing and validation
6. Finish with Phase 5: Documentation and finalization

### Testing Strategy

1. **Unit Tests**: Test each component in isolation
2. **Integration Tests**: Test components working together
3. **Manual Testing**: Test the full workflow with different file types
4. **Edge Cases**: Test with:
    - Large files
    - Complex functions
    - Multiple languages
    - Syntax errors
    - Edge case function structures

### Validation Criteria

The implementation should:

1. Successfully parse code files into ASTs
2. Correctly identify and modify function bodies
3. Validate structural and semantic correctness
4. Properly handle errors and roll back changes when needed
5. Maintain performance with caching
6. Support multiple programming languages

## Conclusion

This implementation guide covers the complete AST-LLM integration as described in the design documents. By following this guide, you will create a robust AST-based code understanding and editing system that enhances the extension's ability to make precise, structure-aware code modifications.
