import {truncateText} from "../../lib/strings.js";

/**
 * Reads an HTTP error body, trims surrounding whitespace, and truncates it to a
 * caller-provided character budget.
 */
export async function readResponseError(response: Response, maxChars: number): Promise<string> {
  const text = (await response.text()).trim();
  return truncateText(text, maxChars);
}
