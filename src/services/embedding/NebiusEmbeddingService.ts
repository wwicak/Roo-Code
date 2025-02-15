import OpenAI from "openai"

export class NebiusEmbeddingService {
	private client: OpenAI

	constructor() {
		this.client = new OpenAI({
			baseURL: "https://api.studio.nebius.ai/v1/",
			apiKey: "eyJhbGciOiJIUzI1NiIsImtpZCI6IlV6SXJWd1h0dnprLVRvdzlLZWstc0M1akptWXBvX1VaVkxUZlpnMDRlOFUiLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiJnb29nbGUtb2F1dGgyfDEwNTc0NDkwNDMzOTc4MDE2NjkyMiIsInNjb3BlIjoib3BlbmlkIG9mZmxpbmVfYWNjZXNzIiwiaXNzIjoiYXBpX2tleV9pc3N1ZXIiLCJhdWQiOlsiaHR0cHM6Ly9uZWJpdXMtaW5mZXJlbmNlLmV1LmF1dGgwLmNvbS9hcGkvdjIvIl0sImV4cCI6MTg5NzI4Mjg0MiwidXVpZCI6IjA0NjYxNDhjLTJkYzEtNGEzMy1hOTU1LTM2MDUxMzg0NzVlNSIsIm5hbWUiOiJkaWZmIiwiZXhwaXJlc19hdCI6IjIwMzAtMDItMTRUMDc6MDA6NDIrMDAwMCJ9.VCOD4QfxwPhiHqlFFXps2dZwjap0iGf3lyaK_GjpGBU",
		})
	}

	async embedText(text: string): Promise<number[] | null> {
		try {
			const response = await this.client.embeddings.create({
				model: "BAAI/bge-en-icl",
				input: text,
			})

			if (response.data && response.data.length > 0) {
				return response.data[0].embedding
			} else {
				console.error("Nebius embedding API returned an empty response.")
				return null
			}
		} catch (error) {
			console.error("Error in Nebius embedding:", error)
			return null
		}
	}
}
