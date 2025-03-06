import Parser from "web-tree-sitter"
import * as path from "path"
import * as fs from "fs/promises"
import { loadRequiredLanguageParsers } from "../../../services/tree-sitter/languageParser"
import { NebiusEmbeddingService } from "../../../services/embedding/NebiusEmbeddingService"
import { ToolUse, ApplyAstDiffToolUse } from "../../assistant-message"
import { AstProvider } from "../../ast/AstService"
import { AstErrorHandler, AstErrorCode } from "../../ast/AstErrorHandler"
import { SemanticValidator } from "../../ast/SemanticValidator"
import { logger } from "../../../utils/logging"

/**
 * Enhanced version of the AST diff implementation that leverages the AST services
 */

// Define the Change interface for diffing
interface Change {
	type: "added" | "removed" | "modified"
	oldNode?: Parser.SyntaxNode
	newNode?: Parser.SyntaxNode
}

/**
 * Get a unique identifier for an AST node
 */
export function getNodeIdentifier(node: Parser.SyntaxNode): string {
	const nameNode =
		node.childForFieldName("name") ?? node.childForFieldName("id") ?? node.childForFieldName("identifier")

	if (!nameNode) {
		return `unknown-${node.startPosition.row}`
	}

	// For class methods, include the class name
	if (
		node.type === "method_definition" ||
		node.type === "class_method" ||
		node.type === "method" ||
		node.type.includes("method")
	) {
		// Try to find parent class/interface
		let parent = node.parent
		while (parent) {
			if (
				parent.type === "class_declaration" ||
				parent.type === "class" ||
				parent.type === "class_definition" ||
				parent.type === "interface_declaration"
			) {
				const classNameNode = parent.childForFieldName("name") ?? parent.childForFieldName("id")
				if (classNameNode) {
					return `${classNameNode.text}.${nameNode.text}:${node.startPosition.row + 1}`
				}
				break
			}
			parent = parent.parent
		}
	}

	const name = nameNode.text
	return `${name}:${node.startPosition.row + 1}` // +1 for 1-indexed line numbers
}

/**
 * Extract the body text from a node
 */
