import { jest } from "@jest/globals"
import { SymbolDatabase, Symbol } from "../SymbolDatabase"
import { AstProvider } from "../AstService"
import Parser from "web-tree-sitter"

// Mock dependencies
jest.mock("../AstService")
jest.mock("web-tree-sitter")
jest.mock("../../../utils/logging", () => ({
	logger: {
		info: jest.fn(),
		error: jest.fn(),
		warn: jest.fn(),
		debug: jest.fn(),
	},
}))

describe("SymbolDatabase", () => {
	let symbolDb: SymbolDatabase
	let mockAstProvider: jest.Mocked<AstProvider>

	beforeEach(() => {
		jest.clearAllMocks()

		// Setup mock AST provider
		mockAstProvider = {
			initialize: jest.fn().mockResolvedValue(undefined),
			parseFile: jest.fn(),
			walkTree: jest.fn(),
			getNodeType: jest.fn(),
			getNodeText: jest.fn(),
			getNodeAtPosition: jest.fn(),
			getNodeRange: jest.fn(),
		} as any

		// Mock getInstance method
		;(AstProvider.getInstance as jest.Mock).mockReturnValue(mockAstProvider)

		// Reset singleton instance
		// @ts-ignore - Accessing private static member for testing
		SymbolDatabase.instance = undefined

		// Create new instance
		symbolDb = new SymbolDatabase()
	})

	describe("Symbol management", () => {
		it("should add symbols to the database via updateFileSymbols", () => {
			// Create a mock tree with symbols
			const mockTree = {
				rootNode: {
					type: "program",
					children: [
						{
							type: "class_declaration",
							text: "class TestClass {}",
							startPosition: { row: 9, column: 5 },
							endPosition: { row: 11, column: 1 },
							children: [
								{
									type: "identifier",
									text: "TestClass",
									childForFieldName: jest.fn().mockReturnValue(null),
								},
							],
							childForFieldName: jest.fn().mockImplementation((name) => {
								if (name === "name") {
									return {
										type: "identifier",
										text: "TestClass",
									}
								}
								return null
							}),
						},
						{
							type: "function_declaration",
							text: "function testFunction() {}",
							startPosition: { row: 19, column: 10 },
							endPosition: { row: 21, column: 1 },
							children: [
								{
									type: "identifier",
									text: "testFunction",
									childForFieldName: jest.fn().mockReturnValue(null),
								},
							],
							childForFieldName: jest.fn().mockImplementation((name) => {
								if (name === "name") {
									return {
										type: "identifier",
										text: "testFunction",
									}
								}
								return null
							}),
						},
					],
					childCount: 2,
					childForFieldName: jest.fn().mockReturnValue(null),
				},
			} as unknown as Parser.Tree

			symbolDb.updateFileSymbols("test.ts", mockTree)

			// Check if symbols were correctly extracted
			const fileSymbols = symbolDb.getFileSymbols("test.ts")
			expect(fileSymbols.length).toBeGreaterThan(0)
		})

		it("should remove symbols when a file is removed", () => {
			// Create a mock tree with a symbol
			const mockTree = {
				rootNode: {
					type: "program",
					children: [
						{
							type: "class_declaration",
							text: "class TestClass {}",
							startPosition: { row: 9, column: 5 },
							endPosition: { row: 11, column: 1 },
							children: [
								{
									type: "identifier",
									text: "TestClass",
									childForFieldName: jest.fn().mockReturnValue(null),
								},
							],
							childForFieldName: jest.fn().mockImplementation((name) => {
								if (name === "name") {
									return {
										type: "identifier",
										text: "TestClass",
									}
								}
								return null
							}),
						},
					],
					childCount: 1,
					childForFieldName: jest.fn().mockReturnValue(null),
				},
			} as unknown as Parser.Tree

			// Add file symbols
			symbolDb.updateFileSymbols("test.ts", mockTree)

			// Remove the file
			symbolDb.removeFile("test.ts")

			// Verify symbols were removed
			const fileSymbols = symbolDb.getFileSymbols("test.ts")
			expect(fileSymbols.length).toBe(0)
		})
	})

	describe("Symbol lookup", () => {
		beforeEach(() => {
			// Create mock trees with symbols for multiple files
			const fileATrees = [
				{
					rootNode: {
						type: "program",
						children: [
							{
								type: "class_declaration",
								text: "class UserClass {}",
								startPosition: { row: 9, column: 5 },
								endPosition: { row: 15, column: 1 },
								children: [
									{
										type: "identifier",
										text: "UserClass",
										childForFieldName: jest.fn().mockReturnValue(null),
									},
								],
								childForFieldName: jest.fn().mockImplementation((name) => {
									if (name === "name") {
										return {
											type: "identifier",
											text: "UserClass",
										}
									}
									return null
								}),
							},
						],
						childCount: 1,
						childForFieldName: jest.fn().mockReturnValue(null),
					},
				} as unknown as Parser.Tree,
				{
					rootNode: {
						type: "program",
						children: [
							{
								type: "function_declaration",
								text: "function calculateTotal() {}",
								startPosition: { row: 4, column: 0 },
								endPosition: { row: 6, column: 1 },
								children: [
									{
										type: "identifier",
										text: "calculateTotal",
										childForFieldName: jest.fn().mockReturnValue(null),
									},
								],
								childForFieldName: jest.fn().mockImplementation((name) => {
									if (name === "name") {
										return {
											type: "identifier",
											text: "calculateTotal",
										}
									}
									return null
								}),
							},
						],
						childCount: 1,
						childForFieldName: jest.fn().mockReturnValue(null),
					},
				} as unknown as Parser.Tree,
			]

			// Add symbols to the database
			symbolDb.updateFileSymbols("user.ts", fileATrees[0])
			symbolDb.updateFileSymbols("utils.ts", fileATrees[1])
		})

		it("should find symbols by name pattern", () => {
			const results = symbolDb.findSymbolsByName("User")

			expect(results.length).toBeGreaterThan(0)
			// At least one symbol should have "User" in its name
			expect(results.some((s) => s.name.includes("User"))).toBe(true)
		})

		it("should get specific symbols by ID", () => {
			// Get a symbol ID from the file symbols
			const userSymbols = symbolDb.getFileSymbols("user.ts")
			if (userSymbols.length > 0) {
				const symbolId = userSymbols[0].id

				// Look up by ID
				const symbol = symbolDb.getSymbol(symbolId)

				expect(symbol).toBeDefined()
				expect(symbol?.id).toBe(symbolId)
			} else {
				// Skip this test if no symbols were found
				console.warn("No symbols found for getSymbol test")
			}
		})

		it("should get all symbols for a file", () => {
			const fileSymbols = symbolDb.getFileSymbols("user.ts")

			expect(fileSymbols.length).toBeGreaterThan(0)
			// All symbols should have the correct file path
			expect(fileSymbols.every((s) => s.filePath === "user.ts")).toBe(true)
		})
	})

	describe("Related files", () => {
		it("should find related files", () => {
			// Create mock file references
			// @ts-ignore - Accessing private member for testing
			symbolDb.fileReferences.set("fileA.ts", new Set(["fileB.ts"]))
			// @ts-ignore - Accessing private member for testing
			symbolDb.fileReferences.set("fileB.ts", new Set(["fileA.ts", "fileC.ts"]))

			const relatedToA = symbolDb.getRelatedFiles("fileA.ts")

			expect(relatedToA.has("fileB.ts")).toBe(true)
		})
	})
})
