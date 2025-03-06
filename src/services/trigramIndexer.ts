import * as vscode from "vscode"
import { logger } from "../utils/logging"

export interface FileEntry {
	uri: vscode.Uri
	relativePath: string
}

export interface Candidate {
	fileEntry: FileEntry
	score: number
}

export type Trigram = string
export type TrigramIndex = Map<Trigram, Set<string>>

export class TrigramIndexer {
	private index: TrigramIndex = new Map()
	private isIndexing: boolean = false

	constructor() {
		vscode.workspace.onDidChangeTextDocument(this.updateIndexForFile.bind(this))
	}

	async buildIndexInBackground(): Promise<void> {
		if (this.isIndexing) return
		this.isIndexing = true
		this.index.clear()

		const files = await this.getRelevantFiles()
		await Promise.all(files.map((file) => this.indexFile(file)))
		this.isIndexing = false
		logger.info(`[TrigramIndexer] Index built with ${this.index.size} trigrams across ${files.length} files.`)
	}

	private async indexFile(file: FileEntry): Promise<void> {
		try {
			const content = await vscode.workspace.fs.readFile(file.uri)
			const text = new TextDecoder().decode(content)
			const trigrams = this.generateTrigrams(text)
			for (const trigram of trigrams) {
				if (!this.index.has(trigram)) this.index.set(trigram, new Set())
				this.index.get(trigram)!.add(file.relativePath)
			}
		} catch (error) {
			logger.error(`Error indexing ${file.relativePath}:`, error)
		}
	}

	private async updateIndexForFile(event: vscode.TextDocumentChangeEvent): Promise<void> {
		const uri = event.document.uri
		if (!this.isRelevantFile(uri)) return
		const relativePath = vscode.workspace.asRelativePath(uri)
		this.removeFileFromIndex(relativePath)
		const content = event.document.getText()
		const trigrams = this.generateTrigrams(content)
		for (const trigram of trigrams) {
			if (!this.index.has(trigram)) this.index.set(trigram, new Set())
			this.index.get(trigram)!.add(relativePath)
		}
	}

	private removeFileFromIndex(filePath: string): void {
		for (const paths of this.index.values()) {
			paths.delete(filePath)
		}
	}

	private generateTrigrams(str: string): Set<string> {
		const trigrams = new Set<string>()
		const normalized = str.toLowerCase()
		if (normalized.length < 3) return trigrams
		for (let i = 0; i < normalized.length - 2; i++) {
			trigrams.add(normalized.substring(i, i + 3))
		}
		return trigrams
	}

	queryIndex(trigrams: string[]): Candidate[] {
		const fileScores: Map<string, number> = new Map()
		for (const trigram of trigrams) {
			if (this.index.has(trigram)) {
				for (const file of this.index.get(trigram)!) {
					fileScores.set(file, (fileScores.get(file) || 0) + 1)
				}
			}
		}
		const candidates: Candidate[] = Array.from(fileScores.entries()).map(([filePath, score]) => ({
			fileEntry: { uri: vscode.Uri.file(filePath), relativePath: filePath },
			score,
		}))
		candidates.sort((a, b) => b.score - a.score || a.fileEntry.relativePath.localeCompare(b.fileEntry.relativePath))
		return candidates
	}

	private async getRelevantFiles(): Promise<FileEntry[]> {
		const files: FileEntry[] = []
		if (!vscode.workspace.workspaceFolders) return files
		for (const folder of vscode.workspace.workspaceFolders) {
			const workspaceFiles = await vscode.workspace.findFiles(
				new vscode.RelativePattern(folder, "**/*.{ts,js,py,tsx,jsx}"),
				"**/node_modules/**",
			)
			files.push(
				...workspaceFiles.map((uri) => ({
					uri,
					relativePath: vscode.workspace.asRelativePath(uri),
				})),
			)
		}
		return files
	}

	private isRelevantFile(uri: vscode.Uri): boolean {
		const ext = uri.fsPath.split(".").pop()?.toLowerCase()
		return ["ts", "js", "py", "tsx", "jsx"].includes(ext || "")
	}

	clearIndex(): void {
		this.index.clear()
		this.isIndexing = false
		logger.info("[TrigramIndexer] Index cleared.")
	}
}
