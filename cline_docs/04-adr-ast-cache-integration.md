# ADR: AST-Aware Semantic Cache Integration

**Objective:** Define the integration between AST-based content reconstruction and the smart caching system to ensure cache coherence during code modifications.

## Context

We have two separate systems:

1. AST-based content reconstruction (ADR-02) for modifying function bodies
2. Smart caching system (ADR-03) for managing embeddings

These systems need to work together to maintain cache validity during code modifications.

## Decision

Implement an AST-aware caching system that:

1. Uses AST nodes for context generation
2. Maintains cache coherence during AST modifications
3. Provides bidirectional communication between systems

## Technical Details

### 1. AST-Aware Cache Key Generation

```typescript
// src/services/embedding/ast-cache-key.ts
export class AstCacheKeyGenerator extends CacheKeyGenerator {
	static generateFromNode(node: Parser.SyntaxNode, filePath: string, parser: Parser): string {
		const nodeText = node.text
		const fileContent = fs.readFileSync(filePath, "utf-8")

		// Get AST-based context
		const contextHash = this.getAstContextHash(node, parser)

		const metadata: CacheKeyMetadata = {
			fileHash: this.getFileHash(fileContent),
			contextHash,
			lastModified: fs.statSync(filePath).mtimeMs,
			version: "1.0",
			nodeType: node.type,
			nodeStartByte: node.startIndex,
			nodeEndByte: node.endIndex,
		}

		return `${nodeText}_${JSON.stringify(metadata)}`
	}

	private static getAstContextHash(node: Parser.SyntaxNode, parser: Parser): string {
		// Get parent function/class/block
		const parentNode = this.findParentScope(node)
		if (!parentNode) return ""

		// Get sibling nodes
		const siblings = this.getSiblingNodes(node)

		// Create context from parent and siblings
		const context = {
			parentType: parentNode.type,
			parentText: parentNode.text,
			siblingTypes: siblings.map((s) => s.type),
			nodePosition: node.startIndex,
		}

		return crypto.createHash("sha256").update(JSON.stringify(context)).digest("hex")
	}

	private static findParentScope(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
		let current = node.parent
		while (current) {
			if (this.isScopeNode(current)) return current
			current = current.parent
		}
		return null
	}

	private static isScopeNode(node: Parser.SyntaxNode): boolean {
		return ["function_definition", "class_definition", "method_definition", "block"].includes(node.type)
	}
}
```

### 2. AST-Aware Cache Manager

```typescript
// src/services/embedding/ast-cache-manager.ts
export class AstCacheManager {
	constructor(
		private cache: SmartEmbeddingCache,
		private parser: Parser,
	) {}

	async handleAstModification(node: Parser.SyntaxNode, newContent: string, filePath: string): Promise<void> {
		// Get affected nodes
		const affectedNodes = this.getAffectedNodes(node)

		// Invalidate cache entries for affected nodes
		for (const affectedNode of affectedNodes) {
			const cacheKey = AstCacheKeyGenerator.generateFromNode(affectedNode, filePath, this.parser)
			this.cache.invalidate(cacheKey)
		}

		// Update cache with new content
		if (newContent) {
			const newTree = this.parser.parse(newContent)
			const newNode = this.findCorrespondingNode(newTree.rootNode, node.startIndex, node.type)

			if (newNode) {
				const newKey = AstCacheKeyGenerator.generateFromNode(newNode, filePath, this.parser)
				// Cache will be populated on next embedding request
				this.cache.prepareForUpdate(newKey)
			}
		}
	}

	private getAffectedNodes(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
		const affected: Parser.SyntaxNode[] = [node]

		// Add child nodes that might be affected
		node.children.forEach((child) => {
			if (this.isDependentNode(child)) {
				affected.push(child)
			}
		})

		// Add parent nodes that might need cache updates
		let parent = node.parent
		while (parent) {
			if (this.isDependentNode(parent)) {
				affected.push(parent)
			}
			parent = parent.parent
		}

		return affected
	}

	private isDependentNode(node: Parser.SyntaxNode): boolean {
		// Check if node type is one we cache embeddings for
		return ["function_definition", "method_definition", "class_definition"].includes(node.type)
	}
}
```

