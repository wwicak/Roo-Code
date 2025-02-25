# ADR: Completing Semantic Search Integration

**Objective:** Improve and complete the integration of semantic search functionality in the code mode's `modify_function_body` tool.

## Context

The current implementation has basic semantic search infrastructure in place through:

- NebiusEmbeddingService for text embeddings
- Cosine similarity calculations
- AST-based diffing with semantic comparisons

However, several critical gaps need to be addressed for a production-ready integration.

## Current Gaps

1. **Dependency Injection & Configuration**

    - NebiusEmbeddingService is initialized without proper DI
    - Hardcoded similarity thresholds
    - No configuration for embedding model selection

2. **Error Handling & Resilience**

    - Insufficient error handling for embedding API failures
    - No retry mechanism for failed API calls
    - Basic fallback to string comparison

3. **Performance & Optimization**

    - No caching for embeddings
    - Missing rate limiting for API calls
    - No performance monitoring

4. **Function Body Reconstruction**

    - Incomplete file content reconstruction in modify_function_body
    - No validation of reconstructed content

5. **Testing & Quality Assurance**
    - Missing integration tests
    - No performance benchmarks
    - Limited error case coverage

## Implementation Plan

### Phase 1: Dependency Injection & Configuration

1. Create EmbeddingServiceConfig:

```typescript
// src/services/embedding/types.ts
export interface EmbeddingServiceConfig {
	apiKey: string
	model: string
	similarityThreshold: number
	retryAttempts: number
	cacheDuration: number
}
```

2. Update NebiusEmbeddingService:

```typescript
// src/services/embedding/NebiusEmbeddingService.ts
export class NebiusEmbeddingService {
	constructor(private config: EmbeddingServiceConfig) {}

	// Add configuration getters
	public getSimilarityThreshold(): number {
		return this.config.similarityThreshold
	}
}
```

3. Update ApiConfiguration:

```typescript
// src/shared/api.ts
export interface ApiConfiguration {
	// ... existing fields
	embeddingConfig?: EmbeddingServiceConfig
}
```

### Phase 2: Error Handling & Resilience

1. Create retry utility:

```typescript
// src/utils/retry.ts
export async function withRetry<T>(operation: () => Promise<T>, retries: number, delay: number): Promise<T> {
	try {
		return await operation()
	} catch (error) {
		if (retries === 0) throw error
		await new Promise((resolve) => setTimeout(resolve, delay))
		return withRetry(operation, retries - 1, delay * 2)
	}
}
```

2. Enhance NebiusEmbeddingService:

```typescript
// src/services/embedding/NebiusEmbeddingService.ts
export class NebiusEmbeddingService {
	async embedText(text: string): Promise<number[] | null> {
		return withRetry(
			async () => {
				// Existing embedding logic
			},
			this.config.retryAttempts,
			1000,
		)
	}
}
```

### Phase 3: Performance & Optimization

1. Add embedding cache:

```typescript
// src/services/embedding/cache.ts
export class EmbeddingCache {
	private cache = new Map<string, { embedding: number[]; timestamp: number }>()

	set(text: string, embedding: number[]) {
		this.cache.set(text, {
			embedding,
			timestamp: Date.now(),
		})
	}

	get(text: string, maxAge: number): number[] | null {
		const entry = this.cache.get(text)
		if (!entry) return null
		if (Date.now() - entry.timestamp > maxAge) {
			this.cache.delete(text)
			return null
		}
		return entry.embedding
	}
}
```

2. Integrate cache with NebiusEmbeddingService:

```typescript
export class NebiusEmbeddingService {
	private cache = new EmbeddingCache()

	async embedText(text: string): Promise<number[] | null> {
		const cached = this.cache.get(text, this.config.cacheDuration)
		if (cached) return cached

		const embedding = await this.fetchEmbedding(text)
		if (embedding) {
			this.cache.set(text, embedding)
		}
		return embedding
	}
}
```

### Phase 4: Function Body Reconstruction

1. Create AST-based content reconstruction:

```typescript
// src/core/diff/strategies/new-unified/content-reconstruction.ts
export function reconstructFileContent(
	originalContent: string,
	functionId: string,
	newBody: string,
	languageParser: Parser,
): string {
	const tree = languageParser.parse(originalContent)
	const functionNode = findFunctionNode(tree, functionId)
	if (!functionNode) throw new Error("Function not found")

	// Replace function body in AST
	const bodyNode = functionNode.childForFieldName("body")
	if (!bodyNode) throw new Error("Function body not found")

	return replaceNodeContent(originalContent, bodyNode, newBody)
}

function replaceNodeContent(source: string, node: Parser.SyntaxNode, newContent: string): string {
	return source.slice(0, node.startIndex) + newContent + source.slice(node.endIndex)
}
```

2. Update Cline.ts modify_function_body handler:

```typescript
// src/core/Cline.ts
case "modify_function_body": {
  // ... existing code ...

  const newContent = reconstructFileContent(
    originalContent,
    functionId,
    newBody,
    languageParser
  );

  const modifications = await getFunctionModifications(
    originalContent,
    newContent,
    filePath,
    this.embeddingService
  );
}
```

### Phase 5: Testing & Quality Assurance

1. Add integration tests:

```typescript
// src/services/embedding/__tests__/NebiusEmbeddingService.integration.test.ts
describe("NebiusEmbeddingService Integration", () => {
	test("should handle API failures gracefully", async () => {
		const service = new NebiusEmbeddingService({
			apiKey: "invalid-key",
			retryAttempts: 2,
		})

		await expect(service.embedText("test")).rejects.toThrow("API authentication failed")
	})

	test("should cache embeddings", async () => {
		const service = new NebiusEmbeddingService({
			apiKey: "test-key",
			cacheDuration: 5000,
		})

		const text = "test text"
		const result1 = await service.embedText(text)
		const result2 = await service.embedText(text)

		expect(result1).toEqual(result2)
	})
})
```

2. Add performance benchmarks:

```typescript
// src/benchmark/semantic-search.bench.ts
import { performance } from "perf_hooks"

async function benchmarkEmbedding() {
	const service = new NebiusEmbeddingService(config)
	const samples = generateTestSamples()

	const start = performance.now()
	for (const sample of samples) {
		await service.embedText(sample)
	}
	const end = performance.now()

	return {
		totalTime: end - start,
		averageTime: (end - start) / samples.length,
	}
}
```

## Migration Strategy

1. Roll out changes in phases, starting with the configuration updates
2. Add feature flags for each major component
3. Monitor error rates and performance metrics
4. Gradually enable new features in production
5. Keep fallback mechanisms in place during transition

## Implications

- Improved reliability through proper error handling and retries
- Better performance with caching and optimizations
- Easier maintenance with proper DI and configuration
- Higher confidence through comprehensive testing

## Acceptance Criteria

1. Configuration

    - [ ] All hardcoded values moved to configuration
    - [ ] Proper DI implementation
    - [ ] Feature flags for all new components

2. Error Handling

    - [ ] Retries implemented for API calls
    - [ ] Fallback strategies documented and tested
    - [ ] Error logging and monitoring

3. Performance

    - [ ] Caching implemented and configurable
    - [ ] Rate limiting in place
    - [ ] Performance metrics collection

4. Testing
    - [ ] Integration tests covering main workflows
    - [ ] Performance benchmarks established
    - [ ] Error scenarios tested

## Timeline

- Phase 1 (Configuration): 2 days
- Phase 2 (Error Handling): 2 days
- Phase 3 (Performance): 3 days
- Phase 4 (Reconstruction): 2 days
- Phase 5 (Testing): 3 days

Total: ~2 weeks including testing and refinement
