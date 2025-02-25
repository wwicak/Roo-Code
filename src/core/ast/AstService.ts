import Parser from "web-tree-sitter"
import * as path from "path"
import * as fs from "fs/promises"
import { loadRequiredLanguageParsers } from "../../services/tree-sitter/languageParser"
import { SymbolDatabase } from "./SymbolDatabase"
import { AstCacheManager } from "./AstCacheManager"
import { logger } from "../../utils/logging"

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
				const cachedTree = this.cacheManager.getCachedTree(filePath)
				if (cachedTree) {
					return cachedTree
				}
			}

			// Read file content if not provided
			if (!content) {
				content = await fs.readFile(filePath, "utf-8")
			}

			// Get language parser
			const ext = path.extname(filePath).slice(1) // Remove the leading dot
			const languageParsers = await loadRequiredLanguageParsers([filePath])
			const languageParser = languageParsers[ext]

			if (!languageParser) {
				logger.warn(`No parser available for extension: ${ext}`)
				return null
			}

			// Parse the file
			const tree = languageParser.parser.parse(content)

			// Cache the result if caching is enabled
			this.activeTrees.set(filePath, tree)
			if (this.cacheEnabled) {
				this.cacheManager.cacheTree(filePath, tree)
			}

			// Update symbol database
			this.symbolDb.updateFileSymbols(filePath, tree)

			return tree
		} catch (error) {
			logger.error(`Error parsing file ${filePath}:`, error)
			return null
		}
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
