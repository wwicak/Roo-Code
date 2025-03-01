import { AstProvider } from "../AstService"
import * as path from "path"

// Mock dependencies
jest.mock("web-tree-sitter")
jest.mock("../../../services/tree-sitter/languageParser")
jest.mock("../../../utils/logging")
jest.mock("fs/promises")

// Mock symbols and cache managers
jest.mock("../SymbolDatabase")
jest.mock("../AstCacheManager")

describe("AstProvider", () => {
	let provider: AstProvider

	beforeEach(() => {
		jest.clearAllMocks()

		// Setup mock for web-tree-sitter
		const mockTree = {
			rootNode: {
				type: "program",
				text: "function test() { return true; }",
				startPosition: { row: 0, column: 0 },
				endPosition: { row: 0, column: 31 },
				children: [
					{
						type: "function_declaration",
						text: "function test() { return true; }",
						startPosition: { row: 0, column: 0 },
						endPosition: { row: 0, column: 31 },
						children: [
							{
								type: "identifier",
								text: "test",
								startPosition: { row: 0, column: 9 },
								endPosition: { row: 0, column: 13 },
								children: [],
							},
							{
								type: "parameters",
								text: "()",
								startPosition: { row: 0, column: 13 },
								endPosition: { row: 0, column: 15 },
								children: [],
							},
							{
								type: "body",
								text: "{ return true; }",
								startPosition: { row: 0, column: 16 },
								endPosition: { row: 0, column: 31 },
								children: [],
							},
						],
						childForFieldName: (name: string) => {
							if (name === "name" || name === "id" || name === "identifier") {
								return {
									type: "identifier",
									text: "test",
									startPosition: { row: 0, column: 9 },
									endPosition: { row: 0, column: 13 },
									children: [],
								}
							}
							if (name === "body" || name === "block") {
								return {
									type: "body",
									text: "{ return true; }",
									startPosition: { row: 0, column: 16 },
									endPosition: { row: 0, column: 31 },
									children: [],
								}
							}
							return null
						},
					},
				],
			},
		}

		// Setup mock for loadRequiredLanguageParsers
		const mockLanguageParser = {
			js: {
				parser: {
					parse: jest.fn().mockReturnValue(mockTree),
				},
				query: {}, // Added the missing query property
			},
		}

		const mockFS = {
			readFile: jest.fn().mockResolvedValue("function test() { return true; }"),
		}

		// Apply the mocks
		require("../../../services/tree-sitter/languageParser").__setMockLanguageParsers(mockLanguageParser)
		require("fs/promises").__setMockFS(mockFS)
		require("web-tree-sitter").__setMockTree(mockTree)

		// Get the provider instance
		provider = AstProvider.getInstance()
	})

	test("should initialize the provider", async () => {
		await provider.initialize()
		expect(require("web-tree-sitter").init).toHaveBeenCalled()
	})

	test("should parse a file", async () => {
		await provider.initialize()
		const tree = await provider.parseFile("test.js")
		expect(tree).not.toBeNull()
	})

	test("should find a node by identifier", async () => {
		await provider.initialize()
		const node = await provider.getNodeWithIdentifier("test.js", "test:1")
		expect(node).not.toBeNull()
	})

	test("should handle non-existent identifiers", async () => {
		await provider.initialize()
		const node = await provider.getNodeWithIdentifier("test.js", "nonexistent:99")
		expect(node).toBeNull()
	})

	test("should serialize an AST node", async () => {
		await provider.initialize()
		const tree = await provider.parseFile("test.js")
		if (tree) {
			const serialized = provider.serializeAst(tree.rootNode)
			expect(serialized).toHaveProperty("type", "program")
			expect(serialized).toHaveProperty("text")
			expect(serialized).toHaveProperty("children")
		}
	})

	test("should invalidate cached data", async () => {
		await provider.initialize()
		provider.invalidateFile("test.js")
		const mockCacheManager = require("../AstCacheManager").AstCacheManager.mock.instances[0]
		expect(mockCacheManager.invalidateFile).toHaveBeenCalledWith("test.js")
	})
})
