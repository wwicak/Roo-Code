import Parser from "web-tree-sitter"
import { loadRequiredLanguageParsers } from "../../../../services/tree-sitter/languageParser"
import { ToolUse, ModifyFunctionBodyToolUse } from "../../../assistant-message"
import * as path from "path"
import { cosineSimilarity } from "../../../../utils/cosineSimilarity"
import { NebiusEmbeddingService } from "../../../../services/embedding/NebiusEmbeddingService"
import fs from "fs/promises"

interface Change {
	type: "added" | "removed" | "modified"
	oldNode?: Parser.SyntaxNode
	newNode?: Parser.SyntaxNode
}

function getNodeIdentifier(node: Parser.SyntaxNode): string {
	const nameNode =
		node.childForFieldName("name") ?? node.childForFieldName("id") ?? node.childForFieldName("identifier")

	if (!nameNode) {
		return `unknown-${node.startPosition.row}` // Fallback
	}
	const name = nameNode.text
	return `${name}:${node.startPosition.row + 1}` // +1 because VS Code is 1-based
}

async function getNodeBody(node: Parser.SyntaxNode): Promise<string> {
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

	const oldChildren = oldNode.children
	const newChildren = newNode.children

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
	if (oldNode.type !== newNode.type) {
		return false
	}

	if (
		oldNode.type !== "function_definition" &&
		oldNode.type !== "function_declaration" &&
		oldNode.type !== "method_definition"
	) {
		return false
	}

	if (getNodeIdentifier(oldNode) !== getNodeIdentifier(newNode)) {
		return false
	}

	const oldBody = await getNodeBody(oldNode)
	const newBody = await getNodeBody(newNode)

	const oldEmbedding = await embeddingService.embedText(oldBody)
	const newEmbedding = await embeddingService.embedText(newBody)

	if (!oldEmbedding || !newEmbedding) {
		return oldBody === newBody // Fallback to textual comparison
	}

	const similarity = cosineSimilarity(oldEmbedding, newEmbedding)
	return similarity > 0.95 // Threshold for semantic similarity
}

export async function getFunctionModifications(
	oldCode: string,
	newCode: string,
	filePath: string,
	embeddingService: NebiusEmbeddingService,
): Promise<ModifyFunctionBodyToolUse[] | null> {
	const ext = path.extname(filePath).slice(1) // ".ts" -> "ts"

	const languageParsers = await loadRequiredLanguageParsers([filePath])

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
			const nodeTypes = ["function_definition", "function_declaration", "method_definition"]
			if (
				nodeTypes.includes(change.oldNode.type) &&
				nodeTypes.includes(change.newNode.type) &&
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
