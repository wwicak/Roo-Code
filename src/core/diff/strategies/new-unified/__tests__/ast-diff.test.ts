import { cosineSimilarity } from "../../../../../utils/cosineSimilarity"
import { NebiusEmbeddingService } from "../../../../../services/embedding/NebiusEmbeddingService"
import { getNodeIdentifier, getNodeBody, areNodesEquivalent, getFunctionModifications } from "../ast-diff"
import Parser from "web-tree-sitter"
import * as path from "path"

// Mock the embedding service
jest.mock("../../../../../services/embedding/NebiusEmbeddingService")

// Create a mock Parser.SyntaxNode
const createMockNode = (type: string, name: string, startRow: number, body?: string): Parser.SyntaxNode => {
	const mockNode: Partial<Parser.SyntaxNode> = {
		type,
		startPosition: { row: startRow },
		childForFieldName: (field: string) => {
			if (field === "name") {
				return { text: name } as Parser.SyntaxNode
			}
			if (field === "body" && body) {
				return { text: body } as Parser.SyntaxNode
			}
			return null
		},
		text: `function ${name}() { ${body || ""} }`,
	}
	return mockNode as Parser.SyntaxNode
}

describe("getNodeIdentifier", () => {
	it("should generate correct identifier from name field", () => {
		const node = createMockNode("function_declaration", "testFunc", 4)
		expect(getNodeIdentifier(node)).toBe("testFunc:5")
	})

	it("should handle missing name field", () => {
		const node = createMockNode("function_declaration", "", 4)
		expect(getNodeIdentifier(node)).toBe("unknown-4")
	})
})

describe("getNodeBody", () => {
	it("should extract function body correctly", async () => {
		const body = "return 42;"
		const node = createMockNode("function_declaration", "test", 0, body)
		const result = await getNodeBody(node)
		expect(result).toBe(body)
	})

	it("should handle missing body", async () => {
		const node = createMockNode("function_declaration", "test", 0)
		const result = await getNodeBody(node)
		expect(result).toBe("")
	})
})

describe("areNodesEquivalent", () => {
	let embeddingService: jest.Mocked<NebiusEmbeddingService>

	beforeEach(() => {
		embeddingService = new NebiusEmbeddingService("dummy-key") as jest.Mocked<NebiusEmbeddingService>
	})

	it("should return false for different node types", async () => {
		const node1 = createMockNode("function_declaration", "test", 0)
		const node2 = createMockNode("method_definition", "test", 0)

		const result = await areNodesEquivalent(node1, node2, embeddingService, "test.ts")
		expect(result).toBe(false)
	})

	it("should return false for different function names", async () => {
		const node1 = createMockNode("function_declaration", "test1", 0)
		const node2 = createMockNode("function_declaration", "test2", 0)

		const result = await areNodesEquivalent(node1, node2, embeddingService, "test.ts")
		expect(result).toBe(false)
	})

	it("should use embeddings for semantic comparison when available", async () => {
		const body1 = "return a + b;"
		const body2 = "return b + a;"
		const node1 = createMockNode("function_declaration", "test", 0, body1)
		const node2 = createMockNode("function_declaration", "test", 0, body2)

		// Mock embedding vectors that should be considered similar
		const mockEmbedding1 = [0.1, 0.2, 0.3]
		const mockEmbedding2 = [0.11, 0.21, 0.31]

		embeddingService.embedText.mockImplementation(async (text) => {
			if (text === body1) return mockEmbedding1
			if (text === body2) return mockEmbedding2
			return null
		})

		const result = await areNodesEquivalent(node1, node2, embeddingService, "test.ts")
		expect(result).toBe(true)
		expect(embeddingService.embedText).toHaveBeenCalledWith(body1)
		expect(embeddingService.embedText).toHaveBeenCalledWith(body2)
	})

	it("should fallback to text comparison when embeddings fail", async () => {
		const body = "return 42;"
		const node1 = createMockNode("function_declaration", "test", 0, body)
		const node2 = createMockNode("function_declaration", "test", 0, body)

		embeddingService.embedText.mockResolvedValue(null)

		const result = await areNodesEquivalent(node1, node2, embeddingService, "test.ts")
		expect(result).toBe(true)
	})
})

describe("getFunctionModifications", () => {
	let embeddingService: jest.Mocked<NebiusEmbeddingService>

	beforeEach(() => {
		embeddingService = new NebiusEmbeddingService("dummy-key") as jest.Mocked<NebiusEmbeddingService>
	})

	it("should handle unsupported file extensions", async () => {
		const result = await getFunctionModifications(
			"function test() {}",
			"function test() { return 42; }",
			"test.invalid",
			embeddingService,
		)
		expect(result).toBeNull()
	})

	// Add more test cases for getFunctionModifications here
	// These would need more complex setup with Tree-sitter parsers
})

// Add cache tests
describe("Caching", () => {
	it("should cache embedding results", async () => {
		const embeddingService = new NebiusEmbeddingService("dummy-key")
		const text = "test function body"

		// First call should make API request
		const result1 = await embeddingService.embedText(text)

		// Second call should use cache
		const result2 = await embeddingService.embedText(text)

		expect(result1).toEqual(result2)
		// Verify only one API call was made
		expect(fetch).toHaveBeenCalledTimes(1)
	})
})
