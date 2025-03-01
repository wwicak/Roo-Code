import Parser from "web-tree-sitter"
import { logger } from "../../utils/logging"
import path from "path"

/**
 * Error codes for AST-related errors
 */
export enum AstErrorCode {
	PARSER_NOT_FOUND = "AST_PARSER_NOT_FOUND",
	PARSE_ERROR = "AST_PARSE_ERROR",
	SYMBOL_NOT_FOUND = "AST_SYMBOL_NOT_FOUND",
	INCOMPATIBLE_EDIT = "AST_INCOMPATIBLE_EDIT",
	SEMANTIC_VALIDATION_FAILED = "AST_SEMANTIC_VALIDATION_FAILED",
	STRUCTURAL_VALIDATION_FAILED = "AST_STRUCTURAL_VALIDATION_FAILED",
	NODE_NOT_FOUND = "AST_NODE_NOT_FOUND",
	GENERAL_ERROR = "AST_GENERAL_ERROR",
	CACHE_ERROR = "AST_CACHE_ERROR",
	ROLLBACK_ERROR = "AST_ROLLBACK_ERROR",
	TIMEOUT_ERROR = "AST_TIMEOUT_ERROR",
	MEMORY_ERROR = "AST_MEMORY_ERROR",
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
	FATAL = "fatal",
	ERROR = "error",
	WARNING = "warning",
	INFO = "info",
}

/**
 * Structure for AST errors
 */
export interface AstError {
	code: AstErrorCode
	message: string
	filepath?: string
	severity?: ErrorSeverity
	timestamp?: number
	node?: {
		type: string
		identifier?: string
		line?: number
		column?: number
	}
	details?: Record<string, any>
	originalContent?: string
	errorNodes?: Array<{
		startPosition: Parser.Point
		type: string
	}>
	// Enhanced details for more specific error information
	enhancedDetails?: {
		fileExtension?: string // For PARSER_NOT_FOUND
		parseErrorLocation?: {
			// For PARSE_ERROR
			line: number
			column: number
			context?: string
		}
		nodeTypeSearched?: string // For NODE_NOT_FOUND
		structuralDifference?: string // For STRUCTURAL_VALIDATION_FAILED
		semanticCheckFailed?: string // For SEMANTIC_VALIDATION_FAILED
		memoryUsage?: {
			// For MEMORY_ERROR
			heapUsed: number
			heapTotal: number
		}
		timeoutDetails?: {
			// For TIMEOUT_ERROR
			operationName: string
			durationMs: number
			limit: number
		}
		recoveryAttempted?: boolean // Whether recovery was attempted
		recoverySuccessful?: boolean // Whether recovery was successful
	}
}

/**
 * Structure for edit fallback responses
 */
export interface EditFallback {
	status: "reverted" | "partial" | "alternative"
	message: string
	fallbackContent?: string
	errorLocations?: Array<{
		line: number
		column: number
	}>
	suggestedAction?: string
}

/**
 * Handler for AST-related errors
 */
export class AstErrorHandler {
	private static readonly MAX_RECOVERY_ATTEMPTS = 3
	private static recoveryAttempts = new Map<string, number>()

