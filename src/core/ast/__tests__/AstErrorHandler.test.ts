import { jest } from "@jest/globals"
import { AstErrorHandler, AstErrorCode, AstError, EditFallback } from "../AstErrorHandler"
import Parser from "web-tree-sitter"

// Mock dependencies
jest.mock("../../../utils/logging", () => ({
	logger: {
		info: jest.fn(),
		error: jest.fn(),
		warn: jest.fn(),
		debug: jest.fn(),
	},
}))

describe("AstErrorHandler", () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe("Error creation", () => {
		it("should create a structured AST error", () => {
			const code = AstErrorCode.NODE_NOT_FOUND
			const message = "Test error message"
			const details = {
				filepath: "test.ts",
				node: {
					type: "function",
					identifier: "testFunc:10",
					line: 10,
					column: 5,
				},
			}

			const error = AstErrorHandler.createError(code, message, details)

			expect(error.code).toBe(code)
			expect(error.message).toBe(message)
			expect(error.filepath).toBe(details.filepath)
			expect(error.node).toEqual(details.node)
		})

		it("should create an error with minimal details", () => {
			const error = AstErrorHandler.createError(AstErrorCode.GENERAL_ERROR, "General error")

			expect(error.code).toBe(AstErrorCode.GENERAL_ERROR)
			expect(error.message).toBe("General error")
			expect(error.filepath).toBeUndefined()
			expect(error.node).toBeUndefined()
		})

		it("should log errors when creating them", () => {
			const loggerSpy = jest.spyOn(require("../../../utils/logging").logger, "error")

			AstErrorHandler.createError(AstErrorCode.PARSE_ERROR, "Parse error in test")

			expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining("AST Error"), expect.any(Object))
		})
	})

	describe("Error detection", () => {
		it("should detect AST errors", () => {
			const astError: AstError = {
				code: AstErrorCode.PARSE_ERROR,
				message: "Parse error",
			}

			expect(AstErrorHandler.isAstError(astError)).toBe(true)
		})

		it("should identify non-AST errors", () => {
			const nonAstError = new Error("General JS error")

			expect(AstErrorHandler.isAstError(nonAstError)).toBe(false)
		})

		it("should reject objects missing required properties", () => {
			const invalidError1 = { message: "No code" }
			const invalidError2 = { code: AstErrorCode.GENERAL_ERROR }
			const invalidError3 = { code: 123, message: "Wrong type for code" }

			expect(AstErrorHandler.isAstError(invalidError1)).toBe(false)
			expect(AstErrorHandler.isAstError(invalidError2)).toBe(false)
			expect(AstErrorHandler.isAstError(invalidError3)).toBe(false)
		})

		it("should convert general errors to AST errors", () => {
			const generalError = new Error("General error message")
			const filepath = "test.ts"

			const astError = AstErrorHandler.fromError(generalError, filepath)

			expect(AstErrorHandler.isAstError(astError)).toBe(true)
			expect(astError.code).toBe(AstErrorCode.GENERAL_ERROR)
			expect(astError.message).toContain("General error message")
			expect(astError.filepath).toBe(filepath)
			expect(astError.details).toBeDefined()
			expect(astError.details?.stack).toBeDefined()
			expect(astError.details?.name).toBe("Error")
		})

		it("should handle non-Error objects", () => {
			const nonError = "This is a string, not an error"

			const astError = AstErrorHandler.fromError(nonError)

			expect(AstErrorHandler.isAstError(astError)).toBe(true)
			expect(astError.code).toBe(AstErrorCode.GENERAL_ERROR)
			expect(astError.message).toBe("This is a string, not an error")
		})
	})

	describe("Error handling and fallbacks", () => {
		it("should provide appropriate fallback for structural validation failure", () => {
			const error: AstError = {
				code: AstErrorCode.STRUCTURAL_VALIDATION_FAILED,
				message: "Function signature would be modified",
				filepath: "test.ts",
				originalContent: "function original() {}",
			}

			const fallback = AstErrorHandler.handleEditFailure(error)

			expect(fallback.status).toBe("reverted")
			expect(fallback.message).toContain("function signature or structure")
			expect(fallback.fallbackContent).toBe("function original() {}")
			expect(fallback.suggestedAction).toContain("function body")
		})

		it("should provide appropriate fallback for semantic validation failure", () => {
			const error: AstError = {
				code: AstErrorCode.SEMANTIC_VALIDATION_FAILED,
				message: "Changes would make the code semantically inconsistent",
				filepath: "test.ts",
				originalContent: "function original() {}",
			}

			const fallback = AstErrorHandler.handleEditFailure(error)

			expect(fallback.status).toBe("reverted")
			expect(fallback.message).toContain("semantic validation")
			expect(fallback.fallbackContent).toBe("function original() {}")
			expect(fallback.suggestedAction).toContain("core functionality")
		})

		it("should provide appropriate fallback for node not found error", () => {
			const error: AstError = {
				code: AstErrorCode.NODE_NOT_FOUND,
				message: "Function not found: test",
				filepath: "test.ts",
			}

			const fallback = AstErrorHandler.handleEditFailure(error)

			expect(fallback.status).toBe("reverted")
			expect(fallback.message).toContain("Could not locate")
			expect(fallback.suggestedAction).toContain("function name")
		})

		it("should provide appropriate fallback for parser not found error", () => {
			const error: AstError = {
				code: AstErrorCode.PARSER_NOT_FOUND,
				message: "Parser not found for language: typescript",
				filepath: "test.ts",
			}

			const fallback = AstErrorHandler.handleEditFailure(error)

			expect(fallback.status).toBe("reverted")
			expect(fallback.message).toContain("No parser available")
			expect(fallback.suggestedAction).toContain("supported languages")
		})

		it("should provide appropriate fallback for parse error", () => {
			const error: AstError = {
				code: AstErrorCode.PARSE_ERROR,
				message: "Failed to parse file",
				filepath: "test.ts",
				errorNodes: [
					{
						startPosition: { row: 10, column: 5 } as Parser.Point,
						type: "ERROR",
					},
				],
			}

			const fallback = AstErrorHandler.handleEditFailure(error)

			expect(fallback.status).toBe("reverted")
			expect(fallback.message).toContain("Parsing error")
			expect(fallback.errorLocations).toBeDefined()
			expect(fallback.errorLocations?.[0].line).toBe(10)
			expect(fallback.errorLocations?.[0].column).toBe(5)
			expect(fallback.suggestedAction).toContain("syntax errors")
		})

		it("should provide appropriate fallback for incompatible edit error", () => {
			const error: AstError = {
				code: AstErrorCode.INCOMPATIBLE_EDIT,
				message: "Edit is incompatible with the current structure",
				filepath: "test.ts",
			}

			const fallback = AstErrorHandler.handleEditFailure(error)

			expect(fallback.status).toBe("alternative")
			expect(fallback.message).toContain("could not be applied")
			expect(fallback.suggestedAction).toContain("text-based edit")
		})

		it("should provide generic fallback for unspecified errors", () => {
			const error: AstError = {
				code: AstErrorCode.GENERAL_ERROR,
				message: "Something went wrong",
				filepath: "test.ts",
				originalContent: "original content",
				errorNodes: [
					{
						startPosition: { row: 5, column: 3 } as Parser.Point,
						type: "ERROR",
					},
				],
			}

			const fallback = AstErrorHandler.handleEditFailure(error)

			expect(fallback.status).toBe("reverted")
			expect(fallback.message).toContain("Edit failed")
			expect(fallback.fallbackContent).toBe("original content")
			expect(fallback.errorLocations).toBeDefined()
			expect(fallback.errorLocations?.[0].line).toBe(5)
			expect(fallback.suggestedAction).toContain("simplify the edit")
		})
	})

	describe("Error recovery attempts", () => {
		it("should not recover from parse errors", () => {
			const error: AstError = {
				code: AstErrorCode.PARSE_ERROR,
				message: "Parse error: unexpected token",
				filepath: "test.ts",
			}

			const currentContent = "function test() { const x = 1; return x * 2 x + 3; }" // Missing semicolon

			const result = AstErrorHandler.attemptRecovery(error, currentContent)

			expect(result.recovered).toBe(false)
			expect(result.content).toBeUndefined()
		})

		it("should not recover from node not found errors", () => {
			const error: AstError = {
				code: AstErrorCode.NODE_NOT_FOUND,
				message: "Node not found",
				filepath: "test.ts",
			}

			const currentContent = "function test() { return 42; }"

			const result = AstErrorHandler.attemptRecovery(error, currentContent)

			expect(result.recovered).toBe(false)
			expect(result.content).toBeUndefined()
		})

		it("should recover from structural validation errors with original content", () => {
			const error: AstError = {
				code: AstErrorCode.STRUCTURAL_VALIDATION_FAILED,
				message: "Function signature would be modified",
				filepath: "test.ts",
				originalContent: "function original() { return 42; }",
			}

			const currentContent = "function modified(x) { return x * 42; }"

			const result = AstErrorHandler.attemptRecovery(error, currentContent)

			expect(result.recovered).toBe(true)
			expect(result.content).toBe("function original() { return 42; }")
		})

		it("should recover from semantic validation errors with original content", () => {
			const error: AstError = {
				code: AstErrorCode.SEMANTIC_VALIDATION_FAILED,
				message: "Changes would make the code semantically inconsistent",
				filepath: "test.ts",
				originalContent: "function test() { return 'hello'; }",
			}

			const currentContent = "function test() { return 42; }"

			const result = AstErrorHandler.attemptRecovery(error, currentContent)

			expect(result.recovered).toBe(true)
			expect(result.content).toBe("function test() { return 'hello'; }")
		})

		it("should not recover from structural/semantic validation errors without original content", () => {
			const error: AstError = {
				code: AstErrorCode.STRUCTURAL_VALIDATION_FAILED,
				message: "Function signature would be modified",
				filepath: "test.ts",
				// No originalContent provided
			}

			const currentContent = "function modified(x) { return x * 42; }"

			const result = AstErrorHandler.attemptRecovery(error, currentContent)

			expect(result.recovered).toBe(false)
			expect(result.content).toBeUndefined()
		})

		it("should not recover from general errors", () => {
			const error: AstError = {
				code: AstErrorCode.GENERAL_ERROR,
				message: "Unknown error occurred",
				filepath: "test.ts",
				originalContent: "function test() { return 42; }",
			}

			const currentContent = "function test() { return 'modified'; }"

			const result = AstErrorHandler.attemptRecovery(error, currentContent)

			expect(result.recovered).toBe(false)
			expect(result.content).toBeUndefined()
		})
	})
})
