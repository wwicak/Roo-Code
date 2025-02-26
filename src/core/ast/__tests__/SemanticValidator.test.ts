import { jest } from "@jest/globals"
import { SemanticValidator, ValidationOptions, ValidationResult } from "../SemanticValidator"
import { NebiusEmbeddingService } from "../../../services/embedding/NebiusEmbeddingService"
import { AstProvider } from "../AstService"
import Parser from "web-tree-sitter"
import { cosineSimilarity } from "../../../utils/cosineSimilarity"

// Mock dependencies
jest.mock("../../../services/embedding/NebiusEmbeddingService")
jest.mock("../AstService")
jest.mock("../../../utils/cosineSimilarity")
jest.mock("web-tree-sitter")
jest.mock("../../../utils/logging", () => ({
	logger: {
		info: jest.fn(),
		error: jest.fn(),
		warn: jest.fn(),
		debug: jest.fn(),
	},
}))

describe("SemanticValidator", () => {
	let validator: SemanticValidator
	let mockEmbeddingService: jest.Mocked<NebiusEmbeddingService>
	let mockAstProvider: jest.Mocked<AstProvider>

	beforeEach(() => {
		jest.clearAllMocks()

		// Setup mock embedding service
		mockEmbeddingService = {
			embedText: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
		} as any

		// Setup mock AST provider
		mockAstProvider = {
			serializeAst: jest.fn(),
			initialize: jest.fn().mockResolvedValue(undefined),
			parseFile: jest.fn(),
		} as any

		// Mock cosine similarity function
		;(cosineSimilarity as jest.Mock).mockReturnValue(0.9)

		// Setup mock for getInstance
		;(AstProvider.getInstance as jest.Mock).mockReturnValue(mockAstProvider)
		;(NebiusEmbeddingService as jest.Mock).mockImplementation(() => mockEmbeddingService)

		// Create validator instance
		validator = new SemanticValidator("test-api-key")
	})

	describe("Basic validation", () => {
		it("should validate a simple code change with default options", async () => {
			const original = "function add(a, b) { return a + b; }"
			const modified = "function add(a, b) { return a + b; // Added comment }"

			const result = await validator.validateChange(original, modified)

			expect(result.isValid).toBe(true)
			expect(result.semanticScore).toBeGreaterThan(0)
			expect(result.structuralScore).toBeGreaterThan(0)
		})

		it("should reject changes that fail semantic thresholds", async () => {
			// Mock low similarity score
			;(cosineSimilarity as jest.Mock).mockReturnValue(0.5)

			const original = "function add(a, b) { return a + b; }"
			const modified = "function subtract(a, b) { return a - b; }" // Completely different semantics

			const options: ValidationOptions = {
				semanticThreshold: 0.8, // Require high similarity
			}

			const result = await validator.validateChange(original, modified, options)

			expect(result.isValid).toBe(false)
			expect(result.error).toBeDefined()
			expect(result.semanticScore).toBeLessThan(options.semanticThreshold)
		})

		it("should skip semantic validation when instructed", async () => {
			const original = "function add(a, b) { return a + b; }"
			const modified = "function subtract(a, b) { return a - b; }" // Completely different semantics

			const options: ValidationOptions = {
				skipSemanticValidation: true,
			}

			const result = await validator.validateChange(original, modified, options)

			// Should pass since semantic validation is skipped
			expect(result.isValid).toBe(true)
			expect(mockEmbeddingService.embedText).not.toHaveBeenCalled()
		})
	})

	describe("Function body validation", () => {
		it("should validate a function body change", async () => {
			const original = "{ return a + b; }"
			const modified = "{ const sum = a + b; return sum; }"

			// Mock the AST parsing result for function body
			mockAstProvider.parseFile.mockResolvedValue({
				rootNode: {
					type: "source_file",
					children: [
						{
							type: "function_declaration",
							text: "function add(a, b) { return a + b; }",
							children: [
								{ type: "identifier", text: "add" },
								{ type: "parameter_list", text: "(a, b)" },
								{
									type: "body",
									text: original,
									children: [{ type: "return_statement", text: "return a + b;" }],
								},
							],
							childForFieldName: (name: string) => {
								if (name === "body") {
									return {
										type: "body",
										text: original,
									} as any
								}
								return null
							},
						},
					],
				},
			} as any)

			const result = await validator.validateFunctionBodyChange(original, modified)

			expect(result.isValid).toBe(true)
			expect(result.message).toContain("valid")
			expect(result.semanticScore).toBeGreaterThan(0)
		})

		it("should reject invalid function body changes", async () => {
			// Mock low similarity score for this test
			;(cosineSimilarity as jest.Mock).mockReturnValue(0.4)

			const original = "{ return a + b; }"
			const modified = "{ return Math.random(); }" // Completely different functionality

			const options: ValidationOptions = {
				semanticThreshold: 0.8,
			}

			const result = await validator.validateFunctionBodyChange(original, modified, options)

			expect(result.isValid).toBe(false)
			expect(result.message).toContain("failed")
		})
	})

	describe("Structural validation", () => {
		it("should perform structural validation on AST nodes", async () => {
			const original = "if (condition) { doSomething(); }"
			const modified = "if (condition) { doSomethingElse(); }"

			// Mock AST nodes for structural comparison
			const originalNode = {
				type: "if_statement",
				children: [
					{ type: "condition", text: "condition" },
					{ type: "block", text: "{ doSomething(); }" },
				],
			}

			const modifiedNode = {
				type: "if_statement",
				children: [
					{ type: "condition", text: "condition" },
					{ type: "block", text: "{ doSomethingElse(); }" },
				],
			}

			// Mock the parse function
			mockAstProvider.parseFile.mockImplementation((content: string) => {
				if (content === original) {
					return Promise.resolve({ rootNode: originalNode } as any)
				} else {
					return Promise.resolve({ rootNode: modifiedNode } as any)
				}
			})

			const result = await validator.validateChange(original, modified, {
				structuralThreshold: 0.7,
			})

			expect(result.isValid).toBe(true)
			expect(result.structuralScore).toBeGreaterThan(0)
		})

		it("should reject changes with significant structural differences", async () => {
			// Mock low structural similarity
			jest.spyOn(validator as any, "calculateStructuralSimilarity").mockReturnValue(0.4)

			const original = "if (condition) { doSomething(); }"
			const modified = "for (let i = 0; i < 10; i++) { doSomething(); }" // Different structure

			const result = await validator.validateChange(original, modified, {
				structuralThreshold: 0.7,
			})

			expect(result.isValid).toBe(false)
			expect(result.structuralScore).toBeLessThan(0.7)
		})
	})

	describe("Edge cases", () => {
		it("should handle empty code strings", async () => {
			const result = await validator.validateChange("", "")

			expect(result.isValid).toBe(true)
		})

		it("should handle parsing errors", async () => {
			// Mock parse error
			mockAstProvider.parseFile.mockResolvedValue(null)

			const original = "function test() { return 42; }"
			const modified = "function test() { return invalid syntax; }" // Syntax error

			const result = await validator.validateChange(original, modified)

			expect(result.isValid).toBe(false)
			expect(result.error).toBeDefined()
		})

		it("should handle embedding service errors", async () => {
			// Mock embedding service error
			mockEmbeddingService.embedText.mockRejectedValueOnce(new Error("Embedding error"))

			const original = "function test() { return 42; }"
			const modified = "function test() { return 43; }"

			const result = await validator.validateChange(original, modified)

			// Should fall back to structural validation only
			expect(result.semanticScore).toBeUndefined()
			expect(result.structuralScore).toBeDefined()
		})
	})

	describe("Advanced validation features", () => {
		it("should validate import statements", async () => {
			const original = "import { Component } from 'react';"
			const modified = "import { Component, useState } from 'react';"

			const options: ValidationOptions = {
				validateImports: true,
			}

			// Mock specific parse results for imports
			mockAstProvider.parseFile.mockImplementation((content: string) => {
				if (content === original) {
					return Promise.resolve({
						rootNode: {
							type: "program",
							children: [
								{
									type: "import_declaration",
									text: original,
								},
							],
						},
					} as any)
				} else {
					return Promise.resolve({
						rootNode: {
							type: "program",
							children: [
								{
									type: "import_declaration",
									text: modified,
								},
							],
						},
					} as any)
				}
			})

			const result = await validator.validateChange(original, modified, options)

			expect(result.isValid).toBe(true)
		})

		it("should skip validation for specified node types", async () => {
			const original = "// This is a comment\nfunction test() {}"
			const modified = "// Completely different comment\nfunction test() {}"

			const options: ValidationOptions = {
				skipTypes: ["comment"],
			}

			// Setup mock for structure detection
			jest.spyOn(validator as any, "getNodeTypes").mockImplementation((content: string) => {
				if (content.includes("This is a comment")) {
					return ["comment", "function_declaration"]
				} else {
					return ["comment", "function_declaration"]
				}
			})

			const result = await validator.validateChange(original, modified, options)

			// Should be valid since comments are skipped
			expect(result.isValid).toBe(true)
		})
	})
})
