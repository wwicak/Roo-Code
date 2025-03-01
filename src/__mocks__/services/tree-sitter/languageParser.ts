import Parser from "web-tree-sitter"

let mockParsers: {
	[key: string]: {
		parser: Parser
		query: Parser.Query
	}
} | null = null

export function __setMockLanguageParsers(parsers: {
	[key: string]: {
		parser: Parser
		query: Parser.Query
	}
}) {
	mockParsers = parsers
}

export async function loadRequiredLanguageParsers() {
	if (!mockParsers) {
		throw new Error("Mock parsers not set")
	}
	return mockParsers
}
