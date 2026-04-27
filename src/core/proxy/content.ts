/**
 * Shared content-flattening helpers for proxy code.
 *
 * Tool results / function-call outputs come back from agents in
 * inconsistent shapes — sometimes a string, sometimes an array of
 * `{type:'text',text}` blocks, sometimes a bare object. The proxy
 * needs a flat string representation for tool log emission and
 * synthetic substitutions.
 */

/**
 * Flatten arbitrary content (string, array of blocks, or unknown
 * object) to a plain string. Used by both the Anthropic proxy
 * (`tool_result.content`) and the OpenAI Responses proxy
 * (`function_call_output.output`).
 */
export function flattenToText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((item: any) => {
        if (item == null) return '';
        if (typeof item === 'string') return item;
        if (item.type === 'text' && typeof item.text === 'string') return item.text;
        if (typeof item.text === 'string') return item.text;
        return JSON.stringify(item);
      })
      .join('\n');
  }
  if (c == null) return '';
  return JSON.stringify(c);
}
