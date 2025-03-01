// Mock for web-tree-sitter
let mockTree = null

const Parser = jest.fn().mockImplementation(() => ({
	setLanguage: jest.fn(),
	parse: jest.fn().mockReturnValue(mockTree),
}))

// Static methods
Parser.init = jest.fn().mockResolvedValue(undefined)

// Static properties
Parser.Language = {
	load: jest.fn().mockResolvedValue({
		query: jest.fn().mockReturnValue({}),
	}),
}

// Helper method to set mock tree for tests
function __setMockTree(tree) {
	mockTree = tree
	return tree
}

// Export the mocked Parser and helper
module.exports = Parser
module.exports.init = Parser.init
module.exports.Language = Parser.Language
module.exports.__setMockTree = __setMockTree
