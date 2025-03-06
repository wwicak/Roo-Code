import { Diff, Hunk, Change } from "./types"
import { findBestMatch, prepareSearchString } from "./search-strategies"
import { applyEdit } from "./edit-strategies"
import { DiffResult, DiffStrategy } from "../../types"
import { logger } from "../../../../utils/logging"

export class NewUnifiedDiffStrategy implements DiffStrategy {
	private readonly confidenceThreshold: number

	constructor(confidenceThreshold: number = 1) {
		this.confidenceThreshold = Math.max(confidenceThreshold, 0.8)
	}

	private parseUnifiedDiff(diff: string): Diff {
		const MAX_CONTEXT_LINES = 6 // Number of context lines to keep before/after changes
		const lines = diff.split("\n")
		const hunks: Hunk[] = []
		let currentHunk: Hunk | null = null

		// Check for empty diff
		if (!diff.trim()) {
			logger.warn("Empty diff provided to parseUnifiedDiff")
			return { hunks: [] }
		}

		// Find the first hunk header
		let i = 0
		let foundHunkHeader = false
		while (i < lines.length && !lines[i].startsWith("@@")) {
			// Verify that this looks like a valid unified diff
			if (i === 0 && !lines[i].startsWith("---") && !lines[i].startsWith("diff --git")) {
				logger.warn("Diff does not start with expected header (--- or diff --git)")
			}
			i++
		}

		if (i >= lines.length) {
			logger.warn("No hunk headers (@@) found in diff")
			return { hunks: [] }
		}

		foundHunkHeader = true

		for (; i < lines.length; i++) {
			const line = lines[i]

			if (line.startsWith("@@")) {
				// Process previous hunk if it exists
				if (
					currentHunk &&
					currentHunk.changes.length > 0 &&
					currentHunk.changes.some((change) => change.type === "add" || change.type === "remove")
				) {
					const changes = currentHunk.changes
					let startIdx = 0
					let endIdx = changes.length - 1

					for (let j = 0; j < changes.length; j++) {
						if (changes[j].type !== "context") {
							startIdx = Math.max(0, j - MAX_CONTEXT_LINES)
							break
						}
					}

					for (let j = changes.length - 1; j >= 0; j--) {
						if (changes[j].type !== "context") {
							endIdx = Math.min(changes.length - 1, j + MAX_CONTEXT_LINES)
							break
						}
					}

					const newHunk: Hunk = {
						changes: changes.slice(startIdx, endIdx + 1),
					}
					hunks.push(newHunk)
				}

				// Parse hunk header
				// Format: @@ -oldStart,oldCount +newStart,newCount @@
				const headerMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
				if (!headerMatch) {
					logger.warn(`Malformed hunk header: ${line}`)
					continue // Skip this hunk
				}

				// Create new hunk
				currentHunk = {
					changes: [],
				}
			} else if (currentHunk) {
				// Process line within current hunk
				const indent = line.match(/^(\s*)/)?.[1] || ""

				if (line.startsWith("+")) {
					currentHunk.changes.push({
						type: "add",
						content: line.substring(1),
						indent,
					})
				} else if (line.startsWith("-")) {
					currentHunk.changes.push({
						type: "remove",
						content: line.substring(1),
						indent,
					})
				} else if (line.startsWith(" ")) {
					currentHunk.changes.push({
						type: "context",
						content: line.substring(1),
						indent,
					})
				} else if (line.length === 0) {
					// Empty line (probably a context line without leading space)
					currentHunk.changes.push({
						type: "context",
						content: "",
						indent: "",
					})
				} else {
					// Unexpected line format, treat as context to be safe
					logger.warn(`Unexpected line format in hunk: ${line}`)
					currentHunk.changes.push({
						type: "context",
						content: line,
						indent: "",
					})
				}
			}
		}

		// Don't forget to process the last hunk
		if (
			currentHunk &&
			currentHunk.changes.length > 0 &&
			currentHunk.changes.some((change) => change.type === "add" || change.type === "remove")
		) {
			hunks.push(currentHunk)
		}

		// Return empty hunks if none were found
		if (hunks.length === 0 && foundHunkHeader) {
			logger.warn("No valid hunks found in diff")
		}

		return { hunks }
	}

