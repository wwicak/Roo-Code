import Parser from "web-tree-sitter"
import * as path from "path"
import * as fs from "fs/promises"
import { loadRequiredLanguageParsers } from "../../services/tree-sitter/languageParser"
import { SymbolDatabase } from "./SymbolDatabase"
import { AstCacheManager } from "./AstCacheManager"
import { logger } from "../../utils/logging"
import { AstErrorHandler, AstErrorCode } from "./AstErrorHandler"

export interface AstNode {
	type: string
	text: string
	start: Parser.Point
	end: Parser.Point
	children: AstNode[]
}

/**
 * AstProvider service responsible for parsing code into ASTs and managing related operations
 */
export class AstProvider {
	private static instance: AstProvider
	private parserPool = new Map<string, Parser>()
	private activeTrees = new Map<string, Parser.Tree>()
	private symbolDb: SymbolDatabase
	private cacheManager: AstCacheManager
	private initialized = false
	private cacheEnabled = true

	private constructor() {
		this.symbolDb = new SymbolDatabase()
		this.cacheManager = new AstCacheManager()
	}

	public static getInstance(): AstProvider {
		if (!AstProvider.instance) {
			AstProvider.instance = new AstProvider()
		}
		return AstProvider.instance
	}

	/**
	 * Enable or disable AST caching
	 * @param enabled Whether caching should be enabled
	 */
	public setCacheEnabled(enabled: boolean): void {
		this.cacheEnabled = enabled
		if (!enabled) {
			// Clear existing cache if disabling
			this.cacheManager.clearCache()
			logger.info("AST caching disabled and cache cleared")
		} else {
			logger.info("AST caching enabled")
		}
	}

	/**
	 * Check if caching is currently enabled
	 */
	public isCacheEnabled(): boolean {
		return this.cacheEnabled
	}

	/**
	 * Initialize the Parser
	 */
	public async initialize(): Promise<void> {
		if (this.initialized) return

		try {
			await Parser.init()
			this.initialized = true
			logger.info("AST Provider initialized successfully")
		} catch (error) {
			logger.error("Failed to initialize AST Provider:", error)
			throw error
		}
	}

