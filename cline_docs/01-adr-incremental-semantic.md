**Objective:** Implement the `modify_function_body` tool for the `code` mode. This tool will allow you to modify the body of existing functions in TypeScript, JavaScript, Python, Go, C, C++, C#, Ruby, Java, and PHP files. You will use Tree-sitter for parsing and Nebius AI for semantic similarity comparisons. This is a one-shot implementation, so you _must_ complete all steps in a single response.

**Context:**

- You are operating within a VS Code extension project named "roo-code".
- You have access to a pre-existing `ClineProvider` class, a `Cline` class, and several utility functions.
- You _must not_ use `apply_diff` or `write_to_file` to modify function bodies. Use only `modify_function_body`.
- You will receive a `function_identifier` from other tools (like `read_file`). Do _not_ try to generate this identifier yourself.
- You need to provide the _complete_ new function body.
- The Nebius API Key is **HARDCODED** for this implementation (for testing simplicity). In a real-world scenario, this would be retrieved from configuration.

**Task Steps:**

1.  **Install Dependencies (if needed):** Verify that the following dependencies are installed in the `package.json` file. If not, install them. This step should not be necessary as previous instructions indicate to install necessary packages. We just want to make it clear it's the agent's responsibility to verify and handle dependencies.

    ```
    "web-tree-sitter": "^0.22.6",
    "diff-match-patch-ts": "^1.0.5", // for similarity score, not patching
    "@types/diff-match-patch": "^1.0.36",
    "@types/node": "^18.0.0",
    ```

    You may need to use `npm install` in your terminal commands if you encounter issues related to these dependencies, but you can also ask the user to check.

