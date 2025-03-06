import Parser from "web-tree-sitter"
import { loadRequiredLanguageParsers } from "../../../services/tree-sitter/languageParser"
import { DiffStrategy, DiffResult } from "../types"
import { logger } from "../../../utils/logging"
import { NebiusEmbeddingService } from "../../../services/embedding/NebiusEmbeddingService"
import * as path from "path"

interface Change {
	type: "added" | "removed" | "modified"
	oldNode?: Parser.SyntaxNode
	newNode?: Parser.SyntaxNode
}

export class AstDiffStrategy implements DiffStrategy {
	private embeddingService: NebiusEmbeddingService

	constructor(embeddingService: NebiusEmbeddingService) {
		this.embeddingService = embeddingService
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
</apply_ast_diff>`
	}

	async applyDiff(
		originalContent: string,
		diffContent: string,
		startLine?: number,
		endLine?: number,
	): Promise<DiffResult> {
		const filePath = "temp.ts" // Placeholder; actual path provided in usage
		const ext = path.extname(filePath).slice(1)

		try {
			const languageParsers = await loadRequiredLanguageParsers([filePath])
			const parser = languageParsers[ext]?.parser
			if (!parser) {
				return { success: false, error: `No parser found for extension: ${ext}` }
			}

			const oldTree = parser.parse(originalContent)
			const newTree = parser.parse(diffContent)

			const changes: Change[] = []
			await this.diffNodes(oldTree.rootNode, newTree.rootNode, changes, filePath)

			let modifiedContent = originalContent
			for (const change of changes) {
				if (change.type === "modified" && change.oldNode && change.newNode) {
					const newBody = await this.getNodeBody(change.newNode)
					modifiedContent = await this.reconstructContent(
						modifiedContent,
						this.getNodeIdentifier(change.oldNode),
						newBody,
						filePath,
					)
				}
			}

			return { success: true, content: modifiedContent }
		} catch (error) {
			logger.error("Error applying AST diff:", error)
			return { success: false, error: `AST diff failed: ${error.message}` }
		}
	}

	private async diffNodes(
		oldNode: Parser.SyntaxNode | undefined,
		newNode: Parser.SyntaxNode | undefined,
		changes: Change[],
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

		if (oldNode.type !== newNode.type) {
			changes.push({ type: "modified", oldNode, newNode })
			return
		}

		const supportedTypes = ["function_definition", "function_declaration", "method"]
		if (supportedTypes.includes(oldNode.type)) {
			const oldBody = await this.getNodeBody(oldNode)
			const newBody = await this.getNodeBody(newNode)
			if (oldBody !== newBody) {
				changes.push({ type: "modified", oldNode, newNode })
				return
			}
		}

		const oldChildren = oldNode.children
		const newChildren = newNode.children
		const maxLength = Math.max(oldChildren.length, newChildren.length)
		for (let i = 0; i < maxLength; i++) {
			await this.diffNodes(oldChildren[i], newChildren[i], changes, filePath)
		}
	}

	private getNodeIdentifier(node: Parser.SyntaxNode): string {
		const nameNode = node.childForFieldName("name") || node.namedChildren[0]
		const name = nameNode ? nameNode.text : `unknown-${node.startPosition.row}`
		return `${name}:${node.startPosition.row + 1}`
	}

	private async getNodeBody(node: Parser.SyntaxNode): Promise<string> {
		const bodyNode = node.childForFieldName("body") || node.namedChildren.find((n) => n.type.includes("block"))
		return bodyNode ? bodyNode.text : ""
	}

	private async reconstructContent(
		originalContent: string,
		functionIdentifier: string,
		newBody: string,
		filePath: string,
	): Promise<string> {
		const ext = path.extname(filePath).slice(1)
		const languageParsers = await loadRequiredLanguageParsers([filePath])
		const parser = languageParsers[ext]?.parser
		if (!parser) throw new Error(`No parser for ${ext}`)

		const tree = parser.parse(originalContent)
		const node = tree.rootNode
			.descendantsOfType(["function_definition", "function_declaration", "method"])
			.find((n) => this.getNodeIdentifier(n) === functionIdentifier)

		if (!node) throw new Error(`Function ${functionIdentifier} not found`)

		const bodyNode = node.childForFieldName("body")
		if (!bodyNode) throw new Error(`Body not found for ${functionIdentifier}`)

		const start = bodyNode.startPosition
		const end = bodyNode.endPosition
		const lines = originalContent.split("\n")
		const before = lines.slice(0, start.row).join("\n") + lines[start.row].substring(0, start.column)
		const after = lines[end.row].substring(end.column) + "\n" + lines.slice(end.row + 1).join("\n")
		return `${before}${newBody}${after}`
	}
}
