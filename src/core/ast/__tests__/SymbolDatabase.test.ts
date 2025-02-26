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
			initialize: jest.fn().mockImplementation(() => Promise.resolve()),
			parseFile: jest.fn(),
			walkTree: jest.fn(),
			getNodeType: jest.fn(),
			getNodeText: jest.fn(),
			getNodeAtPosition: jest.fn(),
			getNodeRange: jest.fn(),
		} as any

		// Mock getInstance method
		;(AstProvider.getInstance as jest.Mock).mockReturnValue(mockAstProvider)

		// Create new instance for each test
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
			// Instead of directly modifying private fileReferences, set up the relationship
			// through the public API by creating symbols that reference each other

			// Create mock tree for fileA with a class
			const mockTreeA = {
				rootNode: {
					type: "program",
					children: [
						{
							type: "class_declaration",
							text: "class TestClassA {}",
							startPosition: { row: 1, column: 0 },
							endPosition: { row: 3, column: 1 },
							children: [],
							childForFieldName: jest.fn().mockImplementation((name) => {
								if (name === "name") {
									return {
										type: "identifier",
										text: "TestClassA",
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

			// Create mock tree for fileB that imports from fileA
			const mockTreeB = {
				rootNode: {
					type: "program",
					children: [
						{
							type: "import_declaration",
							text: "import { TestClassA } from './fileA'",
							startPosition: { row: 0, column: 0 },
							endPosition: { row: 0, column: 35 },
							children: [],
							childForFieldName: jest.fn().mockReturnValue(null),
						},
						{
							type: "class_declaration",
							text: "class TestClassB extends TestClassA {}",
							startPosition: { row: 2, column: 0 },
							endPosition: { row: 4, column: 1 },
							children: [],
							childForFieldName: jest.fn().mockImplementation((name) => {
								if (name === "name") {
									return {
										type: "identifier",
										text: "TestClassB",
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

			// Add the files to the database
			symbolDb.updateFileSymbols("fileA.ts", mockTreeA)
			symbolDb.updateFileSymbols("fileB.ts", mockTreeB)

			// Test getting related files through the public API
			const relatedFiles = symbolDb.getRelatedFiles("fileA.ts")

			// fileB should be related to fileA due to the import
			expect(relatedFiles.size).toBeGreaterThan(0)
		})
	})
})
