import Parser from "web-tree-sitter"
import { logger } from "../../utils/logging"
import { cosineSimilarity } from "../../utils/cosineSimilarity"

interface CacheEntry {
	tree: Parser.Tree
	content: string
	lastUpdated: number
	embedding?: number[]
}

/**
 * Cache manager for AST trees to improve performance
 */
export class AstCacheManager {
	private cache = new Map<string, CacheEntry>()
	private maxCacheSize = 100 // Maximum number of entries in the cache
	private staleThresholdMs = 5 * 60 * 1000 // Consider cache stale after 5 minutes

	constructor() {
		// Set up periodic cache cleanup
		setInterval(() => this.cleanupCache(), 10 * 60 * 1000) // Clean every 10 minutes
	}

	/**
	 * Get a cached tree for a file if it exists
	 * @param filePath Path to the file
	 * @returns The cached tree or null if not in cache
	 */
	public getCachedTree(filePath: string): Parser.Tree | null {
		const entry = this.cache.get(filePath)
		if (!entry) return null

		// Check if cache is stale
		const now = Date.now()
		if (now - entry.lastUpdated > this.staleThresholdMs) {
			logger.debug(`Cache for ${filePath} is stale, returning null`)
			return null
		}

		return entry.tree
	}

	/**
	 * Cache a tree for a file
	 * @param filePath Path to the file
	 * @param tree The parsed AST tree
	 * @param content Optional file content
	 */
	public cacheTree(filePath: string, tree: Parser.Tree, content?: string): void {
		// If cache is full, remove the oldest entry
		if (this.cache.size >= this.maxCacheSize) {
			this.removeOldestEntry()
		}

		// Cache the tree with the current timestamp
		this.cache.set(filePath, {
			tree,
			content: content || tree.rootNode.text,
			lastUpdated: Date.now(),
		})

		logger.debug(`Cached AST for ${filePath}`)
	}

	/**
	 * Clear the entire cache
	 */
	public clearCache(): void {
		const count = this.cache.size
		this.cache.clear()
		logger.debug(`Cleared AST cache (${count} entries)`)
	}

	/**
	 * Set the maximum cache size
	 * @param size Maximum number of entries to store
	 */
	public setMaxCacheSize(size: number): void {
		if (size > 0) {
			this.maxCacheSize = size
			logger.debug(`Set max cache size to ${size}`)

			// If current cache exceeds new limit, trim it down
			while (this.cache.size > this.maxCacheSize) {
				this.removeOldestEntry()
			}
		} else {
			logger.warn(`Invalid cache size: ${size}, must be > 0`)
		}
	}

	/**
	 * Set the staleness threshold in milliseconds
	 * @param thresholdMs Time in milliseconds after which cache entries are considered stale
	 */
	public setStaleThreshold(thresholdMs: number): void {
		if (thresholdMs > 0) {
			this.staleThresholdMs = thresholdMs
			logger.debug(`Set cache stale threshold to ${thresholdMs}ms`)
		} else {
			logger.warn(`Invalid stale threshold: ${thresholdMs}, must be > 0`)
		}
	}

	/**
	 * Update the embedding for a cached file
	 * @param filePath Path to the file
	 * @param embedding The embedding vector
	 */
	public updateEmbedding(filePath: string, embedding: number[]): void {
		const entry = this.cache.get(filePath)
		if (entry) {
			entry.embedding = embedding
			logger.debug(`Updated embedding for ${filePath}`)
		}
	}

	/**
	 * Get the most semantically similar file to the given content
	 * @param content Code content to find similar files for
	 * @param embedding Embedding of the content
	 * @param threshold Similarity threshold (0-1)
	 * @returns The most similar file path or null if none found
	 */
	public getMostSimilarFile(content: string, embedding: number[], threshold = 0.85): string | null {
		let bestMatch: string | null = null
		let bestScore = threshold // Start with the minimum threshold

		for (const [filePath, entry] of this.cache.entries()) {
			if (!entry.embedding) continue

			const similarity = cosineSimilarity(embedding, entry.embedding)

			if (similarity > bestScore) {
				bestScore = similarity
				bestMatch = filePath
			}
		}

		if (bestMatch) {
			logger.debug(`Found similar file to content: ${bestMatch} (score: ${bestScore.toFixed(2)})`)
		}

		return bestMatch
	}

	/**
	 * Invalidate the cache for a file
	 * @param filePath Path to the file
	 */
	public invalidateFile(filePath: string): void {
		this.cache.delete(filePath)
		logger.debug(`Invalidated cache for ${filePath}`)
	}

	/**
	 * Disable caching functionality
	 */
	public disableCache(): void {
		this.clearCache()
		logger.debug("AST caching disabled")
	}

	/**
	 * Enable caching functionality
	 */
	public enableCache(): void {
		logger.debug("AST caching enabled")
	}

	/**
	 * Clean up the cache by removing stale entries
	 */
	private cleanupCache(): void {
		const now = Date.now()
		let removedCount = 0

		for (const [filePath, entry] of this.cache.entries()) {
			if (now - entry.lastUpdated > this.staleThresholdMs) {
				this.cache.delete(filePath)
				removedCount++
			}
		}

		if (removedCount > 0) {
			logger.debug(`Cleaned up ${removedCount} stale entries from AST cache`)
		}
	}

	/**
	 * Remove the oldest entry from the cache
	 */
	private removeOldestEntry(): void {
		let oldestTime = Infinity
		let oldestKey: string | null = null

		for (const [filePath, entry] of this.cache.entries()) {
			if (entry.lastUpdated < oldestTime) {
				oldestTime = entry.lastUpdated
				oldestKey = filePath
			}
		}

		if (oldestKey) {
			this.cache.delete(oldestKey)
			logger.debug(`Removed oldest cache entry: ${oldestKey}`)
		}
	}

	/**
	 * Get the size of the cache
	 */
	public getCacheSize(): number {
		return this.cache.size
	}

	/**
	 * Get information about all cached files
	 */
	public getCacheInfo(): { filePath: string; lastUpdated: Date; hasEmbedding: boolean }[] {
		const info = []

		for (const [filePath, entry] of this.cache.entries()) {
			info.push({
				filePath,
				lastUpdated: new Date(entry.lastUpdated),
				hasEmbedding: !!entry.embedding,
			})
		}

		return info
	}
}
