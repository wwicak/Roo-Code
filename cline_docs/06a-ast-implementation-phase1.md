# AST-LLM Integration: Phase 1 Implementation Guide

**Date**: Current  
**Status**: Implementation Plan  
**References**: [06-ast-llm-integration-evaluation.md](./06-ast-llm-integration-evaluation.md)

This document provides specific implementation guidance for Phase 1 of the AST-LLM integration project, focusing on core improvements that can be made to the existing codebase without requiring significant architectural changes.

## 1. Structural Validation Enhancement

**Current Limitation**: The existing structural validation in `areNodesEquivalent()` is minimal, only checking node types and function names.

**Implementation Steps**:

1. **Update `src/core/diff/strategies/new-unified/ast-diff.ts`**:

```typescript
// Add this new function after the existing areNodesEquivalent function
async function validateNodeStructure(oldNode: Parser.SyntaxNode, newNode: Parser.SyntaxNode): Promise<boolean> {
	// Basic type check
	if (oldNode.type !== newNode.type) return false

	// For function declarations, ensure signature hasn't changed
	if (
		oldNode.type === "function_declaration" ||
		oldNode.type === "function_definition" ||
		oldNode.type === "method_definition"
	) {
		// Check parameters
		const oldParams = oldNode.childForFieldName("parameters")
		const newParams = newNode.childForFieldName("parameters")

		if (oldParams && newParams) {
			// Simple parameter count check
			if (oldParams.childCount !== newParams.childCount) {
				return false
			}

			// Parameter names/types check could be added here if needed
		}

		// Check return type if available
		const oldReturnType = oldNode.childForFieldName("return_type")
		const newReturnType = newNode.childForFieldName("return_type")

		if (oldReturnType && newReturnType && oldReturnType.text !== newReturnType.text) {
			return false
		}
	}

	return true
}
```

2. **Modify `areNodesEquivalent()` function** to use the new structural validation:

```diff
async function areNodesEquivalent(
    oldNode: Parser.SyntaxNode,
    newNode: Parser.SyntaxNode,
    embeddingService: NebiusEmbeddingService,
    filePath: string,
): Promise<boolean> {
    // Basic check: same node type
    if (oldNode.type !== newNode.type) {
        return false;
    }

    if (
        oldNode.type !== "function_definition" &&
        oldNode.type !== "function_declaration" &&
        oldNode.type !== "method_definition"
    ) {
        // we only handle function declarations for now
        return false;
    }

    // Check function name
    if (getNodeIdentifier(oldNode) !== getNodeIdentifier(newNode)) {
        return false;
    }

    // Perform deeper structural validation
    if (!(await validateNodeStructure(oldNode, newNode))) {
        return false;
    }

    // Semantic check using embeddings
    // ... rest of the function remains the same
}
```

## 2. Semantic Threshold Adjustment

**Current Limitation**: The similarity threshold of 0.95 is too strict and rejects many valid edits.

**Implementation Steps**:

1. **Modify the similarity threshold** in `areNodesEquivalent()`:

```diff
const similarity = cosineSimilarity(oldEmbedding, newEmbedding);
- return similarity > 0.95; // Use a threshold (adjust as needed)
+ return similarity > 0.82; // Adjusted threshold based on testing
```

2. **Add logging** to help with future tuning:

```typescript
// Add near the similarity check
console.log(`[AST-Diff] Similarity score for ${getNodeIdentifier(oldNode)}: ${similarity.toFixed(4)}`)
```

## 3. Expanded Node Type Support

**Current Limitation**: Only supports function declarations/definitions.

**Implementation Steps**:

1. **Add support for class methods** by modifying the node type check in `areNodesEquivalent()`:

```diff
if (
    oldNode.type !== "function_definition" &&
    oldNode.type !== "function_declaration" &&
    oldNode.type !== "method_definition"
) {
    // we only handle function declarations for now
    return false;
}
```

2. **Enhance the `getNodeBody()` function** to handle different node types:

```diff
async function getNodeBody(node: Parser.SyntaxNode): Promise<string> {
    const bodyNode = node.childForFieldName("body") ?? node.childForFieldName("block");
    if (!bodyNode) {
        return "";
    }
    return bodyNode.text;
}
```

3. **Update the `getNodeIdentifier()` function** to handle class methods:

```diff
function getNodeIdentifier(node: Parser.SyntaxNode): string {
    const nameNode =
        node.childForFieldName("name") ??
        node.childForFieldName("id") ??
        node.childForFieldName("identifier");

    if (!nameNode) {
        return `unknown-${node.startPosition.row}`;
    }

    // For class methods, include class name for better identification
    if (node.type === "method_definition" || node.type === "class_method" || node.type === "method") {
        // Try to find parent class/interface
        let parent = node.parent;
        while (parent) {
            if (parent.type === "class_declaration" || parent.type === "interface_declaration") {
                const classNameNode = parent.childForFieldName("name");
                if (classNameNode) {
                    return `${classNameNode.text}.${nameNode.text}:${node.startPosition.row + 1}`;
                }
                break;
            }
            parent = parent.parent;
        }
    }

    const name = nameNode.text;
    return `${name}:${node.startPosition.row + 1}`;
}
```

## 4. Error Handling and Reporting

**Current Limitation**: Limited error handling and diagnostic information.

**Implementation Steps**:

1. **Add structured error reporting** by creating a new file `src/core/diff/strategies/new-unified/ast-errors.ts`:

```typescript
export interface AstDiffError {
	code: string
	message: string
	details?: Record<string, any>
	filePath?: string
	nodeType?: string
	nodeName?: string
	similarity?: number
}

export function createAstDiffError(code: string, message: string, details?: Record<string, any>): AstDiffError {
	return {
		code,
		message,
		details,
	}
}

export const AstErrorCodes = {
	PARSER_NOT_FOUND: "AST_PARSER_NOT_FOUND",
	INVALID_NODE_TYPE: "AST_INVALID_NODE_TYPE",
	STRUCTURE_MISMATCH: "AST_STRUCTURE_MISMATCH",
	SEMANTICS_THRESHOLD: "AST_SEMANTICS_THRESHOLD",
	EMBEDDING_FAILED: "AST_EMBEDDING_FAILED",
	GENERAL_ERROR: "AST_GENERAL_ERROR",
}
```

2. **Modify `getFunctionModifications()` to use error reporting**:

```diff
export async function getFunctionModifications(
    oldCode: string,
    newCode: string,
    filePath: string,
    embeddingService: NebiusEmbeddingService,
): Promise<ModifyFunctionBodyToolUse[] | null> {
    const ext = path.extname(filePath).slice(1);

    try {
        const languageParsers = await loadRequiredLanguageParsers([filePath]);

        const languageParser = languageParsers[ext];
        if (!languageParser) {
            console.error(createAstDiffError(
                AstErrorCodes.PARSER_NOT_FOUND,
                `No parser found for file extension: ${ext}`,
                { filePath, extension: ext }
            ));
            return null;
        }

        const oldTree = languageParser.parser.parse(oldCode);
        const newTree = languageParser.parser.parse(newCode);

        const changes: Change[] = [];
        await diffNodes(oldTree.rootNode, newTree.rootNode, changes, embeddingService, filePath);

        const modifications: ModifyFunctionBodyToolUse[] = [];

        // Track rejected modifications for debugging
        const rejectedModifications: AstDiffError[] = [];

        for (const change of changes) {
            if (change.type === "modified" && change.oldNode && change.newNode) {
                // ... existing code

                // If not equivalent, log the reason for rejection
                if (!await areNodesEquivalent(...)) {
                    rejectedModifications.push(createAstDiffError(
                        AstErrorCodes.SEMANTICS_THRESHOLD,
                        "Semantic similarity threshold not met",
                        {
                            nodeName: getNodeIdentifier(change.oldNode),
                            nodeType: change.oldNode.type,
                            filePath
                        }
                    ));
                }
            }
        }

        // Log rejected modifications for debugging
        if (rejectedModifications.length > 0) {
            console.log(`[AST-Diff] ${rejectedModifications.length} modifications rejected:`);
            rejectedModifications.forEach(err => console.log(`  - ${err.message} (${err.code}): ${err.details?.nodeName}`));
        }

        if (modifications.length === 0) {
            return null;
        }

        return modifications;
    } catch (error) {
        console.error(createAstDiffError(
            AstErrorCodes.GENERAL_ERROR,
            `Error in AST diff: ${error.message}`,
            { filePath, error: error.stack }
        ));
        return null;
    }
}
```

