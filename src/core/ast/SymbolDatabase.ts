import Parser from "web-tree-sitter"
import { logger } from "../../utils/logging"

export interface Symbol {
	id: string // Unique identifier (e.g., "functionName:42")
	type: string // Type of symbol (e.g., "function", "class", "variable")
	name: string // Name of the symbol
	filePath: string // Path to the file where the symbol is defined
	startPosition: Parser.Point // Start position in the file
	endPosition: Parser.Point // End position in the file
	parentId?: string // ID of the parent symbol (if any)
	references: Set<string> // Set of file paths that reference this symbol
	dependencies: Set<string> // IDs of symbols this symbol depends on
}

/**
 * A database for tracking symbols across files
 */
export class SymbolDatabase {
	private symbols = new Map<string, Symbol>() // Map of symbol IDs to symbols
	private fileSymbols = new Map<string, Set<string>>() // Map of file paths to symbol IDs
	private fileReferences = new Map<string, Set<string>>() // Map of file paths to files that reference it

	/**
	 * Update symbols for a file
	 * @param filePath Path to the file
	 * @param tree The parsed AST
	 */
	public updateFileSymbols(filePath: string, tree: Parser.Tree): void {
		// Remove old symbols for this file
		this.removeFile(filePath)

		// Create a new set for this file's symbols
		const fileSymbolIds = new Set<string>()
		this.fileSymbols.set(filePath, fileSymbolIds)

		// Extract symbols from the tree
		this.extractSymbols(filePath, tree.rootNode, undefined, fileSymbolIds)

		// Process dependencies between symbols
		this.processDependencies(filePath, tree.rootNode)

		logger.debug(`Updated symbols for ${filePath}: found ${fileSymbolIds.size} symbols`)
	}

	/**
	 * Extract symbols from an AST node
	 */
	private extractSymbols(
		filePath: string,
		node: Parser.SyntaxNode,
		parentId: string | undefined,
		fileSymbolIds: Set<string>,
	): void {
		// Process different node types
		if (
			node.type === "function_declaration" ||
			node.type === "function_definition" ||
			node.type === "method_definition" ||
			node.type === "class_method" ||
			node.type === "method"
		) {
			const nameNode =
				node.childForFieldName("name") || node.childForFieldName("id") || node.childForFieldName("identifier")

			if (nameNode) {
				const name = nameNode.text
				const id = `${name}:${node.startPosition.row + 1}` // 1-indexed line number
				const type = node.type.includes("method") ? "method" : "function"

				this.addSymbol({
					id,
					type,
					name,
					filePath,
					startPosition: node.startPosition,
					endPosition: node.endPosition,
					parentId: parentId,
					references: new Set([filePath]),
					dependencies: new Set(),
				})

				fileSymbolIds.add(id)

				// Process the function body recursively
				for (const child of node.children) {
					if (child.type === "block" || child.type === "function_body") {
						this.extractSymbols(filePath, child, id, fileSymbolIds)
						break
					}
				}
			}
		} else if (
			node.type === "class_declaration" ||
			node.type === "class" ||
			node.type === "class_definition" ||
			node.type === "interface_declaration"
		) {
			const nameNode = node.childForFieldName("name") || node.childForFieldName("id")

			if (nameNode) {
				const name = nameNode.text
				const id = `${name}:${node.startPosition.row + 1}`
				const type = node.type.includes("interface") ? "interface" : "class"

				this.addSymbol({
					id,
					type,
					name,
					filePath,
					startPosition: node.startPosition,
					endPosition: node.endPosition,
					parentId: parentId,
					references: new Set([filePath]),
					dependencies: new Set(),
				})

				fileSymbolIds.add(id)

				// Process class members recursively
				const bodyNode = node.childForFieldName("body") || node.childForFieldName("class_body")
				if (bodyNode) {
					this.extractSymbols(filePath, bodyNode, id, fileSymbolIds)
				}
			}
		} else if (
			node.type === "variable_declaration" ||
			node.type === "constant_declaration" ||
			node.type === "let_declaration" ||
			node.type === "var_declaration"
		) {
			// Handle variable declarations
			const declarators =
				node.childForFieldName("declarators") || node.childForFieldName("declarations") || node.namedChildren

			if (declarators) {
				// Handle both single nodes and arrays
				const nodes = Array.isArray(declarators) ? declarators : [declarators]

				for (const declarator of nodes) {
					const nameNode =
						declarator.childForFieldName("name") ||
						declarator.childForFieldName("id") ||
						declarator.namedChild(0)

					if (nameNode) {
						const name = nameNode.text
						const id = `${name}:${node.startPosition.row + 1}`
						const type = "variable"

						this.addSymbol({
							id,
							type,
							name,
							filePath,
							startPosition: declarator.startPosition,
							endPosition: declarator.endPosition,
							parentId: parentId,
							references: new Set([filePath]),
							dependencies: new Set(),
						})

						fileSymbolIds.add(id)
					}
				}
			}
		}

		// Process all other children regardless of whether we extracted a symbol
		for (const child of node.children) {
			if (
				child.type !== "block" &&
				child.type !== "function_body" &&
				child.type !== "class_body" &&
				child.type !== "statement_block"
			) {
				this.extractSymbols(filePath, child, parentId, fileSymbolIds)
			}
		}
	}

