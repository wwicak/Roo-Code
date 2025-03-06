import { TrigramIndexer, Candidate } from "../services/trigramIndexer"
import * as vscode from "vscode"
import { logger } from "../utils/logging"

export class ContextProvider {
	private indexer: TrigramIndexer

	constructor() {
		this.indexer = new TrigramIndexer()
		this.initializeIndex()
	}

	private async initializeIndex(): Promise<void> {
		try {
			await this.indexer.buildIndexInBackground()
		} catch (error) {
			logger.error("Failed to initialize trigram index:", error)
		}
	}

	async getContext(query: string): Promise<string> {
		const trigrams = this.generateTrigrams(query)
		const candidates = this.indexer.queryIndex(Array.from(trigrams))
		const topCandidates = candidates.slice(0, 5) // Top 5 relevant files

		let context = ""
		for (const candidate of topCandidates) {
			try {
				const content = await vscode.workspace.fs.readFile(candidate.fileEntry.uri)
				context += `\nFile: ${candidate.fileEntry.relativePath}\n${new TextDecoder().decode(content)}\n`
			} catch (error) {
				logger.error(`Error reading file ${candidate.fileEntry.relativePath}:`, error)
			}
		}
		return context
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
}
