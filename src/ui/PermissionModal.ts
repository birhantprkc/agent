// Shared helpers for the permission modal (OpenTUI renders the UI).

// Tools whose `detail` is the literal thing being executed/sent.
const COMMAND_TOOLS = new Set([
  'shell',
  'bash',
  'BashTool',
  'http',
  'file_write',
  'FileWriteTool',
  'file_edit',
  'FileEditTool',
]);

/** True when the request's detail is an exact command/payload worth showing. */
export function isCommandTool(tool: string): boolean {
  return COMMAND_TOOLS.has(tool);
}