export async function getNodeBody(node: Parser.SyntaxNode): Promise<string> {
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

/**
 * Recursively diff two AST trees
 */
async function diffNodes(
	oldNode: Parser.SyntaxNode | undefined,
	newNode: Parser.SyntaxNode | undefined,
	changes: Change[],
	embeddingService: NebiusEmbeddingService,
	filePath: string,
): Promise<void> {
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

	// Check if nodes are different
	if (oldNode.type !== newNode.type) {
		changes.push({ type: "modified", oldNode, newNode })
		return
	}

	// Same node type, check if function body changed
	const supportedTypes = [
		"function_definition",
		"function_declaration",
		"method_definition",
		"class_method",
		"method",
		"arrow_function",
	]

	if (supportedTypes.includes(oldNode.type)) {
		// Get node identifiers
		const oldId = getNodeIdentifier(oldNode)
		const newId = getNodeIdentifier(newNode)

		// If identifiers match but body differs, it's a body modification
		if (oldId === newId) {
			const oldBody = await getNodeBody(oldNode)
			const newBody = await getNodeBody(newNode)

			if (oldBody !== newBody) {
				changes.push({ type: "modified", oldNode, newNode })
				return
			}
		}
	}

	// Compare children
	const oldChildren = oldNode.children
	const newChildren = newNode.children

	// For large trees, we only process a limited number of nodes to avoid performance issues
	const maxLength = Math.min(Math.max(oldChildren.length, newChildren.length), 100)
	for (let i = 0; i < maxLength; i++) {
		await diffNodes(oldChildren[i], newChildren[i], changes, embeddingService, filePath)
	}
}

/**
 * Validate a function modification using the SemanticValidator
 */
async function validateFunctionModification(
	oldNode: Parser.SyntaxNode,
	newNode: Parser.SyntaxNode,
	embeddingService: NebiusEmbeddingService,
	filePath: string,
): Promise<boolean> {
	try {
		// Create a validator instance
		const validator = new SemanticValidator(embeddingService as any)

		// Get node bodies
		const oldBody = await getNodeBody(oldNode)
		const newBody = await getNodeBody(newNode)

		// Validate the change
		const result = await validator.validateChange(oldBody, newBody, {
			semanticThreshold: 0.82, // Adjusted threshold based on research
			validateImports: false,
			skipTypes: ["comment", "string", "number", "boolean"],
		})

		if (!result.isValid) {
			logger.debug(
				`Validation failed for ${getNodeIdentifier(oldNode)}: ${result.error} ` +
					`(semantic score: ${result.semanticScore?.toFixed(4)}, structural score: ${result.structuralScore?.toFixed(4)})`,
			)
			return false
		}

		logger.debug(
			`Validation passed for ${getNodeIdentifier(oldNode)} ` +
				`(semantic score: ${result.semanticScore?.toFixed(4)}, structural score: ${result.structuralScore?.toFixed(4)})`,
		)
		return true
	} catch (error) {
		logger.error(`Error validating function modification for ${getNodeIdentifier(oldNode)}:`, error)
		return false
	}
}

/**
 * Main function to get function modifications from code changes
 */
export async function getFunctionModifications(
	oldCode: string,
	newCode: string,
	filePath: string,
	embeddingService: NebiusEmbeddingService,
): Promise<ApplyAstDiffToolUse[] | null> {
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
		const modifications: ApplyAstDiffToolUse[] = []

		// Track rejected modifications for diagnostics
		const rejectedModifications: Array<{
			node: string
			reason: string
		}> = []

		// Process each change
		for (const change of changes) {
			if (change.type === "modified" && change.oldNode && change.newNode) {
				const supportedTypes = [
					"function_definition",
					"function_declaration",
					"method_definition",
					"class_method",
					"method",
					"arrow_function",
				]

				if (supportedTypes.includes(change.oldNode.type) && supportedTypes.includes(change.newNode.type)) {
					// Validate the change
					const isValid = await validateFunctionModification(
						change.oldNode,
						change.newNode,
						embeddingService,
						filePath,
					)

					if (isValid) {
						modifications.push({
							type: "tool_use",
							name: "apply_ast_diff",
							params: {
								path: filePath,
								diff: await getNodeBody(change.newNode),
							},
							partial: false,
						} as ApplyAstDiffToolUse)
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
			return null // No valid modifications found
		}

		return modifications
	} catch (error) {
		if (AstErrorHandler.isAstError(error)) {
			// This is already an AstError
			throw error
		}

		// Convert generic error to AstError
		throw AstErrorHandler.createError(
			AstErrorCode.GENERAL_ERROR,
			`Error in AST diff: ${error instanceof Error ? error.message : String(error)}`,
			{
				filepath: filePath,
				details: {
					stack: error instanceof Error ? error.stack : undefined,
					original: error,
				},
			},
		)
	}
}

/**
 * Function to reconstruct file content with a modified function body
 */
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
		const startPos = bodyNode.startPosition
		const endPos = bodyNode.endPosition

		const contentLines = originalContent.split("\n")

		// Extract content before the body
		const beforeBody =
			contentLines.slice(0, startPos.row).join("\n") +
			(startPos.row > 0 ? "\n" : "") +
			contentLines[startPos.row].substring(0, startPos.column)

		// Extract content after the body
		const afterBody =
			contentLines[endPos.row].substring(endPos.column) +
			(endPos.row < contentLines.length - 1 ? "\n" : "") +
			contentLines.slice(endPos.row + 1).join("\n")

		// Combine with new body
		return beforeBody + newBody + afterBody
	} catch (error) {
		if (AstErrorHandler.isAstError(error)) {
			// Rethrow AstError
			throw error
		}

		// Convert generic error to AstError
		throw AstErrorHandler.createError(
			AstErrorCode.GENERAL_ERROR,
			`Error reconstructing content: ${error instanceof Error ? error.message : String(error)}`,
			{
				filepath: filePath,
				details: {
					functionIdentifier,
					stack: error instanceof Error ? error.stack : undefined,
				},
			},
		)
	}
}
