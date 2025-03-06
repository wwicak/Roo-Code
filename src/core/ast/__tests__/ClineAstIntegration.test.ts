import * as path from "path"
import * as fs from "fs/promises"
import { jest } from "@jest/globals"
import Parser from "web-tree-sitter"
import { AstProvider } from "../AstService"
import { AstRollbackManager } from "../AstRollbackManager"
import { ClineAstIntegration } from "../ClineAstIntegration"
import { SemanticValidator } from "../SemanticValidator"
import { NebiusEmbeddingService } from "../../../services/embedding/NebiusEmbeddingService"
import * as astDiffModule from "../../diff/strategies/ast-diff-enhanced"
import { AstErrorCode } from "../AstErrorHandler"
import { MockType, AsyncMockType } from "./mockTypes"
import { ApplyAstDiffToolUse } from "../../assistant-message"

// Mock dependencies
jest.mock("../AstService")
jest.mock("../AstRollbackManager")
jest.mock("../SemanticValidator")
jest.mock("../../../services/embedding/NebiusEmbeddingService")
jest.mock("../../diff/strategies/ast-diff-enhanced")
jest.mock("fs/promises")
jest.mock("../../../utils/logging", () => ({
	logger: {
		info: jest.fn(),
		error: jest.fn(),
		warn: jest.fn(),
		debug: jest.fn(),
	},
}))

