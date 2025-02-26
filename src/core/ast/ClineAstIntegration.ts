import * as path from "path"
import * as fs from "fs/promises"
import { AstProvider } from "./AstService"
import { AstErrorHandler, AstErrorCode, AstError } from "./AstErrorHandler"
import { AstRollbackManager } from "./AstRollbackManager"
import { SemanticValidator, ValidationOptions } from "./SemanticValidator"
import { getFunctionModifications, reconstructContentWithModifiedFunction } from "../diff/strategies/ast-diff-enhanced"
import { logger } from "../../utils/logging"
import { NebiusEmbeddingService } from "../../services/embedding/NebiusEmbeddingService"
import { AstCacheManager } from "./AstCacheManager"

/**
 * Configuration options for ClineAstIntegration
 */
export interface ClineAstIntegrationConfig {
	/** API key for embeddings service */
	embeddingApiKey?: string
	/** Maximum number of backups per file (default: 10) */
	maxBackupsPerFile?: number
	/** Semantic similarity threshold (default: 0.82) */
	semanticThreshold?: number
	/** Structural similarity threshold (default: 0.7) */
	structuralThreshold?: number
	/** Whether to cache AST trees for performance (default: true) */
	enableAstCaching?: boolean
}

/**
 * Response interface for modification operations
 */
export interface ModificationResult {
	success: boolean
	message: string
	validationDetails?: string
	error?: {
		code: string
		details?: any
	}
}

/**
 * Response interface for backup operations
 */
export interface BackupInfo {
	hasBackups: boolean
	count: number
	operations: string[]
}

/**
 * Integration class for connecting AST services with Cline.ts
 *
 * @example
 * // Create integration with default settings
 * const integration = new ClineAstIntegration();
 * await integration.initialize();
 *
 * // Modify a function body
 * const result = await integration.modifyFunctionBody(
 *   process.cwd(),
 *   "src/example.ts",
 *   "calculateSum:10",
 *   "{ return a + b; }"
 * );
 *
 * if (result.success) {
 *   console.log("Function updated successfully");
 * } else {
 *   console.error("Update failed:", result.message);
 *   if (result.error) {
 *     console.error("Error code:", result.error.code);
 *   }
 * }
 */
export class ClineAstIntegration {
	private astProvider: AstProvider
	private rollbackManager: AstRollbackManager
	private validator: SemanticValidator
	private embeddingService: NebiusEmbeddingService
	private initialized = false
	private config: Required<ClineAstIntegrationConfig>
	private cacheManager: AstCacheManager

	/**
	 * Create a new ClineAstIntegration instance
	 * @param config Configuration options or embedding API key
	 */
	constructor(config: ClineAstIntegrationConfig | string = {}) {
		// Handle string parameter for backward compatibility
		if (typeof config === "string") {
			this.config = {
				embeddingApiKey: config,
				maxBackupsPerFile: 10,
				semanticThreshold: 0.82,
				structuralThreshold: 0.7,
				enableAstCaching: true,
			}
		} else {
			// Set defaults for config
			this.config = {
				embeddingApiKey: config.embeddingApiKey || "",
				maxBackupsPerFile: config.maxBackupsPerFile || 10,
				semanticThreshold: config.semanticThreshold || 0.82,
				structuralThreshold: config.structuralThreshold || 0.7,
				enableAstCaching: config.enableAstCaching !== false,
			}
		}

		// Initialize services
		this.astProvider = AstProvider.getInstance()
		this.rollbackManager = AstRollbackManager.getInstance()
		this.cacheManager = new AstCacheManager()

		// If a custom limit is set, apply it
		if (typeof config === "object" && config.maxBackupsPerFile) {
			this.rollbackManager.setMaxBackupsPerFile(this.config.maxBackupsPerFile)
		}

		if (this.config.embeddingApiKey) {
			this.embeddingService = new NebiusEmbeddingService(this.config.embeddingApiKey)
			this.validator = new SemanticValidator(this.config.embeddingApiKey)
		} else {
			logger.warn("No embedding API key provided. Semantic validation will be limited.")
			this.embeddingService = new NebiusEmbeddingService("")
			this.validator = new SemanticValidator("")
		}

		// Configure caching
		if (!this.config.enableAstCaching) {
			this.cacheManager.disableCache()
		}
	}

