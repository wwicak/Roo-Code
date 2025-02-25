import * as path from "path"
import * as fs from "fs/promises"
import { jest } from "@jest/globals"
import { ClineAstIntegration } from "../ClineAstIntegration"
import { AstProvider } from "../AstService"
import { AstRollbackManager } from "../AstRollbackManager"
import { SemanticValidator } from "../SemanticValidator"
import { NebiusEmbeddingService } from "../../../services/embedding/NebiusEmbeddingService"
import * as astDiffModule from "../../diff/strategies/ast-diff-enhanced"
import { AstErrorCode } from "../AstErrorHandler"

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
	// Use any type for mocks to avoid TypeScript errors with Jest mocks
	const mockAstProvider: any = {
		initialize: jest.fn().mockResolvedValue(undefined),
		getNodeWithIdentifier: jest.fn(),
		getRelatedFiles: jest.fn().mockReturnValue(new Set(["related1.ts", "related2.ts"])),
		getInstance: jest.fn().mockReturnThis(),
	}

	const mockRollbackManager: any = {
		createBackup: jest.fn().mockResolvedValue(true),
		rollback: jest.fn(),
		getBackupInfo: jest.fn(),
		getInstance: jest.fn().mockReturnThis(),
	}

	const mockSemanticValidator: any = {
		validateChange: jest.fn(),
	}

	const mockEmbeddingService = {}

	// Sample test data
	const testFilePath = "test.ts"
	const testFunctionId = "testFunction:10"
	const testCwd = "/test/cwd"
	const testAbsolutePath = path.resolve(testCwd, testFilePath)
	const testOriginalContent = "function testFunction() { return 'original'; }"
	const testNewBody = "{ return 'modified'; }"
	const testReconstructedContent = "function testFunction() { return 'modified'; }"

	beforeEach(() => {
		jest.clearAllMocks()

		// Reset mocks
		;(AstProvider.getInstance as jest.Mock).mockReturnValue(mockAstProvider)
		;(AstRollbackManager.getInstance as jest.Mock).mockReturnValue(mockRollbackManager)
		;(SemanticValidator as unknown as jest.Mock).mockImplementation(() => mockSemanticValidator)
		;(NebiusEmbeddingService as unknown as jest.Mock).mockImplementation(() => mockEmbeddingService)

		// Mock fs functions
		;(fs.access as jest.Mock).mockResolvedValue(undefined)
		;(fs.readFile as jest.Mock).mockResolvedValue(testOriginalContent)
		;(fs.writeFile as jest.Mock).mockResolvedValue(undefined)

		// Mock AST diff functions
		;(astDiffModule.reconstructContentWithModifiedFunction as jest.Mock).mockResolvedValue(testReconstructedContent)
		;(astDiffModule.getFunctionModifications as jest.Mock).mockResolvedValue([
			{ type: "modified", node: { type: "function" } },
		])

		// Setup node mock for getNodeWithIdentifier
		mockAstProvider.getNodeWithIdentifier.mockResolvedValue({
			childForFieldName: (name: string) => {
				if (name === "body") {
					return { text: "{ return 'original'; }" }
				}
				return null
			},
		})

		// Setup semantic validator
		mockSemanticValidator.validateChange.mockResolvedValue({
			isValid: true,
			semanticScore: 0.9,
			structuralScore: 0.95,
		})

		// Setup rollback manager
		mockRollbackManager.rollback.mockResolvedValue(true)
		mockRollbackManager.getBackupInfo.mockReturnValue([
			{ operation: "modify_function_body", timestamp: Date.now() },
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
			expect(result.message).toContain("Successfully modified function body")
			expect(fs.writeFile).toHaveBeenCalledWith(testAbsolutePath, testReconstructedContent, "utf-8")
			expect(mockRollbackManager.createBackup).toHaveBeenCalledWith(
				testFilePath,
				testAbsolutePath,
				"modify_function_body",
			)
		})

		it("should handle file not found errors", async () => {
			;(fs.access as jest.Mock).mockRejectedValueOnce(new Error("File not found"))

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.message).toContain("File does not exist")
			expect(result.error?.code).toBe(AstErrorCode.GENERAL_ERROR)
		})

		it("should handle reconstruction failures", async () => {
			;(astDiffModule.reconstructContentWithModifiedFunction as jest.Mock).mockResolvedValueOnce(null)

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.message).toContain("Failed to reconstruct content")
			expect(result.error?.code).toBe(AstErrorCode.NODE_NOT_FOUND)
		})

		it("should handle validation failures", async () => {
			;(astDiffModule.getFunctionModifications as jest.Mock).mockResolvedValueOnce([])

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.message).toContain("failed validation")
			expect(result.error?.code).toBe(AstErrorCode.STRUCTURAL_VALIDATION_FAILED)
			expect(mockRollbackManager.rollback).toHaveBeenCalledWith(testFilePath)
		})

		it("should handle general errors during the process", async () => {
			;(fs.readFile as jest.Mock).mockRejectedValueOnce(new Error("Read error"))

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(result.message).toContain("Error modifying function body")
			expect(result.error?.code).toBe(AstErrorCode.GENERAL_ERROR)
		})

		it("should handle rollback failures", async () => {
			;(astDiffModule.getFunctionModifications as jest.Mock).mockResolvedValueOnce([])
			mockRollbackManager.rollback.mockResolvedValueOnce(false)

			const integration = new ClineAstIntegration()
			const result = await integration.modifyFunctionBody(testCwd, testFilePath, testFunctionId, testNewBody)

			expect(result.success).toBe(false)
			expect(mockRollbackManager.rollback).toHaveBeenCalledWith(testFilePath)
		})
	})

	describe("validateFunctionBodyChange", () => {
		it("should successfully validate a function body change", async () => {
			const integration = new ClineAstIntegration()
			const result = await integration.validateFunctionBodyChange(testFilePath, testFunctionId, testNewBody)

			expect(result.isValid).toBe(true)
			expect(result.message).toBe("Function body change is valid")
			expect(result.semanticScore).toBe(0.9)
			expect(result.structuralScore).toBe(0.95)
		})

		it("should return invalid if node not found", async () => {
			mockAstProvider.getNodeWithIdentifier.mockResolvedValueOnce(null)

			const integration = new ClineAstIntegration()
			const result = await integration.validateFunctionBodyChange(testFilePath, testFunctionId, testNewBody)

			expect(result.isValid).toBe(false)
			expect(result.message).toContain("not found")
		})

		it("should return invalid if validation fails", async () => {
			mockSemanticValidator.validateChange.mockResolvedValueOnce({
				isValid: false,
				error: "Semantic validation failed",
				semanticScore: 0.3,
				structuralScore: 0.95,
			})

			const integration = new ClineAstIntegration()
			const result = await integration.validateFunctionBodyChange(testFilePath, testFunctionId, testNewBody)

			expect(result.isValid).toBe(false)
			expect(result.message).toBe("Semantic validation failed")
			expect(result.semanticScore).toBe(0.3)
		})

		it("should handle errors during validation", async () => {
			mockAstProvider.getNodeWithIdentifier.mockRejectedValueOnce(new Error("Validation error"))

			const integration = new ClineAstIntegration()
			const result = await integration.validateFunctionBodyChange(testFilePath, testFunctionId, testNewBody)

			expect(result.isValid).toBe(false)
			expect(result.message).toContain("Error during validation")
		})
	})

	describe("rollbackChange", () => {
		it("should successfully roll back changes", async () => {
			const integration = new ClineAstIntegration()
			const result = await integration.rollbackChange(testFilePath)

			expect(result.success).toBe(true)
			expect(result.message).toContain("Successfully rolled back")
		})

		it("should handle rollback failures", async () => {
			mockRollbackManager.rollback.mockResolvedValueOnce(false)

			const integration = new ClineAstIntegration()
			const result = await integration.rollbackChange(testFilePath)

			expect(result.success).toBe(false)
			expect(result.message).toContain("Failed to roll back")
		})
	})

	describe("getBackupInfo", () => {
		it("should return backup information", () => {
			const integration = new ClineAstIntegration()
			const result = integration.getBackupInfo(testFilePath)

			expect(result.hasBackups).toBe(true)
			expect(result.count).toBe(1)
			expect(result.operations).toEqual(["modify_function_body"])
		})

		it("should handle no backups", () => {
			mockRollbackManager.getBackupInfo.mockReturnValueOnce([])

			const integration = new ClineAstIntegration()
			const result = integration.getBackupInfo(testFilePath)

			expect(result.hasBackups).toBe(false)
			expect(result.count).toBe(0)
			expect(result.operations).toEqual([])
		})
	})

	describe("getRelatedFiles", () => {
		it("should return related files", () => {
			const integration = new ClineAstIntegration()
			const result = integration.getRelatedFiles(testFilePath)

			expect(result).toEqual(["related1.ts", "related2.ts"])
		})

		it("should handle no related files", () => {
			mockAstProvider.getRelatedFiles.mockReturnValueOnce(new Set())

			const integration = new ClineAstIntegration()
			const result = integration.getRelatedFiles(testFilePath)

			expect(result).toEqual([])
		})
	})
})