	/**
	 * Create a structured AST error
	 */
	public static createError(
		code: AstErrorCode,
		message: string,
		details?: Partial<Omit<AstError, "code" | "message">>,
	): AstError {
		const error: AstError = {
			code,
			message,
			severity: this.getSeverityForErrorCode(code),
			timestamp: Date.now(),
			...details,
		}

		// Add enhanced details based on error code
		if (!error.enhancedDetails) {
			error.enhancedDetails = {}
		}

		// Populate enhanced details based on error code and available information
		switch (code) {
			case AstErrorCode.PARSER_NOT_FOUND:
				if (error.filepath) {
					const ext = path.extname(error.filepath).slice(1)
					error.enhancedDetails.fileExtension = ext
				}
				break

			case AstErrorCode.PARSE_ERROR:
				if (error.errorNodes && error.errorNodes.length > 0) {
					const firstErrorNode = error.errorNodes[0]
					error.enhancedDetails.parseErrorLocation = {
						line: firstErrorNode.startPosition.row + 1, // Convert to 1-indexed
						column: firstErrorNode.startPosition.column + 1, // Convert to 1-indexed
					}

					// Add context if original content is available
					if (error.originalContent) {
						const lines = error.originalContent.split("\n")
						const errorLine = firstErrorNode.startPosition.row
						const startLine = Math.max(0, errorLine - 2)
						const endLine = Math.min(lines.length - 1, errorLine + 2)

						let context = ""
						for (let i = startLine; i <= endLine; i++) {
							const linePrefix = i === errorLine ? "> " : "  "
							context += `${linePrefix}${i + 1}: ${lines[i]}\n`
						}

						error.enhancedDetails.parseErrorLocation.context = context
					}
				}
				break

			case AstErrorCode.NODE_NOT_FOUND:
				if (error.node?.type) {
					error.enhancedDetails.nodeTypeSearched = error.node.type
				}
				break

			case AstErrorCode.STRUCTURAL_VALIDATION_FAILED:
				// Extract structural difference information if available in details
				if (error.details?.difference) {
					error.enhancedDetails.structuralDifference = error.details.difference
				}
				break

			case AstErrorCode.SEMANTIC_VALIDATION_FAILED:
				// Extract semantic check information if available in details
				if (error.details?.check) {
					error.enhancedDetails.semanticCheckFailed = error.details.check
				}
				break

			case AstErrorCode.MEMORY_ERROR:
				// Add memory usage information
				if (error.details?.memoryUsage) {
					error.enhancedDetails.memoryUsage = error.details.memoryUsage
				} else {
					// Get current memory usage
					const memoryUsage = process.memoryUsage()
					error.enhancedDetails.memoryUsage = {
						heapUsed: memoryUsage.heapUsed,
						heapTotal: memoryUsage.heapTotal,
					}
				}
				break

			case AstErrorCode.TIMEOUT_ERROR:
				// Add timeout details
				if (error.details?.timeoutDetails) {
					error.enhancedDetails.timeoutDetails = error.details.timeoutDetails
				}
				break
		}

		// Log the error with appropriate severity level
		const logMethod = this.getLogMethodForSeverity(error.severity || ErrorSeverity.ERROR)
		logMethod(`AST Error [${code}]: ${message}`, {
			filepath: error.filepath,
			node: error.node,
			details: error.details,
			enhancedDetails: error.enhancedDetails,
			timestamp: error.timestamp,
			severity: error.severity,
		})

		return error
	}

	/**
	 * Get the appropriate severity level for an error code
	 */
	private static getSeverityForErrorCode(code: AstErrorCode): ErrorSeverity {
		switch (code) {
			case AstErrorCode.PARSER_NOT_FOUND:
			case AstErrorCode.PARSE_ERROR:
			case AstErrorCode.MEMORY_ERROR:
			case AstErrorCode.TIMEOUT_ERROR:
				return ErrorSeverity.FATAL

			case AstErrorCode.SYMBOL_NOT_FOUND:
			case AstErrorCode.NODE_NOT_FOUND:
			case AstErrorCode.ROLLBACK_ERROR:
				return ErrorSeverity.ERROR

			case AstErrorCode.INCOMPATIBLE_EDIT:
			case AstErrorCode.STRUCTURAL_VALIDATION_FAILED:
			case AstErrorCode.SEMANTIC_VALIDATION_FAILED:
				return ErrorSeverity.WARNING

			case AstErrorCode.CACHE_ERROR:
				return ErrorSeverity.INFO

			default:
				return ErrorSeverity.ERROR
		}
	}

	/**
	 * Get the appropriate logger method based on severity
	 */
	private static getLogMethodForSeverity(severity: ErrorSeverity): (message: string, meta?: any) => void {
		switch (severity) {
			case ErrorSeverity.FATAL:
			case ErrorSeverity.ERROR:
				return logger.error
			case ErrorSeverity.WARNING:
				return logger.warn
			case ErrorSeverity.INFO:
				return logger.info
			default:
				return logger.error
		}
	}

