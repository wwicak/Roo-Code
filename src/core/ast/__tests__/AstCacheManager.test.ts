import { jest } from "@jest/globals"
import { AstCacheManager } from "../AstCacheManager"
import Parser from "web-tree-sitter"

// Mock dependencies
jest.mock("web-tree-sitter")
jest.mock("../../../utils/logging", () => ({
	logger: {
		info: jest.fn(),
		error: jest.fn(),
		warn: jest.fn(),
		debug: jest.fn(),
	},
}))
jest.mock("../../../utils/cosineSimilarity", () => ({
	cosineSimilarity: jest.fn().mockReturnValue(0.95),
}))

describe("AstCacheManager", () => {
	let cacheManager: AstCacheManager
	let mockTree: Parser.Tree

	beforeEach(() => {
		jest.clearAllMocks()

		// Create mock AST tree
		mockTree = {
			rootNode: {
				type: "program",
				text: "function test() { return true; }",
				startPosition: { row: 0, column: 0 },
				endPosition: { row: 0, column: 31 },
				children: [],
				childCount: 1,
				namedChildCount: 1,
			},
			copy: jest.fn().mockReturnThis(),
			delete: jest.fn(),
			walk: jest.fn(),
		} as unknown as Parser.Tree

		// Reset timer mocks
		jest.useFakeTimers()

		// Create a new instance for each test
		cacheManager = new AstCacheManager()
	})

	afterEach(() => {
		jest.useRealTimers()
	})

	describe("Basic caching operations", () => {
		it("should return null for non-cached files", () => {
			const result = cacheManager.getCachedTree("non-existent.ts")
			expect(result).toBeNull()
		})

		it("should cache and retrieve a tree", () => {
			const filePath = "test.ts"
			const content = "function test() { return true; }"

			cacheManager.cacheTree(filePath, mockTree, content)
			const cachedTree = cacheManager.getCachedTree(filePath)

			expect(cachedTree).toBe(mockTree)
		})

		it("should invalidate a cached file", () => {
			const filePath = "test.ts"

			cacheManager.cacheTree(filePath, mockTree)
			cacheManager.invalidateFile(filePath)
			const cachedTree = cacheManager.getCachedTree(filePath)

			expect(cachedTree).toBeNull()
		})

		it("should clear the entire cache", () => {
			const filePathA = "testA.ts"
			const filePathB = "testB.ts"

			cacheManager.cacheTree(filePathA, mockTree)
			cacheManager.cacheTree(filePathB, mockTree)

			cacheManager.clearCache()

			expect(cacheManager.getCachedTree(filePathA)).toBeNull()
			expect(cacheManager.getCachedTree(filePathB)).toBeNull()
		})
	})

	describe("Cache management", () => {
		it("should consider cache stale after the threshold time", () => {
			const filePath = "test.ts"

			cacheManager.cacheTree(filePath, mockTree)

			// Fast-forward time past the stale threshold (5 minutes)
			jest.advanceTimersByTime(6 * 60 * 1000)

			const cachedTree = cacheManager.getCachedTree(filePath)
			expect(cachedTree).toBeNull()
		})

		it("should limit the number of entries in the cache", () => {
			// Set a smaller cache size to test limiting behavior
			const maxCacheSize = 5
			cacheManager.setMaxCacheSize(maxCacheSize)
			const numEntries = maxCacheSize + 1

			// Add more files than the cache size limit
			for (let i = 0; i < numEntries; i++) {
				cacheManager.cacheTree(`test${i}.ts`, mockTree)
			}

			// The first file should have been evicted
			expect(cacheManager.getCachedTree("test0.ts")).toBeNull()

			// But the later files should still be in the cache
			expect(cacheManager.getCachedTree(`test${numEntries - 1}.ts`)).not.toBeNull()
		})

		it("should run cleanup periodically", () => {
			// We can't spy on private methods, so we'll test behavior instead
			const filePath = "test.ts"
			cacheManager.cacheTree(filePath, mockTree)

			// Fast-forward time to trigger cleanup (10 minutes)
			jest.advanceTimersByTime(10 * 60 * 1000)

			// Fast-forward time past the stale threshold (5 minutes)
			jest.advanceTimersByTime(6 * 60 * 1000)

			// After cleanup, the stale entry should be removed
			expect(cacheManager.getCachedTree(filePath)).toBeNull()
		})
	})

	describe("Cache update strategies", () => {
		it("should update the cache when a file has changed", () => {
			const filePath = "test.ts"
			const originalContent = "function test() { return true; }"
			const updatedContent = "function test() { return false; }"

			// Initial caching
			cacheManager.cacheTree(filePath, mockTree, originalContent)

			// Create a new mock tree for the update
			const updatedMockTree = {
				rootNode: {
					type: "program",
					text: updatedContent,
					startPosition: { row: 0, column: 0 },
					endPosition: { row: 0, column: updatedContent.length },
					children: [],
					childCount: 1,
					namedChildCount: 1,
				},
				copy: jest.fn().mockReturnThis(),
				delete: jest.fn(),
				walk: jest.fn(),
			} as unknown as Parser.Tree

			// Update the cache
			cacheManager.cacheTree(filePath, updatedMockTree, updatedContent)

			// Get the cached tree
			const cachedTree = cacheManager.getCachedTree(filePath)

			expect(cachedTree).toBe(updatedMockTree)
			expect(cachedTree).not.toBe(mockTree)
		})
	})

	describe("Semantic similarity and embeddings", () => {
		it("should update and use embeddings for similarity search", () => {
			const filePath = "test.ts"
			const content = "function test() { return true; }"
			const embedding = [0.1, 0.2, 0.3]

			// Cache a file
			cacheManager.cacheTree(filePath, mockTree, content)

			// Update its embedding
			cacheManager.updateEmbedding(filePath, embedding)

			// Search for similar file
			const similarFile = cacheManager.getMostSimilarFile("function test2() {}", [0.2, 0.3, 0.4])

			expect(similarFile).toBe(filePath)
		})

		it("should return null if no file meets the similarity threshold", () => {
			const mockCosineSim = require("../../../utils/cosineSimilarity").cosineSimilarity

			// Set similarity below threshold
			mockCosineSim.mockReturnValueOnce(0.7)

			const result = cacheManager.getMostSimilarFile("let x = 10;", [0.1, 0.2, 0.3])
			expect(result).toBeNull()
		})
	})

	describe("Cache configuration", () => {
		it("should update stale threshold", () => {
			const filePath = "test.ts"

			// Set a smaller stale threshold (1 second)
			cacheManager.setStaleThreshold(1000)

			cacheManager.cacheTree(filePath, mockTree)

			// Fast-forward time just past the new threshold
			jest.advanceTimersByTime(1001)

			// Cache should now be stale
			expect(cacheManager.getCachedTree(filePath)).toBeNull()
		})

		it("should handle cache enable/disable", () => {
			const filePath = "test.ts"

			// Disable cache
			cacheManager.disableCache()

			// Add an entry
			cacheManager.cacheTree(filePath, mockTree)

			// Cache should be empty after disable
			expect(cacheManager.getCachedTree(filePath)).toBeNull()

			// Enable cache and try again
			cacheManager.enableCache()
			cacheManager.cacheTree(filePath, mockTree)

			// Now it should work
			expect(cacheManager.getCachedTree(filePath)).toBe(mockTree)
		})
	})
})
