import { ToolArgs } from "./types"

export function getModifyFunctionBodyDescription(args: ToolArgs): string {
	return `## modify_function_body
Description: Modify the body of an existing function in a TypeScript, JavaScript, Python, Go, C, C++, C#, Ruby, Java, or PHP file. Use this tool whenever you need to change the code *inside* a function. Do NOT use this to add or remove entire functions. Do NOT use this to change the function's signature (name, parameters, return type). This tool automatically handles formatting and indentation.
Parameters:
- path: (required) The path to the file (relative to the current working directory ${args.cwd.toPosix()}).
- function_identifier: (required) An opaque string identifier for the function. (Provided by other tools). Do NOT try to guess or construct this identifier. It will look something like: 'myFunction:5' (function name, colon, line number).
- new_body: (required) The COMPLETE new function body, including correct indentation. This should include all code inside the function's curly braces {}.
Usage:
<modify_function_body>
<path>path/to/file.ts</path>
<function_identifier>myFunction:5</function_identifier>
<new_body>
  // The complete new function body,
  // with correct indentation.
  return x + y;
</new_body>
</modify_function_body>

IMPORTANT:
- You MUST use \`modify_function_body\` for ALL changes *inside* existing functions.
- Do NOT use \`apply_diff\` or \`write_to_file\` to modify existing functions.
- You will receive the \`function_identifier\` from other tools (primarily \`read_file\`). Do NOT guess it.
- You MUST provide the *complete* new function body.`
}
