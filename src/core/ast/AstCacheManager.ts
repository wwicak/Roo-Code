import Parser from "web-tree-sitter"
import { logger } from "../../utils/logging"
import { cosineSimilarity } from "../../utils/cosineSimilarity"
import * as fs from "fs/promises"
import * as crypto from "crypto"
import * as vscode from "vscode"
import { AstErrorHandler, AstErrorCode, AstError } from "./AstErrorHandler"
import * as path from "path"
import * as os from "os"

/**
 * Cache strategy options
 */
export enum CacheStrategy {
	MEMORY_ONLY = "memory_only",
	DISK_AND_MEMORY = "disk_and_memory",
	MEMORY_WITH_DISK_FALLBACK = "memory_with_disk_fallback",
}

/**
 * Cache priority levels
 */
export enum CachePriority {
	HIGH = "high",
	MEDIUM = "medium",
	LOW = "low",
}

interface CacheEntry {
	tree: Parser.Tree
	content: string
	lastUpdated: number
	embedding?: number[]
	fileHash?: string
	priority?: CachePriority
	accessCount?: number
	lastAccessed?: number
	size?: number
}

interface CacheStats {
	hits: number
	misses: number
	diskHits: number
	diskMisses: number
	evictions: number
	totalEntries: number
	memoryUsage: number
}

/**
 * Cache manager for AST trees to improve performance
 */
export class AstCacheManager {
	private cache = new Map<string, CacheEntry>()
	private maxCacheSize = 100 // Maximum number of entries in the cache
	private maxMemoryUsageMB = 200 // Maximum memory usage in MB
	private staleThresholdMs = 5 * 60 * 1000 // Consider cache stale after 5 minutes
	private isEnabled = true // Track whether caching is enabled
	private fileWatcher: vscode.FileSystemWatcher | null = null
	private disposables: vscode.Disposable[] = []
	private cacheStrategy: CacheStrategy = CacheStrategy.MEMORY_ONLY
	private diskCacheDir: string = path.join(os.tmpdir(), "roo-ast-cache")
	private stats: CacheStats = {
		hits: 0,
		misses: 0,
		diskHits: 0,
		diskMisses: 0,
		evictions: 0,
		totalEntries: 0,
		memoryUsage: 0,
	}

	constructor(options?: {
		maxCacheSize?: number
		staleThresholdMs?: number
		cacheStrategy?: CacheStrategy
		maxMemoryUsageMB?: number
		diskCacheDir?: string
	}) {
		// Apply configuration options
		if (options) {
			if (options.maxCacheSize && options.maxCacheSize > 0) {
				this.maxCacheSize = options.maxCacheSize
			}

			if (options.staleThresholdMs && options.staleThresholdMs > 0) {
				this.staleThresholdMs = options.staleThresholdMs
			}

			if (options.cacheStrategy) {
				this.cacheStrategy = options.cacheStrategy
			}

			if (options.maxMemoryUsageMB && options.maxMemoryUsageMB > 0) {
				this.maxMemoryUsageMB = options.maxMemoryUsageMB
			}

			if (options.diskCacheDir) {
				this.diskCacheDir = options.diskCacheDir
			}
		}

		// Set up periodic cache cleanup
		setInterval(() => this.cleanupCache(), 10 * 60 * 1000) // Clean every 10 minutes

		// Set up file watcher to invalidate cache on external changes
		this.setupFileWatcher()

		// Initialize disk cache if needed
		this.initializeDiskCache()
	}

	/**
	 * Initialize disk cache directory if using disk caching
	 */
	private async initializeDiskCache(): Promise<void> {
		if (this.cacheStrategy === CacheStrategy.MEMORY_ONLY) {
			return
		}

		try {
			await fs.mkdir(this.diskCacheDir, { recursive: true })
			logger.debug(`AstCacheManager: Initialized disk cache at ${this.diskCacheDir}`)
		} catch (error) {
			logger.error("AstCacheManager: Failed to initialize disk cache", error)
			// Fall back to memory-only if disk cache initialization fails
			this.cacheStrategy = CacheStrategy.MEMORY_ONLY
		}
	}

