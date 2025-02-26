/**
 * Utility type for mocking Jest functions
 */
export type MockType<T> = {
	[P in keyof T]: T[P] extends (...args: any[]) => any
		? jest.Mock<ReturnType<T[P]>, Parameters<T[P]>>
		: T[P] extends object
			? MockType<T[P]>
			: T[P]
}

/**
 * Another version that provides more specific typing for promise-returning functions
 */
export type AsyncMockType<T> = {
	[P in keyof T]: T[P] extends (...args: any[]) => Promise<infer R>
		? jest.Mock<Promise<R>, Parameters<T[P]>>
		: T[P] extends (...args: any[]) => any
			? jest.Mock<ReturnType<T[P]>, Parameters<T[P]>>
			: T[P] extends object
				? AsyncMockType<T[P]>
				: T[P]
}

/**
 * Helper to safely type the mocked values in tests
 */
declare global {
	namespace jest {
		interface Mock<T = any> {
			<U extends T>(value: U): jest.Mock<T, any[]>
			mockResolvedValue(value: T): this
			mockResolvedValueOnce(value: T): this
			mockRejectedValue(value: any): this
			mockRejectedValueOnce(value: any): this
			mockReturnValue(value: T): this
			mockReturnValueOnce(value: T): this
		}
	}
}
