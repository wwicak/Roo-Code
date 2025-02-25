export function cosineSimilarity(vecA: number[], vecB: number[]): number {
	if (vecA.length !== vecB.length) {
		throw new Error("Vectors must have the same dimensions")
	}

	let dotProduct = 0
	let magnitudeA = 0
	let magnitudeB = 0

	for (let i = 0; i < vecA.length; i++) {
		dotProduct += vecA[i] * vecB[i]
		magnitudeA += vecA[i] * vecA[i]
		magnitudeB += vecB[i] * vecB[i]
	}

	magnitudeA = Math.sqrt(magnitudeA)
	magnitudeB = Math.sqrt(magnitudeB)

	if (magnitudeA === 0 || magnitudeB === 0) {
		return 0 // Handle cases where one or both vectors have zero magnitude
	}

	return dotProduct / (magnitudeA * magnitudeB)
}