	/**
	 * Handle an edit failure and provide a fallback
	 */
	public static handleEditFailure(error: AstError): EditFallback {
		switch (error.code) {
			case AstErrorCode.STRUCTURAL_VALIDATION_FAILED:
				return {
					status: "reverted",
					message: `Edit rejected: would change function signature or structure (${error.message})`,
					fallbackContent: error.originalContent,
					suggestedAction: error.enhancedDetails?.structuralDifference
						? `Modify only the function body without changing ${error.enhancedDetails.structuralDifference}`
						: "Modify only the function body without changing parameters or return type",
				}

			case AstErrorCode.SEMANTIC_VALIDATION_FAILED:
				return {
					status: "reverted",
					message: `Edit rejected: semantic validation failed (${error.message})`,
					fallbackContent: error.originalContent,
					suggestedAction: error.enhancedDetails?.semanticCheckFailed
						? `Ensure the edit preserves ${error.enhancedDetails.semanticCheckFailed}`
						: "Ensure the edit preserves the core functionality of the code",
				}

			case AstErrorCode.NODE_NOT_FOUND:
				return {
					status: "reverted",
					message: `Could not locate the target ${error.enhancedDetails?.nodeTypeSearched || "function/method"} (${error.message})`,
					suggestedAction:
						"Verify the function name and location are correct. Check for typos in the function name.",
				}

			case AstErrorCode.PARSER_NOT_FOUND:
				return {
					status: "reverted",
					message: `No parser available for file type ${error.enhancedDetails?.fileExtension ? `'.${error.enhancedDetails.fileExtension}'` : ""} (${error.message})`,
					suggestedAction:
						"This operation is only supported for TypeScript, JavaScript, Python, and other supported languages. Check the file extension or format.",
				}

			case AstErrorCode.PARSE_ERROR:
				const locationStr = error.enhancedDetails?.parseErrorLocation
					? ` at line ${error.enhancedDetails.parseErrorLocation.line}, column ${error.enhancedDetails.parseErrorLocation.column}`
					: ""

				let message = `Parsing error${locationStr}: ${error.message}`
				if (error.enhancedDetails?.parseErrorLocation?.context) {
					message += `\n\nContext:\n${error.enhancedDetails.parseErrorLocation.context}`
				}

				return {
					status: "reverted",
					message,
					errorLocations: error.errorNodes?.map((n) => ({
						line: n.startPosition.row,
						column: n.startPosition.column,
					})),
					suggestedAction:
						"Fix syntax errors in the code before attempting this operation. Check for missing brackets, semicolons, or other syntax issues.",
				}

			case AstErrorCode.INCOMPATIBLE_EDIT:
				return {
					status: "alternative",
					message: `Edit could not be applied as an AST modification (${error.message})`,
					suggestedAction:
						"Consider using a text-based edit approach instead, or simplify your changes to make them more compatible with the AST structure.",
				}

			case AstErrorCode.CACHE_ERROR:
				return {
					status: "alternative",
					message: `Cache error: ${error.message}`,
					suggestedAction:
						"The operation will continue without using the cache. Consider clearing the cache if this issue persists.",
				}

			case AstErrorCode.ROLLBACK_ERROR:
				return {
					status: "reverted",
					message: `Rollback error: ${error.message}`,
					fallbackContent: error.originalContent,
					suggestedAction: "Manual intervention may be required to restore the file to its previous state.",
				}

			case AstErrorCode.TIMEOUT_ERROR:
				let timeoutMessage = `Operation timed out: ${error.message}`
				if (error.enhancedDetails?.timeoutDetails) {
					const { operationName, durationMs, limit } = error.enhancedDetails.timeoutDetails
					timeoutMessage += ` (${operationName} took ${durationMs}ms, limit: ${limit}ms)`
				}

				return {
					status: "reverted",
					message: timeoutMessage,
					fallbackContent: error.originalContent,
					suggestedAction: "Try simplifying the operation or breaking it into smaller parts.",
				}

			case AstErrorCode.MEMORY_ERROR:
				let memoryMessage = `Memory limit exceeded: ${error.message}`
				if (error.enhancedDetails?.memoryUsage) {
					const { heapUsed, heapTotal } = error.enhancedDetails.memoryUsage
					const usedMB = Math.round(heapUsed / 1024 / 1024)
					const totalMB = Math.round(heapTotal / 1024 / 1024)
					memoryMessage += ` (Used: ${usedMB}MB, Total: ${totalMB}MB)`
				}

				return {
					status: "reverted",
					message: memoryMessage,
					fallbackContent: error.originalContent,
					suggestedAction: "Try working with smaller files or simplifying the operation.",
				}

			default:
				return {
					status: "reverted",
					message: `Edit failed: ${error.message}`,
					fallbackContent: error.originalContent,
					errorLocations: error.errorNodes?.map((n) => ({
						line: n.startPosition.row,
						column: n.startPosition.column,
					})),
					suggestedAction:
						"Try a different approach or simplify the edit. Break the change into smaller, more manageable edits.",
				}
		}
	}

