import { NebiusEmbeddingService } from "../../services/embedding/NebiusEmbeddingService"
import { AstProvider, AstNode } from "./AstService"
import { logger } from "../../utils/logging"
import { cosineSimilarity } from "../../utils/cosineSimilarity"
import Parser from "web-tree-sitter"

/**
 * Options for validating code changes
 */
export interface ValidationOptions {
	semanticThreshold?: number // Threshold for semantic similarity (0-1)
	structuralThreshold?: number // Threshold for structural similarity (0-1)
	validateImports?: boolean // Whether to validate import statements
	skipTypes?: string[] // Node types to skip when validating
	skipSemanticValidation?: boolean // Whether to skip semantic validation
}

export interface ValidationResult {
	isValid: boolean
	semanticScore?: number
	structuralScore?: number
	error?: string
	node?: AstNode
}

/**
 * Service for validating code changes semantically and structurally
 */
export class SemanticValidator {
	private embeddingService: NebiusEmbeddingService
	private astProvider: AstProvider

	constructor(apiKey: string = "") {
		this.embeddingService = new NebiusEmbeddingService(apiKey)
		this.astProvider = AstProvider.getInstance()
	}

	/**
	 * Validate a code change
	 * @param original Original code
	 * @param modified Modified code
	 * @param options Validation options
	 */
	public async validateChange(
		original: string,
		modified: string,
		options: ValidationOptions = {},
	): Promise<ValidationResult> {
		// Set default options
		const semanticThreshold = options.semanticThreshold ?? 0.85
		const structuralThreshold = options.structuralThreshold ?? 0.7

		try {
			// Semantic validation with embeddings
			if (!options.skipSemanticValidation) {
				const semanticResult = await this.validateSemantic(original, modified, semanticThreshold)
				if (!semanticResult.isValid) {
					return semanticResult
				}
			}

			// Structural validation with AST
			const structuralResult = await this.validateStructural(original, modified, structuralThreshold, options)

			// Combine results - if both pass, return the combined result
			if (options.skipSemanticValidation || semanticThreshold === 1) {
				return {
					isValid: true,
					structuralScore: structuralResult.structuralScore,
				}
			} else if (structuralResult.isValid) {
				return {
					isValid: true,
					semanticScore: 1.0,
					structuralScore: structuralResult.structuralScore,
				}
			}

			// Return the failed validation result
			return structuralResult.isValid ? { isValid: false, semanticScore: 0.0 } : structuralResult
		} catch (error) {
			logger.error("Error validating code change:", error)
			return {
				isValid: false,
				error: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}

	/**
	 * Validate the semantic similarity of code changes
	 */
	private async validateSemantic(original: string, modified: string, threshold: number): Promise<ValidationResult> {
		// Skip if the texts are identical
		if (original === modified) {
			return {
				isValid: true,
				semanticScore: 1.0,
			}
		}

		// Get embeddings for both texts
		const [originalEmbedding, modifiedEmbedding] = await Promise.all([
			this.embeddingService.embedText(original),
			this.embeddingService.embedText(modified),
		])

		if (!originalEmbedding || !modifiedEmbedding) {
			return {
				isValid: false,
				error: "Failed to generate embeddings for code",
			}
		}

		// Calculate cosine similarity
		const similarity = cosineSimilarity(originalEmbedding, modifiedEmbedding)
		logger.debug(`Semantic similarity score: ${similarity.toFixed(4)}`)

		return {
			isValid: similarity >= threshold,
			semanticScore: similarity,
			error:
				similarity < threshold
					? `Semantic similarity too low: ${similarity.toFixed(4)} < ${threshold}`
					: undefined,
		}
	}

	/**
	 * Validate the structural similarity of code changes using AST
	 */
	private async validateStructural(
		original: string,
		modified: string,
		threshold: number,
		options: ValidationOptions,
	): Promise<ValidationResult> {
		try {
			// Create a temporary parser for this validation
			const parser = new Parser()
			await Parser.init()

			// Load JavaScript language (as a common language)
			// In a real implementation, we'd detect the language from the code
			const Lang = await Parser.Language.load("tree-sitter-javascript.wasm")
			parser.setLanguage(Lang)

			// Parse both texts
			const originalTree = parser.parse(original)
			const modifiedTree = parser.parse(modified)

			// Compare the structure
			const { similarity, invalidNode } = this.compareAstStructure(
				originalTree.rootNode,
				modifiedTree.rootNode,
				options.skipTypes || [],
			)

			logger.debug(`Structural similarity score: ${similarity.toFixed(4)}`)

			if (similarity < threshold && invalidNode) {
				return {
					isValid: false,
					structuralScore: similarity,
					error: `Structural similarity too low: ${similarity.toFixed(4)} < ${threshold}`,
					node: this.astProvider.serializeAst(invalidNode),
				}
			}

			return {
				isValid: true,
				structuralScore: similarity,
			}
		} catch (error) {
			logger.error("Error in structural validation:", error)
			return {
				isValid: false,
				error: `Structural validation error: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}

	/**
	 * Compare the structure of two AST nodes
	 */
	private compareAstStructure(
		original: Parser.SyntaxNode,
		modified: Parser.SyntaxNode,
		skipTypes: string[],
	): { similarity: number; invalidNode?: Parser.SyntaxNode } {
		// Skip comments and certain node types
		if (
			original.type.includes("comment") ||
			modified.type.includes("comment") ||
			skipTypes.includes(original.type) ||
			skipTypes.includes(modified.type)
		) {
			return { similarity: 1.0 }
		}

		// If types don't match, that's a significant structural change
		if (original.type !== modified.type) {
			return { similarity: 0.0, invalidNode: modified }
		}

		// If leaf nodes (no children), compare text
		if (original.childCount === 0 && modified.childCount === 0) {
			// Identical text is perfect match
			if (original.text === modified.text) {
				return { similarity: 1.0 }
			}

			// For identifiers, we're more strict about changes
			if (original.type === "identifier" || original.type.includes("name")) {
				return { similarity: 0.5, invalidNode: modified }
			}

			// For other leaf nodes, we're more lenient
			return { similarity: 0.8 }
		}

		// If different number of children, reduce similarity proportionally
		const childCountDiff = Math.abs(original.childCount - modified.childCount)
		const maxChildCount = Math.max(original.childCount, modified.childCount)

		if (childCountDiff > 0) {
			// If more than 50% of children changed count, it's a significant change
			if (childCountDiff > maxChildCount / 2) {
				return { similarity: 0.5, invalidNode: modified }
			}
		}

		// Compare children recursively
		const minChildCount = Math.min(original.childCount, modified.childCount)
		let totalSimilarity = 0
		let lowestChildSimilarity = 1.0
		let invalidChildNode: Parser.SyntaxNode | undefined

		for (let i = 0; i < minChildCount; i++) {
			const originalChild = original.child(i)
			const modifiedChild = modified.child(i)

			// Skip null nodes
			if (!originalChild || !modifiedChild) continue

			// Recursively compare child nodes
			const { similarity, invalidNode } = this.compareAstStructure(originalChild, modifiedChild, skipTypes)

			totalSimilarity += similarity

			// Track the lowest similarity and corresponding node
			if (similarity < lowestChildSimilarity) {
				lowestChildSimilarity = similarity
				invalidChildNode = invalidNode
			}
		}

		// Calculate average similarity of compared children
		const avgSimilarity = minChildCount > 0 ? totalSimilarity / minChildCount : 1.0

		// Factor in the difference in child count
		const childCountFactor = maxChildCount > 0 ? minChildCount / maxChildCount : 1.0

		// The final similarity is weighted between average child similarity and child count difference
		const finalSimilarity = avgSimilarity * 0.8 + childCountFactor * 0.2

		return {
			similarity: finalSimilarity,
			invalidNode: lowestChildSimilarity < 0.7 ? invalidChildNode : undefined,
		}
	}

	/**
	 * Validate a specific node change
	 */
	public async validateNodeChange(
		filePath: string,
		nodeIdentifier: string,
		newCode: string,
		options: ValidationOptions = {},
	): Promise<ValidationResult> {
		try {
			// Get the original node
			const node = await this.astProvider.getNodeWithIdentifier(filePath, nodeIdentifier)
			if (!node) {
				return {
					isValid: false,
					error: `Node not found: ${nodeIdentifier}`,
				}
			}

			// Extract the original code for this node
			const originalCode = node.text

			// Validate the change
			return this.validateChange(originalCode, newCode, options)
		} catch (error) {
			logger.error(`Error validating node change (${nodeIdentifier}):`, error)
			return {
				isValid: false,
				error: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}

	/**
	 * Validate a function body change
	 * @param fileContent Original file content
	 * @param functionNode Function node to validate
	 * @param newBody New function body text
	 * @param options Validation options
	 */
	public async validateFunctionBodyChange(
		fileContent: string,
		functionNode: any,
		newBody: string,
		options?: Partial<ValidationOptions>,
	): Promise<{
		isValid: boolean
		message: string
		semanticScore?: number
		structuralScore?: number
	}> {
		try {
			// Extract the original body
			const originalBody = functionNode.childForFieldName?.("body")?.text || ""

			// Set validation options from config and any overrides
			const validationOptions: ValidationOptions = {
				semanticThreshold: 0.85, // Default values
				structuralThreshold: 0.7,
				...options,
			}

			// Validate the change
			const validationResult = await this.validateChange(originalBody, newBody, validationOptions)

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
				message: "Valid change",
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
}
