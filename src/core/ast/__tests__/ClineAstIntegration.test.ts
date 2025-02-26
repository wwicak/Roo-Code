import * as path from "path"
import * as fs from "fs/promises"
import { jest } from "@jest/globals"
import { AstProvider } from "../AstService"
import { AstRollbackManager, EditBackup } from "../AstRollbackManager"
import { ClineAstIntegration } from "../ClineAstIntegration"
import { SemanticValidator, ValidationOptions, ValidationResult } from "../SemanticValidator"
import { NebiusEmbeddingService } from "../../../services/embedding/NebiusEmbeddingService"
import * as astDiffModule from "../../diff/strategies/ast-diff-enhanced"
import { AstErrorCode } from "../AstErrorHandler"
import { MockType, AsyncMockType } from "./mockTypes"

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
	const mockAstProvider: MockType<AstProvider> = {
		initialize: jest.fn().mockResolvedValue(undefined),
		getNodeWithIdentifier: jest.fn(),
		getRelatedFiles: jest.fn(),
		getInstance: jest.fn(),
	}

	const mockRollbackManager: MockType<AstRollbackManager> = {
		createBackup: jest.fn(),
		rollback: jest.fn(),
		getBackupInfo: jest.fn(),
		getInstance: jest.fn(),
	}

	const mockSemanticValidator: MockType<SemanticValidator> = {
		validateChange: jest.fn(),
		validateFunctionBodyChange: jest.fn(),
	}

	const mockEmbeddingService: MockType<NebiusEmbeddingService> = {
		embedText: jest.fn(),
	}

	beforeEach(() => {
		jest.clearAllMocks()

		// Setup ast provider
		;(AstProvider.getInstance as jest.Mock).mockReturnValue(mockAstProvider)
		mockAstProvider.initialize.mockResolvedValue(undefined)
		mockAstProvider.getNodeWithIdentifier.mockResolvedValue({
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
					}
				}
				return null
			},
		})
		mockAstProvider.getRelatedFiles.mockReturnValue(new Set(["related1.ts", "related2.ts"]))

		// Setup rollback manager
		;(AstRollbackManager.getInstance as jest.Mock).mockReturnValue(mockRollbackManager)
		mockRollbackManager.createBackup.mockResolvedValue(true)
		mockRollbackManager.rollback.mockResolvedValue(true)
		mockRollbackManager.getBackupInfo.mockReturnValue([
			{
				filePath: testFilePath,
				operation: "modify_function_body",
				timestamp: Date.now(),
			},
		])

		// Setup semantic validator
		;(SemanticValidator as jest.Mock).mockImplementation(() => mockSemanticValidator)
		mockSemanticValidator.validateChange.mockResolvedValue({
			isValid: true,
			semanticScore: 0.9,
			structuralScore: 0.95,
		})
		mockSemanticValidator.validateFunctionBodyChange.mockResolvedValue({
			isValid: true,
			message: "Valid change",
			semanticScore: 0.9,
			structuralScore: 0.95,
		})

		// Setup embedding service
		;(NebiusEmbeddingService as jest.Mock).mockImplementation(() => mockEmbeddingService)
		mockEmbeddingService.embedText.mockResolvedValue([0.1, 0.2, 0.3])

		// Mock fs functions
		;(fs.access as jest.Mock).mockResolvedValue(undefined)
		;(fs.readFile as jest.Mock).mockResolvedValue(testOriginalContent)
		;(fs.writeFile as jest.Mock).mockResolvedValue(undefined)

		// Mock AST diff functions
		;(astDiffModule.reconstructContentWithModifiedFunction as jest.Mock).mockResolvedValue(testReconstructedContent)
		;(astDiffModule.getFunctionModifications as jest.Mock).mockResolvedValue([
			{ type: "tool_use", functionName: "testFunction" },
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
			;(fs.access as jest.Mock).mockRejectedValueOnce(new Error("File not found"))

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.error?.code).toBe(AstErrorCode.GENERAL_ERROR)
		})

		it("should handle reconstruction failures", async () => {
			;(astDiffModule.reconstructContentWithModifiedFunction as jest.Mock).mockResolvedValueOnce(null)

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.error?.code).toBe(AstErrorCode.NODE_NOT_FOUND)
		})

		it("should handle validation failures", async () => {
			;(astDiffModule.getFunctionModifications as jest.Mock).mockResolvedValueOnce([])

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.error?.code).toBe(AstErrorCode.STRUCTURAL_VALIDATION_FAILED)
		})

		it("should handle general errors during the process", async () => {
			;(fs.readFile as jest.Mock).mockRejectedValueOnce(new Error("Read error"))

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.error?.code).toBe(AstErrorCode.GENERAL_ERROR)
		})

		it("should handle rollback failures", async () => {
			;(astDiffModule.getFunctionModifications as jest.Mock).mockResolvedValueOnce([])
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
			expect(result.operations).toEqual(["modify_function_body"])
		})
	})

	describe("validateFunctionBodyChange", () => {
		it("should successfully validate a function body change", async () => {
			const integration = new ClineAstIntegration()
			const result = await integration.validateFunctionBodyChange(testFilePath, testFunctionId, testNewBody)

			expect(result.isValid).toBe(true)
		})

		it("should handle missing node gracefully", async () => {
			mockAstProvider.getNodeWithIdentifier.mockResolvedValueOnce(null)

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