### 3. Integration with Content Reconstruction

```typescript
// src/core/diff/strategies/new-unified/content-reconstruction.ts
export class ContentReconstructor {
	constructor(
		private parser: Parser,
		private cacheManager: AstCacheManager,
	) {}

	async reconstructContent(
		originalContent: string,
		functionId: string,
		newBody: string,
		filePath: string,
	): Promise<string> {
		const tree = this.parser.parse(originalContent)
		const functionNode = this.findFunctionNode(tree, functionId)

		if (!functionNode) {
			throw new Error("Function not found")
		}

		// Get the body node
		const bodyNode = functionNode.childForFieldName("body")
		if (!bodyNode) {
			throw new Error("Function body not found")
		}

		// Create new content
		const newContent = this.replaceNodeContent(originalContent, bodyNode, newBody)

		// Notify cache manager about the modification
		await this.cacheManager.handleAstModification(functionNode, newContent, filePath)

		return newContent
	}
}
```

### 4. Updated Embedding Service

```typescript
// src/services/embedding/NebiusEmbeddingService.ts
export class NebiusEmbeddingService {
	constructor(
		private config: EmbeddingServiceConfig,
		private parser: Parser,
		private cacheManager: AstCacheManager,
	) {
		this.cache = new SmartEmbeddingCache()
	}

	async embedFunctionBody(node: Parser.SyntaxNode, filePath: string): Promise<number[] | null> {
		const cacheKey = AstCacheKeyGenerator.generateFromNode(node, filePath, this.parser)

		// Try cache first
		const cached = this.cache.get(cacheKey)
		if (cached) return cached

		// Get embedding from API
		const embedding = await withRetry(() => this.fetchEmbedding(node.text), this.config.retryAttempts, 1000)

		if (embedding) {
			// Cache with AST context
			this.cache.set(cacheKey, embedding, {
				nodeType: node.type,
				filePath,
				dependencies: await this.getDependencies(node),
			})
		}

		return embedding
	}

	private async getDependencies(node: Parser.SyntaxNode): Promise<string[]> {
		// Analyze imports and references
		const dependencies = new Set<string>()

		// Add direct imports
		this.findImports(node).forEach((imp) => dependencies.add(imp))

		// Add referenced files
		this.findReferences(node).forEach((ref) => dependencies.add(ref))

		return Array.from(dependencies)
	}
}
```

## Benefits

1. **Precise Cache Invalidation**

    - AST-aware context generation
    - Accurate dependency tracking
    - Minimal cache invalidation

2. **Improved Performance**

    - Reuse of AST parsing
    - Smart context boundaries
    - Efficient cache updates

3. **Better Reliability**
    - AST-validated cache keys
    - Structural code understanding
    - Comprehensive dependency tracking

## Migration Strategy

1. Implement AST-aware cache key generation
2. Update content reconstruction to use cache manager
3. Modify embedding service to use AST nodes
4. Gradually replace existing cache usage

## Acceptance Criteria

- [ ] Cache remains valid after AST-based modifications
- [ ] No unnecessary cache invalidations
- [ ] Correct handling of nested function modifications
- [ ] Performance impact within acceptable limits
- [ ] All AST operations properly error-handled

## Implementation Timeline

1. AST-aware cache key generation: 2 days
2. Cache manager implementation: 2 days
3. Content reconstruction integration: 1 day
4. Embedding service updates: 1 day
5. Testing and optimization: 2 days

Total: ~8 days

## Dependencies

1. AST Parser implementation (from ADR-02)
2. Smart cache system (from ADR-03)
3. Tree-sitter integration