	/**
	 * Initialize the AST services
	 */
	public async initialize(): Promise<void> {
		if (this.initialized) return

		try {
			await this.astProvider.initialize()
			this.initialized = true
			logger.info("AST Integration initialized successfully")
		} catch (error) {
			logger.error("Failed to initialize AST Integration:", error)
			throw error
		}
	}

	/**
	 * Modify a function body in a file
	 * @param cwd Current working directory
	 * @param filePath Relative path to the file
	 * @param functionIdentifier Identifier for the function (name:line)
	 * @param newBody New function body text
	 */
	public async modifyFunctionBody(
		cwd: string,
		filePath: string,
		functionIdentifier: string,
		newBody: string,
	): Promise<ModificationResult> {
		try {
			await this.initialize()

			// Get absolute path
			const absolutePath = path.resolve(cwd, filePath)

			// Check if file exists
			try {
				await fs.access(absolutePath)
			} catch {
				throw AstErrorHandler.createError(AstErrorCode.GENERAL_ERROR, `File does not exist: ${filePath}`, {
					filepath: filePath,
				})
			}

			// Read original content
			const originalContent = await fs.readFile(absolutePath, "utf-8")

			// Create a backup
			await this.rollbackManager.createBackup(filePath, absolutePath, "modify_function_body")

			// Try to reconstruct content with the modified function
			const reconstructedContent = await reconstructContentWithModifiedFunction(
				originalContent,
				functionIdentifier,
				newBody,
				filePath,
			)

			if (!reconstructedContent) {
				throw AstErrorHandler.createError(
					AstErrorCode.NODE_NOT_FOUND,
					`Failed to reconstruct content with modified function: ${functionIdentifier}`,
					{
						filepath: filePath,
						node: { type: "function", identifier: functionIdentifier },
					},
				)
			}

			// Validate modifications using AST diff
			const modifications = await getFunctionModifications(
				originalContent,
				reconstructedContent,
				filePath,
				this.embeddingService,
			)

			if (!modifications || modifications.length === 0) {
				throw AstErrorHandler.createError(
					AstErrorCode.STRUCTURAL_VALIDATION_FAILED,
					`Changes to function ${functionIdentifier} failed validation`,
					{
						filepath: filePath,
						node: { type: "function", identifier: functionIdentifier },
						originalContent,
					},
				)
			}

			// All checks passed, write the modified content
			await fs.writeFile(absolutePath, reconstructedContent, "utf-8")

			// Invalidate the cache for this file
			this.cacheManager.invalidateFile(absolutePath)

			return {
				success: true,
				message: `Successfully modified function body for ${functionIdentifier}`,
			}
		} catch (error) {
			return this.handleEditError(error, filePath)
		}
	}

