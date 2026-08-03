import {isRecord} from "../../../lib/records.js";
import {resolveOpenAICodexOauthToken} from "../shared/auth.js";

export interface OpenAILiveAuth {token: string; accountId: string}

function decodePayload(token: string): Record<string, unknown> | null {
  const encoded = token.split(".")[1];
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch { return null; }
}

/** Reads Codex OAuth afresh for every transient GPT-Live session. */
export function resolveOpenAILiveAuth(env: NodeJS.ProcessEnv = process.env): OpenAILiveAuth {
  const token = resolveOpenAICodexOauthToken({env});
  if (!token) throw new Error("Codex OAuth is unavailable.");
  const payload = decodePayload(token);
  const authClaim = payload?.["https://api.openai.com/auth"];
  const accountId = isRecord(authClaim) && typeof authClaim.chatgpt_account_id === "string"
    ? authClaim.chatgpt_account_id.trim()
    : typeof payload?.chatgpt_account_id === "string" ? payload.chatgpt_account_id.trim() : "";
  const expiresAt = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  if (expiresAt !== undefined && expiresAt <= Date.now()) throw new Error("Codex OAuth is expired.");
  if (!accountId) throw new Error("Codex OAuth is missing chatgpt_account_id.");
  return {token, accountId};
}
