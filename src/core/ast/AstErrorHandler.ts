import Parser from "web-tree-sitter"
import { logger } from "../../utils/logging"

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
}

/**
 * Structure for AST errors
 */
export interface AstError {
	code: AstErrorCode
	message: string
	filepath?: string
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
			...details,
		}

		// Log the error
		logger.error(`AST Error [${code}]: ${message}`, {
			filepath: error.filepath,
			node: error.node,
			details: error.details,
		})

		return error
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
					suggestedAction: "Modify only the function body without changing parameters or return type",
				}

			case AstErrorCode.SEMANTIC_VALIDATION_FAILED:
				return {
					status: "reverted",
					message: `Edit rejected: semantic validation failed (${error.message})`,
					fallbackContent: error.originalContent,
					suggestedAction: "Ensure the edit preserves the core functionality of the code",
				}

			case AstErrorCode.NODE_NOT_FOUND:
				return {
					status: "reverted",
					message: `Could not locate the target function/method (${error.message})`,
					suggestedAction: "Verify the function name and location are correct",
				}

			case AstErrorCode.PARSER_NOT_FOUND:
				return {
					status: "reverted",
					message: `No parser available for this file type (${error.message})`,
					suggestedAction:
						"This operation is only supported for TypeScript, JavaScript, Python, and other supported languages",
				}

			case AstErrorCode.PARSE_ERROR:
				return {
					status: "reverted",
					message: `Parsing error: ${error.message}`,
					errorLocations: error.errorNodes?.map((n) => ({
						line: n.startPosition.row,
						column: n.startPosition.column,
					})),
					suggestedAction: "Fix syntax errors in the code before attempting this operation",
				}

			case AstErrorCode.INCOMPATIBLE_EDIT:
				return {
					status: "alternative",
					message: `Edit could not be applied as an AST modification (${error.message})`,
					suggestedAction: "Consider using a text-based edit approach instead",
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
					suggestedAction: "Try a different approach or simplify the edit",
				}
		}
	}

	/**
	 * Attempt to recover from an AST error
	 */
	public static attemptRecovery(error: AstError, currentContent: string): { recovered: boolean; content?: string } {
		// For now, implement a simple recovery mechanism
		// More sophisticated recovery could be added in the future

		switch (error.code) {
			case AstErrorCode.PARSE_ERROR:
				// Cannot recover from parse errors without manual intervention
				return { recovered: false }

			case AstErrorCode.NODE_NOT_FOUND:
				// Cannot recover from missing nodes
				return { recovered: false }

			case AstErrorCode.STRUCTURAL_VALIDATION_FAILED:
			case AstErrorCode.SEMANTIC_VALIDATION_FAILED:
				// Revert to original content if available
				if (error.originalContent) {
					return {
						recovered: true,
						content: error.originalContent,
					}
				}
				return { recovered: false }

			default:
				return { recovered: false }
		}
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
