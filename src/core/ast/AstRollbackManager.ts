import * as fs from "fs/promises"
import * as path from "path"
import { logger } from "../../utils/logging"

/**
 * Interface for an edit backup
 */
interface EditBackup {
	filePath: string
	absolutePath: string
	originalContent: string
	timestamp: number
	operation: string
	metadata?: Record<string, any>
}

/**
 * Manager for handling rollbacks of AST-based edits
 */
export class AstRollbackManager {
	private static instance: AstRollbackManager
	private backups: Map<string, EditBackup[]> = new Map()
	private MAX_BACKUPS_PER_FILE = 10

	private constructor() {}

	/**
	 * Get the singleton instance
	 */
	public static getInstance(): AstRollbackManager {
		if (!AstRollbackManager.instance) {
			AstRollbackManager.instance = new AstRollbackManager()
		}
		return AstRollbackManager.instance
	}

	/**
	 * Set the maximum number of backups to keep per file
	 * @param maxBackups Maximum number of backups (must be > 0)
	 */
	public setMaxBackupsPerFile(maxBackups: number): void {
		if (maxBackups > 0) {
			this.MAX_BACKUPS_PER_FILE = maxBackups
			logger.debug(`Set max backups per file to ${maxBackups}`)
		} else {
			logger.warn(`Invalid value for max backups: ${maxBackups}, must be > 0`)
		}
	}

	/**
	 * Get the current maximum number of backups per file
	 */
	public getMaxBackupsPerFile(): number {
		return this.MAX_BACKUPS_PER_FILE
	}

	/**
	 * Create a backup before making changes to a file
	 * @param filePath Relative path to the file
	 * @param absolutePath Absolute path to the file
	 * @param operation Name of the operation being performed
	 * @param metadata Optional metadata about the operation
	 */
	public async createBackup(
		filePath: string,
		absolutePath: string,
		operation: string = "modify_function_body",
		metadata?: Record<string, any>,
	): Promise<boolean> {
		try {
			// Check if file exists
			try {
				await fs.access(absolutePath)
			} catch {
				logger.warn(`Cannot create backup for non-existent file: ${filePath}`)
				return false
			}

			// Read the original content
			const originalContent = await fs.readFile(absolutePath, "utf-8")

			// Create backup entry
			const backup: EditBackup = {
				filePath,
				absolutePath,
				originalContent,
				timestamp: Date.now(),
				operation,
				metadata,
			}

			// Get or create backup array for this file
			let fileBackups = this.backups.get(filePath)
			if (!fileBackups) {
				fileBackups = []
				this.backups.set(filePath, fileBackups)
			}

			// Add backup to the beginning (most recent first)
			fileBackups.unshift(backup)

			// Limit number of backups
			if (fileBackups.length > this.MAX_BACKUPS_PER_FILE) {
				fileBackups.pop() // Remove oldest
			}

			logger.debug(`Created backup for ${filePath} (operation: ${operation})`)
			return true
		} catch (error) {
			logger.error(`Failed to create backup for ${filePath}:`, error)
			return false
		}
	}

	/**
	 * Roll back changes to a file
	 * @param filePath Relative path to the file
	 */
	public async rollback(filePath: string): Promise<boolean> {
		try {
			// Get backups for the file
			const fileBackups = this.backups.get(filePath)
			if (!fileBackups || fileBackups.length === 0) {
				logger.warn(`No backups available for ${filePath}`)
				return false
			}

			// Get the most recent backup
			const backup = fileBackups[0]

			// Restore the original content
			await fs.writeFile(backup.absolutePath, backup.originalContent, "utf-8")

			// Remove the used backup
			fileBackups.shift()

			logger.info(`Rolled back changes to ${filePath}`)
			return true
		} catch (error) {
			logger.error(`Failed to roll back changes to ${filePath}:`, error)
			return false
		}
	}

	/**
	 * Get all backups for a file
	 * @param filePath Relative path to the file
	 * @returns Array of EditBackup objects
	 */
	public getBackups(filePath: string): EditBackup[] {
		return this.backups.get(filePath) || []
	}

	/**
	 * Get backup information for a file without the content
	 * @param filePath Relative path to the file
	 */
	public getBackupInfo(filePath: string): Array<Omit<EditBackup, "originalContent" | "absolutePath">> {
		const fileBackups = this.backups.get(filePath) || []
		return fileBackups.map(({ filePath, timestamp, operation, metadata }) => ({
			filePath,
			timestamp,
			operation,
			metadata,
		}))
	}

	/**
	 * Check if a file has backups
	 * @param filePath Relative path to the file
	 */
	public hasBackups(filePath: string): boolean {
		const fileBackups = this.backups.get(filePath)
		return !!fileBackups && fileBackups.length > 0
	}

	/**
	 * Clear backups for a file or all files
	 * @param filePath Optional path to clear backups for a specific file
	 */
	public clearBackups(filePath?: string): void {
		if (filePath) {
			this.backups.delete(filePath)
			logger.debug(`Cleared backups for ${filePath}`)
		} else {
			this.backups.clear()
			logger.debug("Cleared all backups")
		}
	}

	/**
	 * Get the most recent backup without removing it
	 * @param filePath Relative path to the file
	 */
	public async peekBackup(filePath: string): Promise<string | null> {
		const fileBackups = this.backups.get(filePath)
		if (!fileBackups || fileBackups.length === 0) {
			return null
		}

		return fileBackups[0].originalContent
	}

	/**
	 * Create a multi-file backup for operations that affect multiple files
	 * @param filePaths List of file paths to back up
	 * @param operation Name of the operation
	 */
	public async createMultiFileBackup(
		filePaths: string[],
		workingDirectory: string,
		operation: string = "refactor",
	): Promise<boolean> {
		try {
			let allSucceeded = true

			for (const filePath of filePaths) {
				const absolutePath = path.resolve(workingDirectory, filePath)
				const success = await this.createBackup(filePath, absolutePath, operation, {
					multiFile: true,
					files: filePaths,
				})

				if (!success) {
					allSucceeded = false
				}
			}

			return allSucceeded
		} catch (error) {
			logger.error("Failed to create multi-file backup:", error)
			return false
		}
	}

	/**
	 * Roll back a multi-file operation
	 * @param filePaths List of file paths to roll back
	 */
	public async rollbackMultiFile(filePaths: string[]): Promise<boolean> {
		try {
			let allSucceeded = true

			for (const filePath of filePaths) {
				const success = await this.rollback(filePath)

				if (!success) {
					allSucceeded = false
				}
			}

			return allSucceeded
		} catch (error) {
			logger.error("Failed to roll back multi-file operation:", error)
			return false
		}
	}
}