	getToolDescription(args: { cwd: string; toolOptions?: { [key: string]: string } }): string {
		return `# apply_diff Tool - Generate Precise Code Changes

Generate a unified diff that can be cleanly applied to modify code files.

## Step-by-Step Instructions:

1. Start with file headers:
   - First line: "--- {original_file_path}"
   - Second line: "+++ {new_file_path}"

2. For each change section:
   - Begin with "@@ ... @@" separator line without line numbers
   - Include 2-3 lines of context before and after changes
   - Mark removed lines with "-"
   - Mark added lines with "+"
   - Preserve exact indentation

3. Group related changes:
   - Keep related modifications in the same hunk
   - Start new hunks for logically separate changes
   - When modifying functions/methods, include the entire block

## Requirements:

1. MUST include exact indentation
2. MUST include sufficient context for unique matching
3. MUST group related changes together
4. MUST use proper unified diff format
5. MUST NOT include timestamps in file headers
6. MUST NOT include line numbers in the @@ header

## Examples:

✅ Good diff (follows all requirements):
\`\`\`diff
--- src/utils.ts
+++ src/utils.ts
@@ ... @@
    def calculate_total(items):
-      total = 0
-      for item in items:
-          total += item.price
+      return sum(item.price for item in items)
\`\`\`

❌ Bad diff (violates requirements #1 and #2):
\`\`\`diff
--- src/utils.ts
+++ src/utils.ts
@@ ... @@
-total = 0
-for item in items:
+return sum(item.price for item in items)
\`\`\`

Parameters:
- path: (required) File path relative to ${args.cwd}
- diff: (required) Unified diff content in unified format to apply to the file.

Usage:
<apply_diff>
<path>path/to/file.ext</path>
<diff>
Your diff here
</diff>
</apply_diff>`
	}

	// Helper function to split a hunk into smaller hunks based on contiguous changes
	private splitHunk(hunk: Hunk): Hunk[] {
		const result: Hunk[] = []
		let currentHunk: Hunk | null = null
		let contextBefore: Change[] = []
		let contextAfter: Change[] = []
		const MAX_CONTEXT_LINES = 3 // Keep 3 lines of context before/after changes

		for (let i = 0; i < hunk.changes.length; i++) {
			const change = hunk.changes[i]

			if (change.type === "context") {
				if (!currentHunk) {
					contextBefore.push(change)
					if (contextBefore.length > MAX_CONTEXT_LINES) {
						contextBefore.shift()
					}
				} else {
					contextAfter.push(change)
					if (contextAfter.length > MAX_CONTEXT_LINES) {
						// We've collected enough context after changes, create a new hunk
						currentHunk.changes.push(...contextAfter)
						result.push(currentHunk)
						currentHunk = null
						// Keep the last few context lines for the next hunk
						contextBefore = contextAfter
						contextAfter = []
					}
				}
			} else {
				if (!currentHunk) {
					currentHunk = { changes: [...contextBefore] }
					contextAfter = []
				} else if (contextAfter.length > 0) {
					// Add accumulated context to current hunk
					currentHunk.changes.push(...contextAfter)
					contextAfter = []
				}
				currentHunk.changes.push(change)
			}
		}

		// Add any remaining changes
		if (currentHunk) {
			if (contextAfter.length > 0) {
				currentHunk.changes.push(...contextAfter)
			}
			result.push(currentHunk)
		}

		return result
	}

	async applyDiff(
		originalContent: string,
		diffContent: string,
		startLine?: number,
		endLine?: number,
	): Promise<DiffResult> {
		// Skip empty diffs
		if (!diffContent.trim()) {
			return {
				success: false,
				error: "Empty diff content provided",
			}
		}

		try {
			// Parse the diff
			const diff = this.parseUnifiedDiff(diffContent)

			// Check if diff parsing was successful
			if (diff.hunks.length === 0) {
				return {
					success: false,
					error: "No valid hunks found in diff",
				}
			}

			// Convert original content to lines
			const contentLines = originalContent.split("\n")

			// For each hunk, find the best match and apply the edit
			let modifiedContent = originalContent

			for (const hunk of diff.hunks) {
				// Prepare search string from context lines in the hunk
				const searchStr = prepareSearchString(hunk.changes)

				// Find the best match position in the content
				const matchResult = findBestMatch(searchStr, contentLines, 0, this.confidenceThreshold)

				if (matchResult.confidence < this.confidenceThreshold) {
					return {
						success: false,
						error: `Could not find a good match for the hunk (confidence: ${matchResult.confidence.toFixed(2)})`,
					}
				}

				// Apply the edit using the best matching strategy
				const editResult = await applyEdit(
					hunk,
					contentLines,
					matchResult.index,
					matchResult.confidence,
					this.confidenceThreshold,
				)

				// Update the content for the next iteration
				if (editResult.confidence >= this.confidenceThreshold) {
					modifiedContent = editResult.result.join("\n")
					contentLines.splice(0, contentLines.length, ...editResult.result)
				} else {
					return {
						success: false,
						error: `Failed to apply edit (confidence: ${editResult.confidence.toFixed(2)})`,
					}
				}
			}

			return {
				success: true,
				content: modifiedContent,
			}
		} catch (error) {
			logger.error("Error applying unified diff:", error)
			return {
				success: false,
				error: `Error applying diff: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}
}