	/**
	 * Format an AstError into a user-friendly string
	 * @param error The error to format
	 * @returns A formatted string with error details
	 */
	public static formatErrorMessage(error: AstError): string {
		let message = `Error [${error.code}]: ${error.message}`

		if (error.severity) {
			message = `${error.severity.toUpperCase()}: ${message}`
		}

		if (error.filepath) {
			message += `\nFile: ${error.filepath}`
		}

		if (error.enhancedDetails) {
			const { enhancedDetails } = error

			if (enhancedDetails.parseErrorLocation) {
				message += `\nLocation: Line ${enhancedDetails.parseErrorLocation.line}, Column ${enhancedDetails.parseErrorLocation.column}`

				if (enhancedDetails.parseErrorLocation.context) {
					message += `\n\nContext:\n${enhancedDetails.parseErrorLocation.context}`
				}
			}

			if (enhancedDetails.nodeTypeSearched) {
				message += `\nSearched for: ${enhancedDetails.nodeTypeSearched}`
			}

			if (enhancedDetails.structuralDifference) {
				message += `\nStructural difference: ${enhancedDetails.structuralDifference}`
			}

			if (enhancedDetails.semanticCheckFailed) {
				message += `\nSemantic check failed: ${enhancedDetails.semanticCheckFailed}`
			}

			if (enhancedDetails.memoryUsage) {
				const { heapUsed, heapTotal } = enhancedDetails.memoryUsage
				const usedMB = Math.round(heapUsed / 1024 / 1024)
				const totalMB = Math.round(heapTotal / 1024 / 1024)
				message += `\nMemory usage: ${usedMB}MB / ${totalMB}MB`
			}

			if (enhancedDetails.timeoutDetails) {
				const { operationName, durationMs, limit } = enhancedDetails.timeoutDetails
				message += `\nOperation '${operationName}' timed out after ${durationMs}ms (limit: ${limit}ms)`
			}

			if (enhancedDetails.recoveryAttempted) {
				message += `\nRecovery attempted: ${enhancedDetails.recoverySuccessful ? "Successful" : "Failed"}`
			}
		}

		const fallback = this.handleEditFailure(error)
		if (fallback.suggestedAction) {
			message += `\n\nSuggested action: ${fallback.suggestedAction}`
		}

		return message
	}

