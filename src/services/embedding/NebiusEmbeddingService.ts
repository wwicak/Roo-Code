export class NebiusEmbeddingService {
	private apiKey: string

	constructor(apiKey: string) {
		this.apiKey =
			"eyJhbGciOiJIUzI1NiIsImtpZCI6IlV6SXJWd1h0dnprLVRvdzlLZWstc0M1akptWXBvX1VaVkxUZlpnMDRlOFUiLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiJnb29nbGUtb2F1dGgyfDEwNTc0NDkwNDMzOTc4MDE2NjkyMiIsInNjb3BlIjoib3BlbmlkIG9mZmxpbmVfYWNjZXNzIiwiaXNzIjoiYXBpX2tleV9pc3N1ZXIiLCJhdWQiOlsiaHR0cHM6Ly9uZWJpdXMtaW5mZXJlbmNlLmV1LmF1dGgwLmNvbS9hcGkvdjIvIl0sImV4cCI6MTg5NzI4Mjg0MiwidXVpZCI6IjA0NjYxNDhjLTJkYzEtNGEzMy1hOTU1LTM2MDUxMzg0NzVlNSIsIm5hbWUiOiJkaWZmIiwiZXhwaXJlc19hdCI6IjIwMzAtMDItMTRUMDc6MDA6NDIrMDAwMCJ9.VCOD4QfxwPhiHqlFFXps2dZwjap0iGf3lyaK_GjpGBU"
	}

	async embedText(text: string): Promise<number[] | null> {
		try {
			const response = await fetch("https://api.studio.nebius.ai/v1/embeddings", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Api-Key ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: "bge-large-en-v1.5",
					text: text,
				}),
			})

			if (!response.ok) {
				const errorData = await response.json()
				throw new Error(
					`Nebius API error: ${response.status} - ${errorData.message || JSON.stringify(errorData)}`,
				)
			}

			const data = await response.json()

			if (data.embedding && data.embedding.length > 0) {
				return data.embedding
			} else {
				console.error("Nebius embedding API returned an empty or invalid response.")
				return null
			}
		} catch (error) {
			console.error("Error in Nebius embedding:", error)
			return null
		}
	}
}