	/**
	 * Parse a file into an AST
	 * @param filePath Path to the file
	 * @param content Optional file content (if already read)
	 * @returns The parsed AST or null if parsing failed
	 */
	public async parseFile(filePath: string, content?: string): Promise<Parser.Tree | null> {
		await this.initialize()

		try {
			// Check cache first if caching is enabled
			if (this.cacheEnabled) {
				const cachedTree = await this.cacheManager.getCachedTree(filePath)
				if (cachedTree) {
					return cachedTree
				}
			}

			// Read file content if not provided
			if (!content) {
				try {
					content = await fs.readFile(filePath, "utf-8")
				} catch (error) {
					// Handle file read errors more explicitly
					logger.error(`Error reading file ${filePath}:`, error)
					throw AstErrorHandler.createError(
						AstErrorCode.GENERAL_ERROR,
						`Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
						{
							filepath: filePath,
						},
					)
				}
			}

			// Get language parser
			const ext = path.extname(filePath).slice(1) // Remove the leading dot

			// Check file extension validity
			if (!ext) {
				throw AstErrorHandler.createError(AstErrorCode.PARSER_NOT_FOUND, `File has no extension`, {
					filepath: filePath,
				})
			}

			// Load language parsers with better error handling
			let languageParsers
			try {
				languageParsers = await loadRequiredLanguageParsers([filePath])
			} catch (error) {
				throw AstErrorHandler.createError(
					AstErrorCode.PARSER_NOT_FOUND,
					`Failed to load language parsers: ${error instanceof Error ? error.message : String(error)}`,
					{
						filepath: filePath,
						details: { extension: ext },
					},
				)
			}

			const languageParser = languageParsers[ext]

			if (!languageParser) {
				throw AstErrorHandler.createError(
					AstErrorCode.PARSER_NOT_FOUND,
					`No parser available for extension: ${ext}`,
					{
						filepath: filePath,
						details: { extension: ext },
					},
				)
			}

			// Parse the file with robust error handling
			let tree: Parser.Tree
			try {
				tree = languageParser.parser.parse(content)

				// Check for parse errors in the tree
				const parseErrors = this.findParseErrors(tree.rootNode)
				if (parseErrors.length > 0) {
					throw AstErrorHandler.createError(
						AstErrorCode.PARSE_ERROR,
						`File contains ${parseErrors.length} syntax error(s)`,
						{
							filepath: filePath,
							errorNodes: parseErrors.map((node) => ({
								startPosition: node.startPosition,
								type: node.type,
							})),
						},
					)
				}
			} catch (error) {
				// Handle parsing errors
				if (AstErrorHandler.isAstError(error)) {
					throw error // Rethrow AstError
				}

				throw AstErrorHandler.createError(
					AstErrorCode.PARSE_ERROR,
					`Parsing failed: ${error instanceof Error ? error.message : String(error)}`,
					{
						filepath: filePath,
					},
				)
			}

			// Cache the result if caching is enabled
			this.activeTrees.set(filePath, tree)
			if (this.cacheEnabled) {
				await this.cacheManager.cacheTree(filePath, tree, content)
			}

			// Update symbol database
			this.symbolDb.updateFileSymbols(filePath, tree)

			return tree
		} catch (error) {
			// Convert general errors to AstError format for consistent handling
			const astError = AstErrorHandler.isAstError(error) ? error : AstErrorHandler.fromError(error, filePath)

			// Convert to appropriate log meta format
			const logMeta = {
				error: astError,
				code: astError.code,
				filepath: astError.filepath,
			}

			logger.error(`Error parsing file ${filePath}:`, logMeta)

			// Propagate the error so it can be handled upstream
			throw astError
		}
	}

	/**
	 * Recursively find syntax error nodes in the parse tree
	 * @param node The root node to search
	 * @returns Array of error nodes
	 */
	private findParseErrors(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
		const errors: Parser.SyntaxNode[] = []

		// Check if this node is an error
		if (node.type === "ERROR" || node.hasError) {
			errors.push(node)
		}

		// Recursively check children
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i)
			if (child) {
				errors.push(...this.findParseErrors(child))
			}
		}

		return errors
	}

	/**
	 * Convert a Parser.SyntaxNode to a serializable AstNode
	 */
	public serializeAst(node: Parser.SyntaxNode): AstNode {
		return {
			type: node.type,
			text: node.text,
			start: node.startPosition,
			end: node.endPosition,
			children: node.children.map((child) => this.serializeAst(child)),
		}
	}

	/**
	 * Find a node in a file by its identifier (e.g., "functionName:42")
	 */
	public async getNodeWithIdentifier(filePath: string, identifier: string): Promise<Parser.SyntaxNode | null> {
		const tree = await this.parseFile(filePath)
		if (!tree) return null

		// Parse the identifier - expected format is "name:line"
		const [name, lineStr] = identifier.split(":")
		const line = parseInt(lineStr, 10) - 1 // Convert to 0-based

		if (isNaN(line)) return null

		function findNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
			// Check if this is the target node
			const nameNode =
				node.childForFieldName("name") || node.childForFieldName("id") || node.childForFieldName("identifier")

			if (
				nameNode &&
				nameNode.text === name &&
				node.startPosition.row === line &&
				(node.type === "function_declaration" ||
					node.type === "function_definition" ||
					node.type === "method_definition" ||
					node.type === "class_method" ||
					node.type === "method")
			) {
				return node
			}

			// Check for class methods (ClassName.methodName)
			if (name.includes(".")) {
				const [className, methodName] = name.split(".")

				if (node.type === "method_definition" || node.type === "class_method" || node.type === "method") {
					const methodNameNode =
						node.childForFieldName("name") ||
						node.childForFieldName("id") ||
						node.childForFieldName("identifier")

					if (methodNameNode && methodNameNode.text === methodName && node.startPosition.row === line) {
						// Check if this method is inside the correct class
						let parentNode = node.parent
						while (parentNode) {
							if (
								parentNode.type === "class_declaration" ||
								parentNode.type === "class" ||
								parentNode.type === "class_definition"
							) {
								const classNameNode =
									parentNode.childForFieldName("name") || parentNode.childForFieldName("id")

								if (classNameNode && classNameNode.text === className) {
									return node
								}
								break
							}
							parentNode = parentNode.parent
						}
					}
				}
			}

			// Recursively search in children
			for (const child of node.children) {
				const result = findNode(child)
				if (result) return result
			}

			return null
		}

		return findNode(tree.rootNode)
	}

	/**
	 * Get the symbol database
	 */
	public getSymbolDatabase(): SymbolDatabase {
		return this.symbolDb
	}

	/**
	 * Invalidate cached data for a file
	 */
	public invalidateFile(filePath: string): void {
		this.activeTrees.delete(filePath)
		this.cacheManager.invalidateFile(filePath)
		this.symbolDb.removeFile(filePath)
	}

	/**
	 * Get all related files that might be affected by changes to the given file
	 */
	public getRelatedFiles(filePath: string): Set<string> {
		return this.symbolDb.getRelatedFiles(filePath)
	}
}
