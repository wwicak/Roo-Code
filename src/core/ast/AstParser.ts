import Parser from "web-tree-sitter"
import { loadRequiredLanguageParsers } from "../../services/tree-sitter/languageParser"
import { logger } from "../../utils/logging"

export class AstParser {
	private parser: Parser
	private language: string

	constructor(language: string) {
		this.language = language
		this.parser = new Parser()
		this.initializeParser().catch((err) => {
			logger.error(`Failed to initialize parser for ${language}:`, err)
			throw new Error(`Parser initialization failed for ${language}`)
		})
	}

	private async initializeParser(): Promise<void> {
		const parsers = await loadRequiredLanguageParsers([this.language])
		const langParser = parsers[this.language]
		if (!langParser) {
			throw new Error(`No parser available for language: ${this.language}`)
		}
		const parserLanguage = langParser.parser.getLanguage()
		this.parser.setLanguage(parserLanguage)
	}

	parse(code: string): Parser.Tree {
		try {
			return this.parser.parse(code)
		} catch (error) {
			logger.error(`Error parsing code for ${this.language}:`, error)
			throw new Error(`Failed to parse code: ${error.message}`)
		}
	}

	getLanguage(): string {
		return this.language
	}
}
