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

			// @ts-ignore - Accessing private method for testing
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
			// We need to access the private property for testing
			// @ts-ignore - Accessing private property for testing
			const maxCacheSize = cacheManager.maxCacheSize
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
			// Mock cleanupCache method for spying
			// @ts-ignore - Accessing private method for testing
			const cleanupSpy = jest.spyOn(cacheManager, "cleanupCache")

			// Fast-forward time to trigger cleanup (10 minutes)
			jest.advanceTimersByTime(10 * 60 * 1000)

			expect(cleanupSpy).toHaveBeenCalled()
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

	describe("Cache control", () => {
		// We can't directly test enableEmbeddings since it's a private property,
		// so we'll test the behavior instead of the property directly

		it("should handle content similarity when caching", () => {
			const filePath = "test.ts"
			const content1 = "function test() { return true; }"
			const content2 = "function test() { return true; } // Added comment"

			// Mock the cosine similarity function
			const mockCosineSim = require("../../../utils/cosineSimilarity").cosineSimilarity
			mockCosineSim.mockReturnValue(0.98) // High similarity

			// Cache the first version
			cacheManager.cacheTree(filePath, mockTree, content1)

			// Create a slightly different tree
			const updatedMockTree = {
				rootNode: {
					type: "program",
					text: content2,
					startPosition: { row: 0, column: 0 },
					endPosition: { row: 0, column: content2.length },
					children: [],
					childCount: 1,
					namedChildCount: 1,
				},
				copy: jest.fn().mockReturnThis(),
				delete: jest.fn(),
				walk: jest.fn(),
			} as unknown as Parser.Tree

			// Cache the updated version
			cacheManager.cacheTree(filePath, updatedMockTree, content2)

			// The cosine similarity function should have been called
			expect(mockCosineSim).toHaveBeenCalled()
		})
	})
})