	/**
	 * Handle error in the edit process
	 * @param error Error object
	 * @param filePath File path where the error occurred
	 */
	private async handleEditError(error: any, filePath: string): Promise<ModificationResult> {
		logger.error(`Failed to edit ${filePath}`, error)

		try {
			// Check if it's an AST error
			const isAstError = AstErrorHandler.isAstError(error)
			const astError = isAstError
				? error
				: AstErrorHandler.createError(
						AstErrorCode.GENERAL_ERROR,
						`Error modifying function body: ${error instanceof Error ? error.message : String(error)}`,
						{ filepath: filePath, details: { stack: error instanceof Error ? error.stack : undefined } },
					)

			// Get fallback action
			const fallback = AstErrorHandler.handleEditFailure(astError)

			// Try to roll back if appropriate
			if (
				astError.code === AstErrorCode.STRUCTURAL_VALIDATION_FAILED ||
				astError.code === AstErrorCode.SEMANTIC_VALIDATION_FAILED
			) {
				const didRollback = await this.rollbackManager.rollback(filePath)
				logger.info(didRollback ? "Rollback successful" : "Rollback not performed")
			}

			// Build the error result
			return {
				success: false,
				message: `${fallback.message}${fallback.suggestedAction ? ` ${fallback.suggestedAction}` : ""}`,
				validationDetails: astError.details?.stack,
				error: astError,
			}
		} catch (e) {
			// If error handling itself fails, provide a backup error message
			logger.error("Error during error handling", e)
			return {
				success: false,
				message: `Failed to edit code: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}

	/**
	 * Validate a function body change without applying it
	 * @param filePath Relative path to the file
	 * @param functionIdentifier Identifier of function to modify
	 * @param newBody New function body
	 * @param options Validation options
	 */
	public async validateFunctionBodyChange(
		filePath: string,
		functionIdentifier: string,
		newBody: string,
		options?: Partial<ValidationOptions>,
	): Promise<{
		isValid: boolean
		message: string
		semanticScore?: number
		structuralScore?: number
	}> {
		try {
			// Normalize file path
			const absolutePath = path.resolve(filePath)

			// Ensure file exists
			await fs.access(absolutePath, fs.constants.F_OK)

			// Read original content
			const originalContent = await fs.readFile(absolutePath, "utf8")

			// Get function node
			const functionNode = await this.astProvider.getNodeWithIdentifier(absolutePath, functionIdentifier)

			if (!functionNode) {
				return {
					isValid: false,
					message: `Could not find function with identifier ${functionIdentifier}`,
				}
			}

			// Validate the change
			if (this.embeddingService) {
				return this.validator.validateFunctionBodyChange(originalContent, functionNode, newBody, options)
			} else {
				// If no embedding service, we can only do structural validation
				return this.validator.validateFunctionBodyChange(originalContent, functionNode, newBody, {
					...options,
					skipSemanticValidation: true,
				})
			}
		} catch (error) {
			logger.error("Failed to validate function body change", error)
			return {
				isValid: false,
				message: `Failed to validate function body change: ${
					error instanceof Error ? error.message : String(error)
				}`,
			}
		}
	}

	/**
	 * Update configuration settings
	 * @param config New configuration options
	 */
	public updateConfig(config: Partial<ClineAstIntegrationConfig>): void {
		// Update config values
		if (config.embeddingApiKey !== undefined) {
			this.config.embeddingApiKey = config.embeddingApiKey
			// Recreate services that depend on API key
			this.embeddingService = new NebiusEmbeddingService(this.config.embeddingApiKey)
			this.validator = new SemanticValidator(this.config.embeddingApiKey)
		}

		if (config.maxBackupsPerFile !== undefined) {
			this.config.maxBackupsPerFile = config.maxBackupsPerFile
			this.rollbackManager.setMaxBackupsPerFile(config.maxBackupsPerFile)
		}

		if (config.semanticThreshold !== undefined) {
			this.config.semanticThreshold = config.semanticThreshold
		}

		if (config.structuralThreshold !== undefined) {
			this.config.structuralThreshold = config.structuralThreshold
		}

		if (config.enableAstCaching !== undefined) {
			this.config.enableAstCaching = config.enableAstCaching
			// Apply caching setting
			this.cacheManager.enableCache()
		}

		logger.info("AST Integration configuration updated")
	}

	/**
	 * Get current configuration
	 */
	public getConfig(): Required<ClineAstIntegrationConfig> {
		return { ...this.config } // Return a copy to prevent direct modification
	}

	/**
	 * Roll back a previous change
	 * @param filePath Relative path to the file
	 */
	public async rollbackChange(filePath: string): Promise<ModificationResult> {
		try {
			const result = await this.rollbackManager.rollback(filePath)
			if (result) {
				logger.info(`Successfully rolled back changes to ${filePath}`)
				// Invalidate cache after rollback
				this.cacheManager.invalidateFile(filePath)
				return {
					success: true,
					message: `Successfully rolled back changes to ${filePath}`,
				}
			}

			logger.warn(`No backups found for ${filePath}`)
			return {
				success: false,
				message: `Failed to roll back changes to ${filePath} - no backups found`,
			}
		} catch (error) {
			logger.error(`Failed to roll back changes to ${filePath}`, error)
			return {
				success: false,
				message: `Failed to roll back changes to ${filePath} - ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}

	/**
	 * Get information about backups for a file
	 * @param filePath Relative path to the file
	 */
	public getBackupInfo(filePath: string): {
		hasBackups: boolean
		count: number
		operations: string[]
	} {
		try {
			const backupInfo = this.rollbackManager.getBackupInfo(filePath)
			return {
				hasBackups: backupInfo.length > 0,
				count: backupInfo.length,
				operations: backupInfo.map((b) => b.operation),
			}
		} catch (error) {
			logger.error(`Failed to get backup info for ${filePath}`, error)
			return {
				hasBackups: false,
				count: 0,
				operations: [],
			}
		}
	}

	/**
	 * Get all related files that may be affected by changes to a file
	 * @param filePath Relative path to the file
	 */
	public getRelatedFiles(filePath: string): string[] {
		const relatedFiles = this.astProvider.getRelatedFiles(filePath)
		return Array.from(relatedFiles)
	}
}