## 5. Testing Strategy

Create a new test file `src/core/diff/strategies/new-unified/__tests__/ast-diff.test.ts`:

```typescript
import { getFunctionModifications } from "../ast-diff"
import { NebiusEmbeddingService } from "../../../../../services/embedding/NebiusEmbeddingService"

// Mock the embedding service
jest.mock("../../../../../services/embedding/NebiusEmbeddingService", () => {
	return {
		NebiusEmbeddingService: jest.fn().mockImplementation(() => {
			return {
				embedText: jest.fn().mockImplementation(async (text) => {
					// Return simple mock embeddings for testing
					return [0.1, 0.2, 0.3, 0.4, 0.5]
				}),
			}
		}),
	}
})

describe("AST Diff", () => {
	const embeddingService = new NebiusEmbeddingService("fake-api-key")

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

	// Add more tests as needed
})
```

## 6. Integration with Cline.ts

While full integration will be part of Phase 2, we can prepare for it by adding appropriate comments:

```diff
// In src/core/Cline.ts
case "modify_function_body": {
    const params = toolUse.input as {
        path: string;
        function_identifier: string;
        new_body: string;
    }

    // 1. Get the file path and original content:
    const filePath = params.path
    if(!filePath){
        // Handle missing path error
        break
    }
    const absolutePath = path.resolve(cwd, filePath)
    const originalContent = await fs.readFile(absolutePath, "utf-8");

    // 2. Try to generate AST-based modifications:
    const modifications = await getFunctionModifications(
        originalContent,
        // You need the *proposed* new content here, not just new_body.
        // You'll have to construct the full proposed content from the current
        // state and the tool use. This is the tricky part.
        "TODO: Construct new file content",  // Placeholder for the reconstructed content
        filePath,
        this.embeddingService // Pass the embedding service
    );

    // [PHASE-2-INTEGRATION-POINT]
    // This is where enhanced error handling and fallback strategies
    // will be implemented in Phase 2

    if (modifications) {
        // Existing code...
    }

    // [PHASE-2-INTEGRATION-POINT]
    // This is where improved diagnostics and recovery will be added

    break;
}
```

## 7. Implementation Sequence

1. **Week 1**:

    - Implement structural validation enhancement
    - Adjust semantic threshold
    - Add basic error reporting

2. **Week 2**:

    - Expand node type support
    - Create and run initial tests
    - Add integration points for Phase 2

3. **Week 3**:
    - Refine and fix issues from initial implementation
    - Improve test coverage
    - Create documentation for Phase 1 changes

## 8. Success Criteria

Phase 1 will be considered successful if:

1. Structural validation prevents invalid edits (e.g., signature changes)
2. Semantic threshold of 0.82 accepts more valid edits
3. Support for additional node types works correctly
4. Error reporting provides useful diagnostic information
5. Test suite passes and covers key scenarios

## 9. Next Steps

After completing Phase 1, prepare for Phase 2 by:

1. Measuring the effectiveness of the semantic threshold adjustment
2. Cataloging error patterns to design better recovery mechanisms
3. Planning the validation gate implementation
4. Designing the rollback mechanism
5. Defining integration tests for advanced scenarios
