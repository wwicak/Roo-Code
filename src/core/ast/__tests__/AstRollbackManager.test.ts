import { jest } from "@jest/globals"
import { AstRollbackManager, EditBackup } from "../AstRollbackManager"
import * as fs from "fs/promises"
import * as path from "path"
import { PathLike } from "fs"
import { FileHandle } from "fs/promises"

// Mock dependencies
jest.mock("fs/promises")
jest.mock("path", () => ({
	...(jest.requireActual("path") as object),
	resolve: jest.fn().mockImplementation((...args) => args.join("/")),
}))
jest.mock("../../../utils/logging", () => ({
	logger: {
		info: jest.fn(),
		error: jest.fn(),
		warn: jest.fn(),
		debug: jest.fn(),
	},
}))

describe("AstRollbackManager", () => {
	let rollbackManager: AstRollbackManager

	beforeEach(() => {
		jest.clearAllMocks()

		// Reset the singleton instance
		// @ts-ignore - Accessing private static member for testing
		AstRollbackManager.instance = undefined

		// Get a new instance
		rollbackManager = AstRollbackManager.getInstance()

		// Mock fs functions
		const mockReadFile = jest.fn(async (path: PathLike | FileHandle) => {
			if (typeof path === "string" && path.includes("existing.ts")) {
				return "function test() { return 'original'; }"
			}
			throw new Error("File not found")
		})
		Object.assign(fs, { readFile: mockReadFile })

		const mockWriteFile = jest.fn(async () => undefined)
		Object.assign(fs, { writeFile: mockWriteFile })

		const mockAccess = jest.fn(async (path: PathLike | FileHandle) => {
			if (typeof path === "string" && path.includes("existing.ts")) {
				return undefined
			}
			throw new Error("File not found")
		})
		Object.assign(fs, { access: mockAccess })
	})

	describe("Singleton behavior", () => {
		it("should return the same instance when getInstance is called multiple times", () => {
			const instance1 = AstRollbackManager.getInstance()
			const instance2 = AstRollbackManager.getInstance()

			expect(instance1).toBe(instance2)
		})
	})

	describe("Backup configuration", () => {
		it("should set the maximum number of backups per file", () => {
			const maxBackups = 5

			rollbackManager.setMaxBackupsPerFile(maxBackups)

			expect(rollbackManager.getMaxBackupsPerFile()).toBe(maxBackups)
		})

		it("should reject invalid values for max backups", () => {
			const originalMax = rollbackManager.getMaxBackupsPerFile()

			rollbackManager.setMaxBackupsPerFile(0) // Invalid value

			// Should not change the original value
			expect(rollbackManager.getMaxBackupsPerFile()).toBe(originalMax)
		})
	})

	describe("Backup creation", () => {
		it("should create a backup of a file", async () => {
			const filePath = "test.ts"
			const absolutePath = "/path/to/existing.ts"
			const operation = "modify_function_body"
			const metadata = { functionName: "test" }

			const result = await rollbackManager.createBackup(filePath, absolutePath, operation, metadata)

			expect(result).toBe(true)
			expect(fs.readFile).toHaveBeenCalledWith(absolutePath, "utf-8")

			// Check if the backup is stored
			const backups = rollbackManager.getBackupInfo(filePath)
			expect(backups.length).toBe(1)
			expect(backups[0].filePath).toBe(filePath)
			expect(backups[0].operation).toBe(operation)
			expect(backups[0].metadata).toEqual(metadata)
		})

		it("should handle errors when creating a backup", async () => {
			const filePath = "non-existent.ts"
			const absolutePath = "/path/to/non-existent.ts"

			const result = await rollbackManager.createBackup(filePath, absolutePath, "modify")

			expect(result).toBe(false)
		})

		it("should limit the number of backups per file", async () => {
			// Set a low limit for testing
			rollbackManager.setMaxBackupsPerFile(2)

			const filePath = "test.ts"
			const absolutePath = "/path/to/existing.ts"

			// Create 3 backups (exceeding the limit of 2)
			await rollbackManager.createBackup(filePath, absolutePath, "operation1")
			await rollbackManager.createBackup(filePath, absolutePath, "operation2")
			await rollbackManager.createBackup(filePath, absolutePath, "operation3")

			// Should only keep the 2 most recent backups
			const backups = rollbackManager.getBackupInfo(filePath)
			expect(backups.length).toBe(2)
			expect(backups[0].operation).toBe("operation2")
			expect(backups[1].operation).toBe("operation3")
		})
	})

	describe("Rollback functionality", () => {
		it("should rollback a file to its previous state", async () => {
			const filePath = "test.ts"
			const absolutePath = "/path/to/existing.ts"

			// Create a backup
			await rollbackManager.createBackup(filePath, absolutePath, "modify")

			// Perform rollback
			const result = await rollbackManager.rollback(filePath)

			expect(result).toBe(true)
			expect(fs.writeFile).toHaveBeenCalledWith(absolutePath, "function test() { return 'original'; }", "utf-8")
		})

		it("should return false when there are no backups to rollback", async () => {
			const filePath = "no-backup.ts"

			const result = await rollbackManager.rollback(filePath)

			expect(result).toBe(false)
		})

		it("should remove the most recent backup after rollback", async () => {
			const filePath = "test.ts"
			const absolutePath = "/path/to/existing.ts"

			// Create multiple backups
			await rollbackManager.createBackup(filePath, absolutePath, "operation1")
			await rollbackManager.createBackup(filePath, absolutePath, "operation2")

			// Before rollback
			expect(rollbackManager.getBackupInfo(filePath).length).toBe(2)

			// Perform rollback
			await rollbackManager.rollback(filePath)

			// After rollback
			expect(rollbackManager.getBackupInfo(filePath).length).toBe(1)
			expect(rollbackManager.getBackupInfo(filePath)[0].operation).toBe("operation1")
		})

		it("should handle errors during rollback", async () => {
			const filePath = "test.ts"
			const absolutePath = "/path/to/existing.ts"

			// Create a backup
			await rollbackManager.createBackup(filePath, absolutePath, "modify")

			// Mock fs.writeFile to fail
			;(fs.writeFile as jest.Mock).mockRejectedValueOnce(new Error("Write error") as never)

			const result = await rollbackManager.rollback(filePath)

			expect(result).toBe(false)
		})
	})

	describe("Backup information", () => {
		it("should return backup information for a file", async () => {
			const filePath = "test.ts"
			const absolutePath = "/path/to/existing.ts"

			// Create backups with different operations
			await rollbackManager.createBackup(filePath, absolutePath, "operation1", { detail: "first" })
			await rollbackManager.createBackup(filePath, absolutePath, "operation2", { detail: "second" })

			const backups = rollbackManager.getBackupInfo(filePath)

			expect(backups.length).toBe(2)
			expect(backups[0].operation).toBe("operation1")
			expect(backups[0].metadata?.detail).toBe("first")
			expect(backups[1].operation).toBe("operation2")
			expect(backups[1].metadata?.detail).toBe("second")
		})

		it("should return an empty array for files with no backups", () => {
			const filePath = "no-backup.ts"

			const backups = rollbackManager.getBackupInfo(filePath)

			expect(backups).toEqual([])
		})
	})

	describe("Backup management", () => {
		it("should clear all backups", async () => {
			const filePath1 = "test1.ts"
			const filePath2 = "test2.ts"
			const absolutePath = "/path/to/existing.ts"

			// Create backups for multiple files
			await rollbackManager.createBackup(filePath1, absolutePath, "operation1")
			await rollbackManager.createBackup(filePath2, absolutePath, "operation2")

			// Clear all backups
			rollbackManager.clearBackups()

			expect(rollbackManager.getBackupInfo(filePath1)).toEqual([])
			expect(rollbackManager.getBackupInfo(filePath2)).toEqual([])
		})

		it("should clear backups for a single file", async () => {
			const filePath1 = "test1.ts"
			const filePath2 = "test2.ts"
			const absolutePath = "/path/to/existing.ts"

			// Create backups for multiple files
			await rollbackManager.createBackup(filePath1, absolutePath, "operation1")
			await rollbackManager.createBackup(filePath2, absolutePath, "operation2")

			// Clear backups for one file
			rollbackManager.clearBackups(filePath1)

			expect(rollbackManager.getBackupInfo(filePath1)).toEqual([])
			expect(rollbackManager.getBackupInfo(filePath2).length).toBe(1)
		})
	})

	describe("Cleanup", () => {
		it("should clear all backups", () => {
			const filePath = "test.ts"
			const absolutePath = "/path/to/existing.ts"

			// Create some backups first
			rollbackManager.createBackup(filePath, absolutePath, "operation1")
			rollbackManager.createBackup(filePath, absolutePath, "operation2")

			// Clear all backups
			rollbackManager.clearBackups()

			expect(rollbackManager.hasBackups(filePath)).toBe(false)
		})
	})
})
