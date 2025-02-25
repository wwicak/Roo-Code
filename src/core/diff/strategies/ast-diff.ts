import Parser from "web-tree-sitter"
import { loadRequiredLanguageParsers } from "../../../services/tree-sitter/languageParser"
import { ToolUse, ModifyFunctionBodyToolUse } from "../../assistant-message"
import { fileExistsAtPath } from "../../../utils/fs"
import * as path from "path"
import { cosineSimilarity } from "../../../utils/cosineSimilarity"
import { NebiusEmbeddingService } from "../../../services/embedding/NebiusEmbeddingService"

interface Change {
	type: "added" | "removed" | "modified"
	oldNode?: Parser.SyntaxNode
	newNode?: Parser.SyntaxNode
}

// Generates function identifier from function name and line number
function getNodeIdentifier(node: Parser.SyntaxNode): string {
	const nameNode = node.childForFieldName("name") // Get the 'name' node. How you access this depends on the *grammar*

	if (!nameNode) {
		return `unknown-${node.startPosition.row}` // Should not reach here
	}
	const name = nameNode.text
	return `${name}:${node.startPosition.row + 1}` // +1 because VS Code is 1-based
}

async function getNodeBody(node: Parser.SyntaxNode): Promise<string> {
	const bodyNode = node.childForFieldName("body")
	if (!bodyNode) {
		return ""
	}
	return bodyNode.text
}

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

	// Simple implementation for example, would need to use an algorithm like in findBestMatch
	const maxLength = Math.max(oldChildren.length, newChildren.length)
	for (let i = 0; i < maxLength; i++) {
		diffNodes(oldChildren[i], newChildren[i], changes, embeddingService, filePath)
	}
}

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

	if (oldNode.type !== "function_declaration") {
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
	await diffNodes(oldTree.rootNode, newTree.rootNode, changes, embeddingService, filePath)

	const modifications: ModifyFunctionBodyToolUse[] = []

	for (const change of changes) {
		if (change.type === "modified" && change.oldNode && change.newNode) {
			if (
				change.oldNode.type === "function_declaration" &&
				change.newNode.type === "function_declaration" &&
				(await areNodesEquivalent(change.oldNode, change.newNode, embeddingService, filePath))
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
