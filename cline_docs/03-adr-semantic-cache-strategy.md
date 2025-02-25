# ADR: Smart Caching Strategy for Code Embeddings

**Objective:** Implement an intelligent caching system for code embeddings that can handle frequent code modifications while maintaining cache freshness.

## Context

The current implementation proposes a simple time-based cache for embeddings. However, this approach is inadequate for code that changes frequently, as:

1. Code modifications can invalidate cached embeddings
2. Simple time-based expiration doesn't account for code changes
3. Cache hits might return stale embeddings for modified code

## Decision

Implement a smart caching system that:

1. Uses content-based cache keys
2. Tracks code dependencies
3. Implements partial caching for code blocks
4. Provides cache invalidation hooks

## Implementation

### 1. Content-Based Cache Key

Instead of using just the text as the cache key, create a composite key that includes:

- Code content hash
- Context information
- File metadata

```typescript
// src/services/embedding/cache-key.ts
export interface CacheKeyMetadata {
	fileHash: string // Hash of the entire file
	contextHash: string // Hash of surrounding code
	lastModified: number // File modification timestamp
	version: string // Cache version for migrations
}

export class CacheKeyGenerator {
	static generate(code: string, filePath: string, contextLines: number = 3): string {
		const fileContent = fs.readFileSync(filePath, "utf-8")
		const fileHash = crypto.createHash("sha256").update(fileContent).digest("hex")

		const contextHash = this.getContextHash(code, fileContent, contextLines)

		const metadata: CacheKeyMetadata = {
			fileHash,
			contextHash,
			lastModified: fs.statSync(filePath).mtimeMs,
			version: "1.0",
		}

		return `${code}_${JSON.stringify(metadata)}`
	}

	private static getContextHash(code: string, fileContent: string, contextLines: number): string {
		const codeLocation = fileContent.indexOf(code)
		if (codeLocation === -1) return ""

		const start = Math.max(0, codeLocation - contextLines)
		const end = Math.min(fileContent.length, codeLocation + code.length + contextLines)

		const context = fileContent.slice(start, end)
		return crypto.createHash("sha256").update(context).digest("hex")
	}
}
```

### 2. Smart Cache Implementation

```typescript
// src/services/embedding/smart-cache.ts
interface CacheEntry {
	embedding: number[]
	metadata: CacheKeyMetadata
	dependencies: Set<string> // Related file paths that affect this cache
}

export class SmartEmbeddingCache {
	private cache = new Map<string, CacheEntry>()
	private fileWatcher: FileWatcher

	constructor() {
		this.fileWatcher = new FileWatcher()
		this.fileWatcher.on("change", this.handleFileChange.bind(this))
	}

	set(text: string, embedding: number[], filePath: string, dependencies: string[] = []): void {
		const cacheKey = CacheKeyGenerator.generate(text, filePath)
		const metadata = this.extractMetadata(cacheKey)

		// Store cache entry
		this.cache.set(cacheKey, {
			embedding,
			metadata,
			dependencies: new Set([filePath, ...dependencies]),
		})

		// Watch file and its dependencies
		this.fileWatcher.watch([filePath, ...dependencies])
	}

	get(text: string, filePath: string): number[] | null {
		const cacheKey = CacheKeyGenerator.generate(text, filePath)
		const entry = this.cache.get(cacheKey)

		if (!entry) return null

		// Verify cache freshness
		if (this.isStale(entry, filePath)) {
			this.cache.delete(cacheKey)
			return null
		}

		return entry.embedding
	}

	private isStale(entry: CacheEntry, filePath: string): boolean {
		// Check file modification times
		for (const dep of entry.dependencies) {
			const stat = fs.statSync(dep)
			if (stat.mtimeMs > entry.metadata.lastModified) {
				return true
			}
		}

		// Verify file content hasn't changed
		const currentHash = crypto.createHash("sha256").update(fs.readFileSync(filePath, "utf-8")).digest("hex")

		return currentHash !== entry.metadata.fileHash
	}

	private handleFileChange(filePath: string): void {
		// Invalidate all cache entries that depend on the changed file
		for (const [key, entry] of this.cache.entries()) {
			if (entry.dependencies.has(filePath)) {
				this.cache.delete(key)
			}
		}
	}
}
```

