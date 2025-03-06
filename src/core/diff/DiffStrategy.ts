import type { DiffStrategy } from "./types"
import { UnifiedDiffStrategy } from "./strategies/unified"
import { SearchReplaceDiffStrategy } from "./strategies/search-replace"
import { NewUnifiedDiffStrategy } from "./strategies/new-unified"
import { AstDiffStrategy } from "./strategies/astDiffStrategy"
import { NebiusEmbeddingService } from "../../services/embedding/NebiusEmbeddingService"
/**
 * Get the appropriate diff strategy for the given model
 * @param model The name of the model being used (e.g., 'gpt-4', 'claude-3-opus')
 * @returns The appropriate diff strategy for the model
 */
export function getDiffStrategy(
	model: string,
	fuzzyMatchThreshold?: number,
	experimentalDiffStrategy: boolean = false,
): DiffStrategy {
	const embeddingService = new NebiusEmbeddingService("")

	// Prioritize AST-based diffing for advanced models
	const astSupportedModels = ["claude-3-opus", "gpt-4", "gemini-pro"]
	if (astSupportedModels.some((m) => model.includes(m))) {
		return new AstDiffStrategy(embeddingService)
	}

	if (experimentalDiffStrategy) {
		return new NewUnifiedDiffStrategy(fuzzyMatchThreshold)
	}
	return new SearchReplaceDiffStrategy(fuzzyMatchThreshold)
}

export type { DiffStrategy }
export { UnifiedDiffStrategy, SearchReplaceDiffStrategy, AstDiffStrategy }