	/**
	 * Attempt to recover from an AST error
	 */
	public static attemptRecovery(
		error: AstError,
		currentContent: string,
	): { recovered: boolean; content?: string; message?: string } {
		// Track recovery attempts for this file
		const fileKey = error.filepath || "unknown"
		const attempts = this.recoveryAttempts.get(fileKey) || 0

		// Update enhanced details to track recovery attempt
		if (!error.enhancedDetails) {
			error.enhancedDetails = {}
		}
		error.enhancedDetails.recoveryAttempted = true

		// Check if we've exceeded the maximum number of recovery attempts
		if (attempts >= this.MAX_RECOVERY_ATTEMPTS) {
			logger.warn(`Maximum recovery attempts (${this.MAX_RECOVERY_ATTEMPTS}) reached for ${fileKey}`)
			error.enhancedDetails.recoverySuccessful = false
			return {
				recovered: false,
				message: `Maximum recovery attempts (${this.MAX_RECOVERY_ATTEMPTS}) reached. Manual intervention required.`,
			}
		}

		// Increment the recovery attempts counter
		this.recoveryAttempts.set(fileKey, attempts + 1)

		// Attempt recovery based on error code
		switch (error.code) {
			case AstErrorCode.PARSE_ERROR:
				// For parse errors, we can try to fix common syntax issues
				if (error.originalContent && currentContent !== error.originalContent) {
					logger.info(
						`Attempting to recover from parse error by reverting to original content for ${fileKey}`,
					)
					error.enhancedDetails.recoverySuccessful = true
					return {
						recovered: true,
						content: error.originalContent,
						message: "Recovered by reverting to the original content before the edit.",
					}
				}

				// Cannot recover from parse errors without original content
				error.enhancedDetails.recoverySuccessful = false
				return {
					recovered: false,
					message: "Cannot recover from parse error without original content.",
				}

			case AstErrorCode.NODE_NOT_FOUND:
				// Cannot recover from missing nodes
				error.enhancedDetails.recoverySuccessful = false
				return {
					recovered: false,
					message: "Cannot recover from missing node error. The target node could not be found.",
				}

			case AstErrorCode.STRUCTURAL_VALIDATION_FAILED:
			case AstErrorCode.SEMANTIC_VALIDATION_FAILED:
				// Revert to original content if available
				if (error.originalContent) {
					logger.info(`Recovering from ${error.code} by reverting to original content for ${fileKey}`)
					error.enhancedDetails.recoverySuccessful = true
					return {
						recovered: true,
						content: error.originalContent,
						message: `Recovered from ${error.code} by reverting to the original content.`,
					}
				}

				error.enhancedDetails.recoverySuccessful = false
				return {
					recovered: false,
					message: "Cannot recover without original content.",
				}

			case AstErrorCode.CACHE_ERROR:
				// Cache errors can be ignored, operation can continue without cache
				logger.info(`Ignoring cache error for ${fileKey} and continuing without cache`)
				error.enhancedDetails.recoverySuccessful = true
				return {
					recovered: true,
					content: currentContent,
					message: "Continuing operation without using the cache.",
				}

			case AstErrorCode.TIMEOUT_ERROR:
				// For timeout errors, we can only revert to original content
				if (error.originalContent) {
					logger.info(`Recovering from timeout error by reverting to original content for ${fileKey}`)
					error.enhancedDetails.recoverySuccessful = true
					return {
						recovered: true,
						content: error.originalContent,
						message: "Recovered from timeout error by reverting to the original content.",
					}
				}

				error.enhancedDetails.recoverySuccessful = false
				return {
					recovered: false,
					message: "Cannot recover from timeout error without original content.",
				}

			case AstErrorCode.MEMORY_ERROR:
				// For memory errors, we can only revert to original content
				if (error.originalContent) {
					logger.info(`Recovering from memory error by reverting to original content for ${fileKey}`)
					error.enhancedDetails.recoverySuccessful = true
					return {
						recovered: true,
						content: error.originalContent,
						message: "Recovered from memory error by reverting to the original content.",
					}
				}

				error.enhancedDetails.recoverySuccessful = false
				return {
					recovered: false,
					message: "Cannot recover from memory error without original content.",
				}

			default:
				// For other errors, try to revert to original content if available
				if (error.originalContent) {
					logger.info(`Attempting general recovery by reverting to original content for ${fileKey}`)
					error.enhancedDetails.recoverySuccessful = true
					return {
						recovered: true,
						content: error.originalContent,
						message: "Recovered by reverting to the original content.",
					}
				}

				error.enhancedDetails.recoverySuccessful = false
				return {
					recovered: false,
					message: "Cannot recover without original content.",
				}
		}
	}

	/**
	 * Reset recovery attempts counter for a file
	 * @param filepath The file path to reset recovery attempts for
	 */
	public static resetRecoveryAttempts(filepath: string): void {
		this.recoveryAttempts.delete(filepath)
	}

	/**
	 * Translate a general Error to an AstError
	 */
	public static fromError(error: Error | unknown, filepath?: string): AstError {
		if (error instanceof Error) {
			return this.createError(AstErrorCode.GENERAL_ERROR, error.message, {
				filepath,
				details: {
					stack: error.stack,
					name: error.name,
				},
			})
		}

		return this.createError(AstErrorCode.GENERAL_ERROR, String(error), { filepath })
	}

	/**
	 * Check if an error is an AstError
	 */
	public static isAstError(error: unknown): error is AstError {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			"message" in error &&
			typeof (error as AstError).code === "string" &&
			typeof (error as AstError).message === "string"
		)
	}
}