### 3. File Watcher for Cache Invalidation

```typescript
// src/services/embedding/file-watcher.ts
import * as chokidar from "chokidar"
import { EventEmitter } from "events"

export class FileWatcher extends EventEmitter {
	private watcher: chokidar.FSWatcher
	private watchedFiles = new Set<string>()

	constructor() {
		super()
		this.watcher = chokidar.watch([], {
			persistent: true,
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: 300,
				pollInterval: 100,
			},
		})

		this.watcher.on("change", (path) => {
			this.emit("change", path)
		})
	}

	watch(paths: string[]): void {
		paths.forEach((path) => {
			if (!this.watchedFiles.has(path)) {
				this.watchedFiles.add(path)
				this.watcher.add(path)
			}
		})
	}

	unwatch(path: string): void {
		this.watchedFiles.delete(path)
		this.watcher.unwatch(path)
	}
}
```

### 4. Integration with NebiusEmbeddingService

```typescript
// src/services/embedding/NebiusEmbeddingService.ts
export class NebiusEmbeddingService {
	private cache: SmartEmbeddingCache

	constructor(private config: EmbeddingServiceConfig) {
		this.cache = new SmartEmbeddingCache()
	}

	async embedFunctionBody(code: string, filePath: string, dependencies: string[] = []): Promise<number[] | null> {
		// Try cache first
		const cached = this.cache.get(code, filePath)
		if (cached) return cached

		// Get embedding from API
		const embedding = await withRetry(() => this.fetchEmbedding(code), this.config.retryAttempts, 1000)

		if (embedding) {
			// Cache with dependencies
			this.cache.set(code, embedding, filePath, dependencies)
		}

		return embedding
	}
}
```

## Benefits

1. **Accurate Cache Invalidation**

    - Cache keys consider both content and context
    - File watching enables immediate invalidation
    - Dependency tracking handles related file changes

2. **Better Performance**

    - Reduced unnecessary cache misses
    - Efficient invalidation of only affected entries
    - Background file watching avoids synchronous checks

3. **Improved Reliability**
    - No stale cache hits
    - Handles complex code dependencies
    - Graceful fallback on file system errors

## Usage Example

```typescript
// In ast-diff.ts
async function areNodesEquivalent(
	oldNode: Parser.SyntaxNode,
	newNode: Parser.SyntaxNode,
	embeddingService: NebiusEmbeddingService,
	filePath: string,
): Promise<boolean> {
	const oldBody = await getNodeBody(oldNode)
	const newBody = await getNodeBody(newNode)

	// Get dependencies from imports and references
	const dependencies = await getDependencies(filePath)

	const oldEmbedding = await embeddingService.embedFunctionBody(oldBody, filePath, dependencies)
	const newEmbedding = await embeddingService.embedFunctionBody(newBody, filePath, dependencies)

	if (!oldEmbedding || !newEmbedding) {
		return oldBody === newBody // Fallback
	}

	return cosineSimilarity(oldEmbedding, newEmbedding) > embeddingService.getSimilarityThreshold()
}
```

## Migration Strategy

1. Deploy file watcher and cache key changes first
2. Gradually migrate to smart cache in regions
3. Monitor cache hit rates and staleness
4. Enable dependency tracking as final step

## Acceptance Criteria

- [ ] No stale cache hits during active development
- [ ] Cache invalidation within 500ms of file changes
- [ ] Cache hit rate > 80% for unchanged code
- [ ] Memory usage within acceptable limits
- [ ] All file system operations properly error-handled

## Risks and Mitigations

1. **Risk**: High memory usage from tracking many files

    - **Mitigation**: Implement cache size limits and LRU eviction

2. **Risk**: File system performance impact

    - **Mitigation**: Batch file system operations and use efficient watchers

3. **Risk**: False cache invalidations

    - **Mitigation**: Tune stabilityThreshold in file watcher

4. **Risk**: Missing dependency changes
    - **Mitigation**: Implement thorough dependency analysis

## Implementation Timeline

1. Cache Key Generator & Content Hash: 1 day
2. Smart Cache Implementation: 2 days
3. File Watcher Integration: 1 day
4. Dependency Tracking: 2 days
5. Testing & Performance Tuning: 2 days

Total: ~8 days
