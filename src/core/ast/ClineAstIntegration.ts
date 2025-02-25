import * as path from "path"
import * as fs from "fs/promises"
import { AstProvider } from "./AstProvider"
import { AstErrorHandler, AstErrorCode, AstError } from "./AstErrorHandler"
import { AstRollbackManager } from "./AstRollbackManager"
import { SemanticValidator } from "./validation/SemanticValidator"
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
}

/**
 * Response interface for backup operations
 */
export interface BackupInfo {
	backups: string[]
	count: number
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
	private embeddingService: NebiusEmbeddingService | null = null
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
			this.validator = new SemanticValidator(this.embeddingService)
		} else {
			logger.warn("No embedding API key provided. Semantic validation will be limited.")
			this.validator = new SemanticValidator()
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
			// Handle errors
			const astError = AstErrorHandler.isAstError(error)
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

				if (didRollback) {
					logger.info(`Rolled back changes to ${filePath} due to validation failure`)
				}
			}

			return {
				success: false,
				message: `${fallback.message}${fallback.suggestedAction ? ` ${fallback.suggestedAction}` : ""}`,
				validationDetails: astError instanceof AstError ? astError.details?.stack : undefined,
			}
		}
	}

	/**
	 * Validate a potential function body change without applying it
	 * @param filePath Path to the file
	 * @param functionIdentifier Identifier for the function (name:line)
	 * @param newBody New function body text
	 * @param options Optional validation options to override defaults
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
			await this.initialize()

			// Find the node
			const node = await this.astProvider.getNodeWithIdentifier(filePath, functionIdentifier)

			if (!node) {
				return {
					isValid: false,
					message: `Function ${functionIdentifier} not found in ${filePath}`,
				}
			}

			// Extract the original code
			const originalBody = node.childForFieldName("body")?.text || ""

			// Set validation options from config and any overrides
			const validationOptions: ValidationOptions = {
				semanticThreshold: this.config.semanticThreshold,
				structuralThreshold: this.config.structuralThreshold,
				...options,
			}

			// Validate the change
			const validationResult = await this.validator.validateChange(originalBody, newBody, validationOptions)

			if (!validationResult.isValid) {
				return {
					isValid: false,
					message: validationResult.error || "Validation failed",
					semanticScore: validationResult.semanticScore,
					structuralScore: validationResult.structuralScore,
				}
			}

			return {
				isValid: true,
				message: "Function body change is valid",
				semanticScore: validationResult.semanticScore,
				structuralScore: validationResult.structuralScore,
			}
		} catch (error) {
			logger.error(`Error validating function body change: ${error}`)
			return {
				isValid: false,
				message: `Error during validation: ${error instanceof Error ? error.message : String(error)}`,
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
	public async rollbackChange(filePath: string): Promise<boolean> {
		try {
			const result = await this.rollbackManager.rollback(filePath)
			if (result) {
				logger.info(`Successfully rolled back changes to ${filePath}`)
				// Invalidate cache after rollback
				this.cacheManager.invalidateFile(filePath)
				return true
			}

			logger.warn(`No backups found for ${filePath}`)
			return false
		} catch (error) {
			logger.error(`Failed to roll back changes to ${filePath}`, error)
			return false
		}
	}

	/**
	 * Get information about backups for a file
	 * @param filePath Relative path to the file
	 */
	public async getBackupInfo(filePath: string): Promise<BackupInfo> {
		try {
			const backups = await this.rollbackManager.getBackups(filePath)
			return {
				backups: backups.map((b) => b.timestamp.toISOString()),
				count: backups.length,
			}
		} catch (error) {
			logger.error(`Failed to get backup info for ${filePath}`, error)
			return {
				backups: [],
				count: 0,
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
