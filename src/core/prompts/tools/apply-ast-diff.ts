import { ToolArgs } from "./types"

export function getApplyAstDiffDescription(args: ToolArgs): string {
	return `## apply_ast_diff
Description: Apply precise code edits using AST-based diffing. This tool parses the original and modified code into Abstract Syntax Trees (ASTs) to identify and apply function-level changes accurately.

Parameters:
- path: (required) The file path to modify (relative to ${args.cwd.toPosix()})
- diff: (required) The full modified content to compare against the original file

Format Requirements:
- Provide the complete new file content in the diff parameter
- The tool will compute the differences using AST analysis

Example:
Original file:
\`\`\`
function add(a, b) {
  return a + b;
}
\`\`\`

Modified content:
\`\`\`
function add(a, b) {
  return a + b + 1;
}
\`\`\`

Usage:
<apply_ast_diff>
<path>src/math.js</path>
<diff>
function add(a, b) {
  return a + b + 1;
}
</diff>
</apply_ast_diff>

IMPORTANT:
- Use this tool for precise function-level edits
- Always provide the complete code with correct indentation
- The tool will automatically handle the diffing and application of changes`
}