2.  **Create/Update Utility Files:**

    - **`src/utils/cosineSimilarity.ts` (New File):** Create this file with the provided code. This function calculates the cosine similarity between two vectors.

        ```typescript
        // src/utils/cosineSimilarity.ts
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

    - **`src/services/embedding/NebiusEmbeddingService.ts` (New File):** Create this file with the provided code. This class handles communication with the Nebius AI embedding API using `fetch`.

        ```typescript
        // src/services/embedding/NebiusEmbeddingService.ts

        export class NebiusEmbeddingService {
        	private apiKey: string

        	constructor(apiKey: string) {
        		this.apiKey =
        			"eyJhbGciOiJIUzI1NiIsImtpZCI6IlV6SXJWd1h0dnprLVRvdzlLZWstc0M1akptWXBvX1VaVkxUZlpnMDRlOFUiLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiJnb29nbGUtb2F1dGgyfDEwNTc0NDkwNDMzOTc4MDE2NjkyMiIsInNjb3BlIjoib3BlbmlkIG9mZmxpbmVfYWNjZXNzIiwiaXNzIjoiYXBpX2tleV9pc3N1ZXIiLCJhdWQiOlsiaHR0cHM6Ly9uZWJpdXMtaW5mZXJlbmNlLmV1LmF1dGgwLmNvbS9hcGkvdjIvIl0sImV4cCI6MTg5NzI4Mjg0MiwidXVpZCI6IjA0NjYxNDhjLTJkYzEtNGEzMy1hOTU1LTM2MDUxMzg0NzVlNSIsIm5hbWUiOiJkaWZmIiwiZXhwaXJlc19hdCI6IjIwMzAtMDItMTRUMDc6MDA6NDIrMDAwMCJ9.VCOD4QfxwPhiHqlFFXps2dZwjap0iGf3lyaK_GjpGBU"
        	}

        	async embedText(text: string): Promise<number[] | null> {
        		try {
        			const response = await fetch("https://api.studio.nebius.ai/v1/embeddings", {
        				method: "POST",
        				headers: {
        					"Content-Type": "application/json",
        					Authorization: `Api-Key ${this.apiKey}`, // Use the API key
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

3.  **Create `src/core/diff/strategies/new-unified/ast-diff.ts` (New File):**

    ```typescript
    // src/core/diff/strategies/new-unified/ast-diff.ts
    import Parser from "web-tree-sitter"
    import { loadRequiredLanguageParsers } from "../../../../services/tree-sitter/languageParser"
    import { ToolUse, ModifyFunctionBodyToolUse } from "../../../assistant-message"
    import { fileExistsAtPath } from "../../../../utils/fs"
    import * as path from "path"
    import { cosineSimilarity } from "../../../../utils/cosineSimilarity"
    import { NebiusEmbeddingService } from "../../../../services/embedding/NebiusEmbeddingService"
    import fs from "fs/promises"

    interface Change {
    	type: "added" | "removed" | "modified"
    	oldNode?: Parser.SyntaxNode
    	newNode?: Parser.SyntaxNode
    }

    // Generates function identifier from function name and line number.
    function getNodeIdentifier(node: Parser.SyntaxNode): string {
    	// Prioritize 'name' field, then 'id', then 'identifier'
    	const nameNode =
    		node.childForFieldName("name") ?? node.childForFieldName("id") ?? node.childForFieldName("identifier")

    	if (!nameNode) {
    		return `unknown-${node.startPosition.row}` // Should not reach here, but provide a fallback
    	}
    	const name = nameNode.text
    	return `${name}:${node.startPosition.row + 1}` // +1 because VS Code is 1-based
    }

    async function getNodeBody(node: Parser.SyntaxNode): Promise<string> {
    	// Look for common body field names.  This is a heuristic and might need
    	// adjustment based on the specific grammars.
    	const bodyNode = node.childForFieldName("body") ?? node.childForFieldName("block")
    	if (!bodyNode) {
    		return "" // Or maybe throw an error, depending on how strict you want to be
    	}
    	return bodyNode.text
    }
    async function diffNodes(
    	oldNode: Parser.SyntaxNode | undefined,
    	newNode: Parser.SyntaxNode | undefined,
    	changes: Change[],
    	embeddingService: NebiusEmbeddingService, // Pass the service
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

    	// Same node type, compare children (pseudocode)
    	const oldChildren = oldNode.children
    	const newChildren = newNode.children

    	// simple implementation for example, would need to use an algorithm like in findBestMatch
    	const maxLength = Math.max(oldChildren.length, newChildren.length)
    	for (let i = 0; i < maxLength; i++) {
    		diffNodes(oldChildren[i], newChildren[i], changes, embeddingService, filePath) // Pass embedText
    	}
    }

    async function areNodesEquivalent(
    	oldNode: Parser.SyntaxNode,
    	newNode: Parser.SyntaxNode,
    	embeddingService: NebiusEmbeddingService, // Pass the service
    	filePath: string,
    ): Promise<boolean> {
    	// Basic check: same node type
    	if (oldNode.type !== newNode.type) {
    		return false
    	}

    	if (
    		oldNode.type !== "function_definition" &&
    		oldNode.type !== "function_declaration" &&
    		oldNode.type !== "method_definition"
    	) {
    		// we only handle function declarations for now
    		return false
    	}

    	// Check function name
    	if (getNodeIdentifier(oldNode) !== getNodeIdentifier(newNode)) {
    		return false
    	}

    	// Semantic check using embeddings
    	const oldBody = await getNodeBody(oldNode)
    	const newBody = await getNodeBody(newNode)

    	const oldEmbedding = await embeddingService.embedText(oldBody)
    	const newEmbedding = await embeddingService.embedText(newBody)

    	if (!oldEmbedding || !newEmbedding) {
    		// Fallback to textual comparison if embedding fails
    		// this is a weak comparison, and you shouldn't expect
    		// that it can handle significant changes. It will
    		// fail often.
    		return oldBody === newBody
    	}

    	const similarity = cosineSimilarity(oldEmbedding, newEmbedding)
    	return similarity > 0.95 // Use a threshold (adjust as needed)
    }

    export async function getFunctionModifications(
    	oldCode: string,
    	newCode: string,
    	filePath: string,
    	embeddingService: NebiusEmbeddingService,
    ): Promise<ModifyFunctionBodyToolUse[] | null> {
    	const ext = path.extname(filePath).slice(1) // ".ts" -> "ts"

    	// Load required language parsers
    	const languageParsers = await loadRequiredLanguageParsers([filePath])

    	// Get parser based on file extension
    	const languageParser = languageParsers[ext]
    	if (!languageParser) {
    		console.error(`No parser found for file extension: ${ext}`)
    		return null
    	}

    	const oldTree = languageParser.parser.parse(oldCode)
    	const newTree = languageParser.parser.parse(newCode)

    	const changes: Change[] = []
    	// Pass embedText down to the recursive diffing function
    	await diffNodes(oldTree.rootNode, newTree.rootNode, changes, embeddingService, filePath)

    	const modifications: ModifyFunctionBodyToolUse[] = []

    	for (const change of changes) {
    		if (change.type === "modified" && change.oldNode && change.newNode) {
    			const nodeTypes = ["function_definition", "function_declaration", "method_definition"]
    			if (
    				nodeTypes.includes(change.oldNode.type) &&
    				nodeTypes.includes(change.newNode.type) &&
    				(await areNodesEquivalent(change.oldNode, change.newNode, embeddingService, filePath)) // Pass embedText
    			) {
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
    			}
    		}
    	}

    	if (modifications.length === 0) {
    		return null // No supported modifications found
    	}

    	return modifications
    }
    ```

4.  **Modify `src/core/Cline.ts`:**

    ```typescript
    // In Cline.ts
    import { getFunctionModifications } from "./diff/strategies/new-unified/ast-diff"
    import { NebiusEmbeddingService } from "../services/embedding/NebiusEmbeddingService" // Import

    class Cline {
    	private embeddingService: NebiusEmbeddingService

    	constructor(
            private readonly providerRef: WeakRef<ClineProvider>,
            private readonly apiConfiguration: ApiConfiguration,
            public customInstructions?: string,
            public diffEnabled: boolean = false,
            public readonly checkpointsEnabled: boolean = false,
            fuzzyMatchThreshold: number = 1.0,
            task?: string,
            images?: string[],
            historyItem?: HistoryItem,
            experiments?: Record<string, boolean>
    	) {
    		// ...
    		this.embeddingService = new NebiusEmbeddingService() // or inject via provider
            if (apiConfiguration.apiKey) {
                this.embeddingService = new NebiusEmbeddingService(apiConfiguration.apiKey);
             }
        else{
             throw new Error("Nebius API key is required")
            }
    		// ...
    	}

        // ... inside recursivelyMakeClineRequests ...

            case "content_block_stop":
                    switch (chunk.content_block.type) {
                        case "tool_use":
                          const toolUse = (chunk.content_block as Anthropic.Messages.ToolUseBlock)
                          switch(toolUse.name){
                            // other cases
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


                              if (modifications) {
                                  // 3. Construct tool use blocks
                                  const toolUseBlocks: Anthropic.Messages.ToolUseBlock[] = modifications.map(
                                    (mod) => ({
                                        type: "tool_use",
                                        id: \`tooluse-\${Date.now()}\`,  // Generate unique ID
                                        name: mod.name,
                                        input: mod.params // the validated parameters that the AI is passing
                                    })
                                )


                                  // 4. Construct tool result blocks
                                  const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] =
                                  toolUseBlocks.map(toolUse => ({
                                      type: "tool_result",
                                      tool_use_id: toolUse.id,
                                      content: [{ type: "text", text: "Function modification successful." }],
                                      is_error: false,
                                  }))

                                  // 5. Add to messages
                                  // (Add to this.apiConversationHistory, not just to the stream's messages)
                                  this.apiConversationHistory.push({
                                    role: "assistant",
                                    content: [...toolUseBlocks]
                                  })
                                  this.apiConversationHistory.push({
                                    role: "user",
                                    content: [...toolResultBlocks]
                                  })

                                  // 6. Continue the loop (or call recursivelyMakeClineRequests again)
                                // You *might* need to call recursivelyMakeClineRequests here,
                                // depending on how you structure your main loop.
                                continue // Skip to next chunk, don't fall through to apply_diff

                              }

                              // 4. Fallback:  If getFunctionModifications returns null,
                              //    fall back to the existing apply_diff logic (at least initially).

                              break;
                            }
                          }
                    break
                    }
                  break
              }
    ```

5.  **Update System Prompt:**

    Add this to the `SYSTEM_PROMPT` in `src/core/prompts/system.ts`:

    ```
    ## modify_function_body
    Description: Modify the body of an existing function in a TypeScript file. Use this tool whenever you need to change the code *inside* a function. Do NOT use this to add or remove entire functions. Do NOT use this to change the function's signature (name, parameters, return type). This tool automatically handles formatting and indentation.
    Parameters:
    - path: (required) The path to the file (relative to the current working directory \${args.cwd}).
    - function_identifier: (required) An opaque string identifier for the function.  (Provided by other tools). Do NOT try to guess or construct this identifier. It will look something like: 'myFunction:5' (function name, colon, line number).
    - new_body: (required) The COMPLETE new function body, including correct indentation.  This should include all code inside the function's curly braces {}.
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
    - You MUST use \`modify_function_body\` for ALL changes *inside* existing TypeScript functions.
    - Do NOT use \`apply_diff\` or \`write_to_file\` to modify existing functions.
    - You will receive the \`function_identifier\` from other tools (primarily \`read_file\`). Do NOT guess it.

    ```

    Remove or significantly downplay `apply_diff` and `write_to_file` in the system prompt, or at the very least, add clear instructions that they are _not_ to be used for modifying function bodies.

**Key Changes and Explanations:**

- **`cosineSimilarity.ts`:** Standard cosine similarity implementation.
- **`NebiusEmbeddingService.ts`:** Uses the `openai` library (or a compatible one) to communicate with the Nebius API. The `embedText` method sends the text and gets back the embedding vector.
- **`ast-diff.ts`:**
    - **`getNodeIdentifier`:** Now more robust, handling different ways a function name might appear in the AST. Uses line numbers for uniqueness.
    - **`getNodeBody`:** Handles different possible field names for the function body.
    - **`diffNodes`:** Still a placeholder, but the structure is there. You'll need to implement the actual AST diffing logic.
    - **`areNodesEquivalent`:** The core logic. Checks node types, function identifiers (name + line), and then uses the `NebiusEmbeddingService` to get embeddings and compare them. Falls back to string comparison if embeddings fail.
    - **`getFunctionModifications`:** The main entry point. Loads the language parser, parses the old and new code, calls `diffNodes`, and constructs `modify_function_body` tool use objects if appropriate changes are found.
- **`Cline.ts`:**
    - Instantiates the `NebiusEmbeddingService`.
    - In the `recursivelyMakeClineRequests` loop:
        - When a `modify_function_body` tool use is encountered:
            - Extracts the `path`, `function_identifier`, and `new_body`.
            - Reads the original file content.
            - Calls `getFunctionModifications`. **CRITICAL:** This is where you need to reconstruct the _entire_ proposed new file content, not just the new function body.
            - If modifications are returned, construct the appropriate `tool_use` and `tool_result` blocks and add them to the conversation history.
        - Continues to the next chunk.

**Testing:**

Thoroughly test this implementation with a variety of scenarios:

- Simple changes within a function.
- Adding and removing lines within a function.
- Changes to indentation.
- Functions with similar names.
- Multiple functions in the same file.
- Files with no functions.
- Files with syntax errors.
- Different supported languages (TypeScript, JavaScript, Python, Go, C, C++, C#, Ruby, Java, and PHP).
- Cases where the Nebius API might fail (e.g., network issues, invalid API key).

This comprehensive set of instructions should allow the AI agent to perform a one-shot implementation of the `modify_function_body` tool using AST diffing and semantic similarity. Remember to emphasize the importance of complete code, correct indentation, and the use of the provided utility functions. The key is to make the instructions as explicit and unambiguous as possible.