	/**
	 * Process dependencies between symbols
	 */
	private processDependencies(filePath: string, node: Parser.SyntaxNode): void {
		// Create a map of file scope symbols by name for quick lookup
		const fileScopeSymbols = new Map<string, Symbol>()

		const fileSymbolIds = this.fileSymbols.get(filePath) || new Set<string>()
		for (const symbolId of fileSymbolIds) {
			const symbol = this.symbols.get(symbolId)
			if (symbol) {
				fileScopeSymbols.set(symbol.name, symbol)
			}
		}

		// Process identifier references
		const that = this // Capture 'this' for use in the function
		function processNode(node: Parser.SyntaxNode): void {
			if (node.type === "identifier" || node.type === "property_identifier") {
				const name = node.text
				if (fileScopeSymbols.has(name)) {
					const symbol = fileScopeSymbols.get(name)!

					// Find the current function/method/class
					let currentNode = node.parent
					while (currentNode) {
						const currentType = currentNode.type

						if (
							currentType === "function_declaration" ||
							currentType === "function_definition" ||
							currentType === "method_definition" ||
							currentType === "class_method" ||
							currentType === "method" ||
							currentType === "class_declaration" ||
							currentType === "class" ||
							currentType === "class_definition"
						) {
							const nameNode =
								currentNode.childForFieldName("name") ||
								currentNode.childForFieldName("id") ||
								currentNode.childForFieldName("identifier")

							if (nameNode) {
								const currentName = nameNode.text
								const currentId = `${currentName}:${currentNode.startPosition.row + 1}`

								if (currentId !== symbol.id) {
									// Don't add self-references
									const currentSymbol = Array.from(fileSymbolIds).find((id) => id === currentId)
									if (currentSymbol) {
										// Add dependency from current symbol to referenced symbol
										const symbolObj = that.symbols.get(currentSymbol)
										if (symbolObj) {
											symbolObj.dependencies.add(symbol.id)
										}
									}
								}
								break
							}
						}
						currentNode = currentNode.parent
					}
				}
			}

			// Recursively process children
			for (const child of node.children) {
				processNode(child)
			}
		}

		// Start processing from root
		processNode(node)
	}

	/**
	 * Add a symbol to the database
	 */
	private addSymbol(symbol: Symbol): void {
		this.symbols.set(symbol.id, symbol)
	}

	/**
	 * Remove all symbols for a file
	 */
	public removeFile(filePath: string): void {
		const fileSymbols = this.fileSymbols.get(filePath)
		if (fileSymbols) {
			for (const symbolId of fileSymbols) {
				this.symbols.delete(symbolId)
			}
			this.fileSymbols.delete(filePath)
		}

		// Remove file references
		this.fileReferences.delete(filePath)

		// Remove references to this file from other files' references
		for (const [otherFile, referenceSet] of this.fileReferences.entries()) {
			referenceSet.delete(filePath)
		}
	}

	/**
	 * Get all symbols in a file
	 */
	public getFileSymbols(filePath: string): Symbol[] {
		const fileSymbols = this.fileSymbols.get(filePath) || new Set<string>()
		const symbols: Symbol[] = []

		for (const symbolId of fileSymbols) {
			const symbol = this.symbols.get(symbolId)
			if (symbol) {
				symbols.push(symbol)
			}
		}

		return symbols
	}

	/**
	 * Get all files that are related to the given file
	 * (either reference symbols in it or are referenced by it)
	 */
	public getRelatedFiles(filePath: string): Set<string> {
		const relatedFiles = new Set<string>()

		// Add files this file references
		const referencedFiles = this.fileReferences.get(filePath) || new Set<string>()
		for (const referencedFile of referencedFiles) {
			relatedFiles.add(referencedFile)
		}

		// Add files that reference this file
		for (const [otherFile, referenceSet] of this.fileReferences.entries()) {
			if (referenceSet.has(filePath)) {
				relatedFiles.add(otherFile)
			}
		}

		return relatedFiles
	}

	/**
	 * Get all symbols matching a name pattern
	 */
	public findSymbolsByName(namePattern: string | RegExp): Symbol[] {
		const regex = typeof namePattern === "string" ? new RegExp(namePattern) : namePattern
		const results: Symbol[] = []

		for (const symbol of this.symbols.values()) {
			if (regex.test(symbol.name)) {
				results.push(symbol)
			}
		}

		return results
	}

	/**
	 * Get a specific symbol by its ID
	 */
	public getSymbol(symbolId: string): Symbol | undefined {
		return this.symbols.get(symbolId)
	}
}