describe("ClineAstIntegration", () => {
	// Mock data
	const testFilePath = "test.ts"
	const testFunctionId = "testFunction:10"
	const testCwd = "/test/cwd"
	const testAbsolutePath = path.resolve(testCwd, testFilePath)
	const testOriginalContent = "function testFunction() { return 'original'; }"
	const testNewBody = "{ return 'modified'; }"
	const testReconstructedContent = "function testFunction() { return 'modified'; }"

	// Mock objects
	let mockAstProvider: jest.Mocked<AstProvider>
	let mockRollbackManager: jest.Mocked<AstRollbackManager>
	let mockSemanticValidator: jest.Mocked<SemanticValidator>
	let mockEmbeddingService: jest.Mocked<NebiusEmbeddingService>

	beforeEach(() => {
		jest.clearAllMocks()

		// Setup ast provider
		mockAstProvider = {
			initialize: jest.fn().mockImplementation(async () => {}),
			getNodeWithIdentifier: jest.fn().mockImplementation(async (filePath, identifier) => {
				if (filePath === testFilePath && identifier === testFunctionId) {
					return {
						type: "function_declaration",
						text: testOriginalContent,
						startPosition: { row: 0, column: 0 },
						endPosition: { row: 0, column: testOriginalContent.length },
						childForFieldName: (name: string) => {
							if (name === "body") {
								return {
									text: "{ return 'original'; }",
									startPosition: { row: 0, column: 30 },
									endPosition: { row: 0, column: 50 },
								} as Parser.SyntaxNode
							}
							return null
						},
					} as Parser.SyntaxNode
				}
				return null
			}),
			getRelatedFiles: jest.fn().mockReturnValue(new Set(["related1.ts", "related2.ts"])),
			getInstance: jest.fn(),
			serializeAst: jest.fn(),
			parseFile: jest.fn(),
			setCacheEnabled: jest.fn(),
			isCacheEnabled: jest.fn().mockReturnValue(true),
			invalidateFile: jest.fn(),
			getSymbolDatabase: jest.fn(),
		} as unknown as jest.Mocked<AstProvider>
		;(AstProvider.getInstance as jest.Mock).mockReturnValue(mockAstProvider)

		// Setup rollback manager
		mockRollbackManager = {
			createBackup: jest.fn().mockImplementation(async () => true),
			rollback: jest.fn().mockImplementation(async () => true),
			getBackupInfo: jest.fn().mockReturnValue([
				{
					filePath: testFilePath,
					operation: "apply_ast_diff",
					timestamp: Date.now(),
				},
			]),
			getInstance: jest.fn(),
			setMaxBackupsPerFile: jest.fn(),
		} as unknown as jest.Mocked<AstRollbackManager>
		;(AstRollbackManager.getInstance as jest.Mock).mockReturnValue(mockRollbackManager)

		// Setup semantic validator
		mockSemanticValidator = {
			validateChange: jest.fn().mockImplementation(async () => ({
				isValid: true,
				semanticScore: 0.9,
				structuralScore: 0.95,
			})),
			validateFunctionBodyChange: jest.fn().mockImplementation(async () => ({
				isValid: true,
				message: "Valid change",
				semanticScore: 0.9,
				structuralScore: 0.95,
			})),
		} as unknown as jest.Mocked<SemanticValidator>
		;(SemanticValidator as jest.Mock).mockImplementation(() => mockSemanticValidator)

		// Setup embedding service
		mockEmbeddingService = {
			embedText: jest.fn().mockImplementation(async () => [0.1, 0.2, 0.3]),
		} as unknown as jest.Mocked<NebiusEmbeddingService>
		;(NebiusEmbeddingService as jest.Mock).mockImplementation(() => mockEmbeddingService)

		// Mock fs functions
		jest.mocked(fs.access).mockImplementation(async () => {})
		jest.mocked(fs.readFile).mockResolvedValue(testOriginalContent)
		jest.mocked(fs.writeFile).mockImplementation(async () => {})

		// Mock AST diff functions
		jest.mocked(astDiffModule.reconstructContentWithModifiedFunction).mockResolvedValue(testReconstructedContent)
		jest.mocked(astDiffModule.getFunctionModifications).mockResolvedValue([
			{
				type: "tool_use",
				name: "apply_ast_diff",
				params: {
					path: testFilePath,
					diff: testNewBody,
				},
				partial: false,
			} as ApplyAstDiffToolUse,
		])
	})

	describe("Initialization", () => {
		it("should initialize correctly", async () => {
			const integration = new ClineAstIntegration("testApiKey")
			await integration.initialize()

			expect(mockAstProvider.initialize).toHaveBeenCalled()
		})

		it("should initialize only once when called multiple times", async () => {
			const integration = new ClineAstIntegration()
			await integration.initialize()
			await integration.initialize()

			expect(mockAstProvider.initialize).toHaveBeenCalledTimes(1)
		})

		it("should handle initialization errors", async () => {
			mockAstProvider.initialize.mockRejectedValueOnce(new Error("Init error"))

			const integration = new ClineAstIntegration()
			await expect(integration.initialize()).rejects.toThrow("Init error")
		})
	})

	describe("modifyFunctionBody", () => {
		it("should successfully modify a function body", async () => {
			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(true)
			expect(fs.writeFile).toHaveBeenCalledWith(testAbsolutePath, testReconstructedContent, "utf-8")
		})

		it("should handle file not found errors", async () => {
			jest.mocked(fs.access).mockRejectedValueOnce(new Error("File not found"))

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.error?.code).toBe(AstErrorCode.GENERAL_ERROR)
		})

		it("should handle reconstruction failures", async () => {
			jest.mocked(astDiffModule.reconstructContentWithModifiedFunction).mockResolvedValueOnce(null)

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.error?.code).toBe(AstErrorCode.NODE_NOT_FOUND)
		})

		it("should handle validation failures", async () => {
			jest.mocked(astDiffModule.getFunctionModifications).mockResolvedValueOnce([])

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.error?.code).toBe(AstErrorCode.STRUCTURAL_VALIDATION_FAILED)
		})

		it("should handle general errors during the process", async () => {
			jest.mocked(fs.readFile).mockRejectedValueOnce(new Error("Read error"))

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.error?.code).toBe(AstErrorCode.GENERAL_ERROR)
		})

		it("should handle rollback failures", async () => {
			jest.mocked(astDiffModule.getFunctionModifications).mockResolvedValueOnce([])
			mockRollbackManager.rollback.mockResolvedValueOnce(false)

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
		})
	})

	describe("rollbackChange", () => {
		it("should successfully rollback a change", async () => {
			const integration = new ClineAstIntegration()
			const result = await integration.rollbackChange(testFilePath)

			expect(result.success).toBe(true)
			expect(mockRollbackManager.rollback).toHaveBeenCalled()
		})

		it("should handle failed rollbacks", async () => {
			mockRollbackManager.rollback.mockResolvedValueOnce(false)

			const integration = new ClineAstIntegration()
			const result = await integration.rollbackChange(testFilePath)

			expect(result.success).toBe(false)
		})
	})

	describe("getBackupInfo", () => {
		it("should return backup info", () => {
			const integration = new ClineAstIntegration()
			const result = integration.getBackupInfo(testFilePath)

			expect(result.hasBackups).toBe(true)
			expect(result.operations).toEqual(["apply_ast_diff"])
		})
	})

	describe("validateFunctionBodyChange", () => {
		it("should successfully validate a function body change", async () => {
			const integration = new ClineAstIntegration()
			const result = await integration.validateFunctionBodyChange(testFilePath, testFunctionId, testNewBody)

			expect(result.isValid).toBe(true)
		})

		it("should handle missing node gracefully", async () => {
			mockAstProvider.getNodeWithIdentifier.mockImplementationOnce(async () => null)

			const integration = new ClineAstIntegration()
			const result = await integration.validateFunctionBodyChange(testFilePath, testFunctionId, testNewBody)

			expect(result.isValid).toBe(false)
		})

		it("should handle validation failures", async () => {
			mockSemanticValidator.validateFunctionBodyChange.mockResolvedValueOnce({
				isValid: false,
				message: "Failed validation",
				semanticScore: 0.5,
				structuralScore: 0.5,
			})

			const integration = new ClineAstIntegration()
			const result = await integration.validateFunctionBodyChange(testFilePath, testFunctionId, testNewBody)

			expect(result.isValid).toBe(false)
		})
	})

	describe("getRelatedFiles", () => {
		it("should return related files", () => {
			const integration = new ClineAstIntegration()
			const result = integration.getRelatedFiles(testFilePath)

			expect(result).toEqual(["related1.ts", "related2.ts"])
		})
	})
})