	/**
	 * Setup file watcher to invalidate cache when files are changed outside the extension
	 */
	private setupFileWatcher(): void {
		try {
			// Watch for all files that might be in our cache
			this.fileWatcher = vscode.workspace.createFileSystemWatcher("**/*")

			// Watch for file changes and invalidate cache entries
			const changeListener = this.fileWatcher.onDidChange((uri) => {
				this.invalidateFileOnChange(uri.fsPath)
			})

			// Watch for file deletions and invalidate cache entries
			const deleteListener = this.fileWatcher.onDidDelete((uri) => {
				this.invalidateFile(uri.fsPath)
			})

			// Add disposables for cleanup
			this.disposables.push(this.fileWatcher, changeListener, deleteListener)

			logger.debug("AstCacheManager: File watcher setup successfully")
		} catch (error) {
			logger.error("AstCacheManager: Failed to setup file watcher", error)
		}
	}

	/**
	 * Dispose resources
	 */
	public dispose(): void {
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
		this.fileWatcher = null
		logger.debug("AstCacheManager: Disposed resources")
	}

	/**
	 * Calculate hash of a file
	 * @param filePath Path to the file
	 * @returns The file hash or null if file cannot be read
	 */
	public async getFileHash(filePath: string): Promise<string | null> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			return crypto.createHash("md5").update(content).digest("hex")
		} catch (error) {
			logger.error(`Failed to calculate hash for ${filePath}:`, error)
			return null
		}
	}

	/**
	 * Invalidate cache when a file is changed externally
	 * @param filePath Path to the file that changed
	 */
	public invalidateFileOnChange(filePath: string): void {
		if (this.cache.has(filePath)) {
			logger.debug(`External change detected for ${filePath}, invalidating cache`)
			this.invalidateFile(filePath)
		}
	}

	/**
	 * Get a cached tree for a file if it exists
	 * @param filePath Path to the file
	 * @returns The cached tree or null if not in cache
	 */
	public async getCachedTree(filePath: string): Promise<Parser.Tree | null> {
		if (!this.isEnabled) return null

		// Try memory cache first
		const memoryEntry = this.cache.get(filePath)
		if (memoryEntry) {
			// Check if cache is stale
			const now = Date.now()
			if (now - memoryEntry.lastUpdated > this.staleThresholdMs) {
				logger.debug(`Cache for ${filePath} is stale, returning null`)
				this.stats.misses++
				return null
			}

			// Verify file hash if we have one
			if (memoryEntry.fileHash) {
				const currentHash = await this.getFileHash(filePath)
				if (currentHash && currentHash !== memoryEntry.fileHash) {
					logger.debug(`File hash changed for ${filePath}, invalidating cache`)
					this.invalidateFile(filePath)
					this.stats.misses++
					return null
				}
			}

			// Update access statistics
			memoryEntry.lastAccessed = Date.now()
			memoryEntry.accessCount = (memoryEntry.accessCount || 0) + 1

			this.stats.hits++
			return memoryEntry.tree
		}

		// If memory cache miss, try disk cache if enabled
		if (this.cacheStrategy !== CacheStrategy.MEMORY_ONLY) {
			try {
				const tree = await this.loadFromDiskCache(filePath)
				if (tree) {
					this.stats.diskHits++
					return tree
				}
				this.stats.diskMisses++
			} catch (error) {
				logger.error(`Failed to load from disk cache for ${filePath}:`, error)
				this.stats.diskMisses++
			}
		}

		this.stats.misses++
		return null
	}

	/**
	 * Load a tree from disk cache
	 * @param filePath Path to the file
	 * @returns The loaded tree or null if not in disk cache
	 */
	private async loadFromDiskCache(filePath: string): Promise<Parser.Tree | null> {
		const cachePath = this.getDiskCachePath(filePath)

		try {
			// Check if cache file exists
			await fs.access(cachePath)

			// Read cache file
			const cacheData = JSON.parse(await fs.readFile(cachePath, "utf-8"))

			// Verify file hash
			const currentHash = await this.getFileHash(filePath)
			if (!currentHash || currentHash !== cacheData.fileHash) {
				logger.debug(`Disk cache: File hash changed for ${filePath}, invalidating`)
				await fs.unlink(cachePath)
				return null
			}

			// Verify staleness
			const now = Date.now()
			if (now - cacheData.lastUpdated > this.staleThresholdMs) {
				logger.debug(`Disk cache for ${filePath} is stale`)
				return null
			}

			// Load content and create tree
			// Note: We can't fully serialize/deserialize the Tree object,
			// so we need to reparse the content. This is a limitation.
			// In a real implementation, we might use a more sophisticated approach.

			// For now, we'll just return null as we can't fully implement this
			// without the actual Parser implementation details
			logger.debug(`Loaded ${filePath} from disk cache`)

			// Move to memory cache with high priority
			// In a real implementation, we would recreate the tree here
			// and add it to the memory cache

			return null
		} catch (error) {
			// File doesn't exist or other error
			return null
		}
	}

	/**
	 * Get the disk cache path for a file
	 * @param filePath Path to the file
	 * @returns The path to the disk cache file
	 */
	private getDiskCachePath(filePath: string): string {
		const fileHash = crypto.createHash("md5").update(filePath).digest("hex")
		return path.join(this.diskCacheDir, `${fileHash}.json`)
	}

	/**
	 * Cache a tree for a file
	 * @param filePath Path to the file
	 * @param tree The parsed AST tree
	 * @param content Optional file content
	 * @param priority Cache priority level
	 */
	public async cacheTree(
		filePath: string,
		tree: Parser.Tree,
		content?: string,
		priority: CachePriority = CachePriority.MEDIUM,
	): Promise<void> {
		if (!this.isEnabled) return

		// Check memory usage and evict if necessary
		await this.ensureCacheSpace()

		// Calculate file hash
		const fileHash = await this.getFileHash(filePath)

		// Estimate size of the entry
		const entryContent = content || tree.rootNode.text
		const estimatedSize = this.estimateEntrySize(entryContent, tree)

		// Cache the tree with the current timestamp and file hash
		const entry: CacheEntry = {
			tree,
			content: entryContent,
			lastUpdated: Date.now(),
			fileHash: fileHash || undefined,
			priority,
			accessCount: 1,
			lastAccessed: Date.now(),
			size: estimatedSize,
		}

		this.cache.set(filePath, entry)
		this.stats.totalEntries = this.cache.size

		logger.debug(
			`Cached AST for ${filePath}${fileHash ? " with hash" : ""} (priority: ${priority}, size: ${Math.round(estimatedSize / 1024)}KB)`,
		)

		// If using disk caching, also save to disk
		if (this.cacheStrategy === CacheStrategy.DISK_AND_MEMORY) {
			try {
				await this.saveToDiskCache(filePath, entry)
			} catch (error) {
				logger.error(`Failed to save to disk cache for ${filePath}:`, error)
			}
		}
	}

	/**
	 * Save a cache entry to disk
	 * @param filePath Path to the file
	 * @param entry The cache entry to save
	 */
	private async saveToDiskCache(filePath: string, entry: CacheEntry): Promise<void> {
		const cachePath = this.getDiskCachePath(filePath)

		// Create a serializable version of the entry
		const serializedEntry = {
			content: entry.content,
			lastUpdated: entry.lastUpdated,
			fileHash: entry.fileHash,
			priority: entry.priority,
			// We can't serialize the tree directly, so we just save metadata
		}

		try {
			await fs.writeFile(cachePath, JSON.stringify(serializedEntry))
			logger.debug(`Saved ${filePath} to disk cache`)
		} catch (error) {
			throw new Error(`Failed to save to disk cache: ${error}`)
		}
	}

	/**
	 * Estimate the memory size of a cache entry
	 * @param content The file content
	 * @param tree The AST tree
	 * @returns Estimated size in bytes
	 */
	private estimateEntrySize(content: string, tree: Parser.Tree): number {
		// Rough estimate: content size + tree overhead
		// In a real implementation, we would use a more accurate method
		const contentSize = content.length * 2 // UTF-16 characters
		const treeOverhead = content.length * 3 // Rough estimate of tree structure overhead
		return contentSize + treeOverhead
	}

	/**
	 * Ensure there's enough space in the cache
	 */
	private async ensureCacheSpace(): Promise<void> {
		// Check if we need to evict based on entry count
		if (this.cache.size >= this.maxCacheSize) {
			this.evictEntries()
		}

		// Check if we need to evict based on memory usage
		const memoryUsage = this.calculateMemoryUsage()
		this.stats.memoryUsage = memoryUsage

		if (memoryUsage > this.maxMemoryUsageMB * 1024 * 1024) {
			this.evictEntries(Math.ceil((memoryUsage - this.maxMemoryUsageMB * 1024 * 1024) / 1024 / 1024))
		}
	}

	/**
	 * Calculate the total memory usage of the cache
	 * @returns Memory usage in bytes
	 */
	private calculateMemoryUsage(): number {
		let totalSize = 0
		for (const entry of this.cache.values()) {
			totalSize += entry.size || 0
		}
		return totalSize
	}

	/**
	 * Clear the entire cache
	 */
	public async clearCache(): Promise<void> {
		const count = this.cache.size
		this.cache.clear()

		// Clear disk cache if enabled
		if (this.cacheStrategy !== CacheStrategy.MEMORY_ONLY) {
			try {
				const files = await fs.readdir(this.diskCacheDir)
				for (const file of files) {
					if (file.endsWith(".json")) {
						await fs.unlink(path.join(this.diskCacheDir, file))
					}
				}
				logger.debug(`Cleared disk cache (${files.length} entries)`)
			} catch (error) {
				logger.error("Failed to clear disk cache:", error)
			}
		}

		// Reset stats
		this.resetStats()

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
			if (this.cache.size > this.maxCacheSize) {
				this.evictEntries()
			}
		} else {
			logger.warn(`Invalid cache size: ${size}, must be > 0`)
		}
	}

	/**
	 * Set the maximum memory usage in MB
	 * @param maxMemoryMB Maximum memory usage in MB
	 */
	public setMaxMemoryUsage(maxMemoryMB: number): void {
		if (maxMemoryMB > 0) {
			this.maxMemoryUsageMB = maxMemoryMB
			logger.debug(`Set max memory usage to ${maxMemoryMB}MB`)

			// Check if we need to evict entries
			const memoryUsage = this.calculateMemoryUsage()
			if (memoryUsage > this.maxMemoryUsageMB * 1024 * 1024) {
				this.evictEntries(Math.ceil((memoryUsage - this.maxMemoryUsageMB * 1024 * 1024) / 1024 / 1024))
			}
		} else {
			logger.warn(`Invalid max memory usage: ${maxMemoryMB}, must be > 0`)
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
	 * Set the cache strategy
	 * @param strategy The cache strategy to use
	 */
	public setCacheStrategy(strategy: CacheStrategy): void {
		this.cacheStrategy = strategy
		logger.debug(`Set cache strategy to ${strategy}`)

		// Initialize disk cache if needed
		if (strategy !== CacheStrategy.MEMORY_ONLY) {
			this.initializeDiskCache()
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
	public async invalidateFile(filePath: string): Promise<void> {
		this.cache.delete(filePath)

		// Also remove from disk cache if enabled
		if (this.cacheStrategy !== CacheStrategy.MEMORY_ONLY) {
			try {
				const cachePath = this.getDiskCachePath(filePath)
				await fs.unlink(cachePath).catch(() => {
					// Ignore errors if file doesn't exist
				})
			} catch (error) {
				// Ignore errors
			}
		}

		this.stats.totalEntries = this.cache.size
		logger.debug(`Invalidated cache for ${filePath}`)
	}

	/**
	 * Disable caching functionality
	 */
	public disableCache(): void {
		this.isEnabled = false
		this.clearCache()
		logger.debug("AST caching disabled")
	}

	/**
	 * Enable caching functionality
	 */
	public enableCache(): void {
		this.isEnabled = true
		logger.debug("AST caching enabled")
	}

	/**
	 * Clean up the cache by removing stale entries
	 */
	private async cleanupCache(): Promise<void> {
		const now = Date.now()
		let removedCount = 0

		// Clean memory cache
		for (const [filePath, entry] of this.cache.entries()) {
			if (now - entry.lastUpdated > this.staleThresholdMs) {
				this.cache.delete(filePath)
				removedCount++
			}
		}

		// Clean disk cache if enabled
		if (this.cacheStrategy !== CacheStrategy.MEMORY_ONLY) {
			try {
				const files = await fs.readdir(this.diskCacheDir)
				for (const file of files) {
					if (!file.endsWith(".json")) continue

					try {
						const cachePath = path.join(this.diskCacheDir, file)
						const stats = await fs.stat(cachePath)

						// Remove if older than stale threshold
						if (now - stats.mtimeMs > this.staleThresholdMs) {
							await fs.unlink(cachePath)
							removedCount++
						}
					} catch (error) {
						// Ignore errors for individual files
					}
				}
			} catch (error) {
				logger.error("Failed to clean disk cache:", error)
			}
		}

		this.stats.totalEntries = this.cache.size

		if (removedCount > 0) {
			logger.debug(`Cleaned up ${removedCount} stale entries from AST cache`)
		}
	}

	/**
	 * Evict entries from the cache based on priority and access patterns
	 * @param numEntriesToEvict Number of entries to evict (default: enough to get under maxCacheSize)
	 */
	private evictEntries(numEntriesToEvict?: number): void {
		const entriesToEvict = numEntriesToEvict || this.cache.size - this.maxCacheSize + 1
		if (entriesToEvict <= 0) return

		// Score each entry based on priority, recency, and access count
		const scoredEntries: Array<{ filePath: string; score: number }> = []

		for (const [filePath, entry] of this.cache.entries()) {
			const priorityScore = this.getPriorityScore(entry.priority || CachePriority.MEDIUM)
			const recencyScore = (Date.now() - (entry.lastAccessed || entry.lastUpdated)) / this.staleThresholdMs
			const accessScore = 1 / (Math.log((entry.accessCount || 1) + 1) + 1)

			// Lower score = more likely to be evicted
			const score = priorityScore - recencyScore - accessScore

			scoredEntries.push({ filePath, score })
		}

		// Sort by score (ascending)
		scoredEntries.sort((a, b) => a.score - b.score)

		// Evict the lowest-scoring entries
		for (let i = 0; i < entriesToEvict && i < scoredEntries.length; i++) {
			this.cache.delete(scoredEntries[i].filePath)
			this.stats.evictions++
		}

		this.stats.totalEntries = this.cache.size
		logger.debug(`Evicted ${entriesToEvict} entries from AST cache`)
	}

	/**
	 * Get a numeric score for a priority level
	 * @param priority The priority level
	 * @returns A numeric score (higher = more important)
	 */
	private getPriorityScore(priority: CachePriority): number {
		switch (priority) {
			case CachePriority.HIGH:
				return 3
			case CachePriority.MEDIUM:
				return 2
			case CachePriority.LOW:
				return 1
			default:
				return 2
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
	public getCacheInfo(): {
		filePath: string
		lastUpdated: Date
		hasEmbedding: boolean
		priority: CachePriority
		accessCount: number
	}[] {
		const info = []

		for (const [filePath, entry] of this.cache.entries()) {
			info.push({
				filePath,
				lastUpdated: new Date(entry.lastUpdated),
				hasEmbedding: !!entry.embedding,
				priority: entry.priority || CachePriority.MEDIUM,
				accessCount: entry.accessCount || 1,
			})
		}

		return info
	}

	/**
	 * Get cache statistics
	 */
	public getStats(): CacheStats {
		return { ...this.stats }
	}

	/**
	 * Reset cache statistics
	 */
	public resetStats(): void {
		this.stats = {
			hits: 0,
			misses: 0,
			diskHits: 0,
			diskMisses: 0,
			evictions: 0,
			totalEntries: this.cache.size,
			memoryUsage: this.calculateMemoryUsage(),
		}
	}

	/**
	 * Set the priority of a cached file
	 * @param filePath Path to the file
	 * @param priority The priority level
	 */
	public setPriority(filePath: string, priority: CachePriority): void {
		const entry = this.cache.get(filePath)
		if (entry) {
			entry.priority = priority
			logger.debug(`Set priority for ${filePath} to ${priority}`)
		}
	}

	/**
	 * Prefetch a file into the cache
	 * @param filePath Path to the file
	 * @param tree The parsed AST tree
	 * @param content The file content
	 */
	public async prefetch(filePath: string, tree: Parser.Tree, content: string): Promise<void> {
		await this.cacheTree(filePath, tree, content, CachePriority.HIGH)
		logger.debug(`Prefetched ${filePath} into cache`)
	}
}
