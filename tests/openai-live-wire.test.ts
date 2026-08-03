import {describe, expect, it, vi} from "vitest";

import {resolveOpenAILiveAuth} from "../src/integrations/providers/openai-live/auth.js";
import {buildHeaders, createOpenAILiveCall, createRequestIds, delegationAppendMessages, parseOpenAILiveEvent, sessionSpeechMessages} from "../src/integrations/providers/openai-live/wire.js";

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("experimental OpenAI GPT-Live wire", () => {
  it("extracts account identity and rejects expired Codex OAuth", () => {
    const token = jwt({exp: Math.floor(Date.now() / 1000) + 60, "https://api.openai.com/auth": {chatgpt_account_id: "acct-1"}});
    expect(resolveOpenAILiveAuth({OPENAI_OAUTH_TOKEN: token})).toEqual({token, accountId: "acct-1"});
    expect(() => resolveOpenAILiveAuth({OPENAI_OAUTH_TOKEN: jwt({exp: 1, chatgpt_account_id: "acct-1"})})).toThrow("expired");
  });

  it("creates a ChatGPT Codex backend call with the frameless session", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json",
        "OpenAI-Alpha": "quicksilver=v2",
        "chatgpt-account-id": "acct-1",
        originator: "panda-agent",
        version: "0.1.0",
        "User-Agent": "panda-agent/0.1.0",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        sdp: "offer-sdp",
        session: expect.objectContaining({
          model: "gpt-live-1-codex",
          audio: {output: {voice: "cove"}},
          delegation: {type: "client"},
          instructions: expect.stringContaining("Wait silently until a participant speaks"),
          initial_items: [
            {type: "message", role: "user", content: [{type: "input_text", text: "hello"}]},
            {type: "message", role: "assistant", content: [{type: "output_text", text: "hi"}]},
          ],
        }),
      });
      return new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}});
    });
    await expect(createOpenAILiveCall({
      auth: {token: "secret", accountId: "acct-1"}, ids: createRequestIds(), offerSdp: "offer-sdp", voice: "cove",
      initialItems: [{role: "user", text: "hello"}, {role: "assistant", text: "hi"}],
      signal: new AbortController().signal, fetchImpl,
    })).resolves.toEqual({answerSdp: "answer-sdp", sidebandUrl: "wss://api.openai.com/v1/live/rtc_test"});
  });

  it("rejects unsupported V3 voices before making a provider request", async () => {
    const fetchImpl = vi.fn();
    await expect(createOpenAILiveCall({auth: {token: "secret", accountId: "acct-1"}, ids: createRequestIds(), offerSdp: "offer-sdp", voice: "marin", signal: new AbortController().signal, fetchImpl})).rejects.toThrow("Unsupported GPT-Live V3 voice");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps backend failures secret-safe", async () => {
    const fetchImpl = vi.fn(async () => new Response("private-token upstream detail", {status: 403}));
    await expect(createOpenAILiveCall({auth: {token: "private-token", accountId: "acct-1"}, ids: createRequestIds(), offerSdp: "offer-sdp", voice: "cove", signal: new AbortController().signal, fetchImpl})).rejects.not.toThrow("private-token");
  });

  it("parses bounded client delegations and chunks speakable results", () => {
    expect(parseOpenAILiveEvent(JSON.stringify({type: "delegation.created", item: {type: "delegation", target: "client", id: "delegation-1", content: [{type: "input_text", text: "check memory"}]}}))).toEqual({kind: "delegation", id: "delegation-1", prompt: "check memory"});
    const messages = delegationAppendMessages("delegation-1", "é".repeat(800));
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => Buffer.byteLength(JSON.parse(message).content[0].text) <= 500)).toBe(true);
    expect(JSON.parse(sessionSpeechMessages("done")[0]!)).toMatchObject({type: "session.context.append", channel: "speakable"});
  });

  it("captures completed transcripts for bounded in-memory provider recovery", () => {
    expect(parseOpenAILiveEvent(JSON.stringify({type: "turn.done", turn: {role: "user", transcript: "hello there"}}))).toEqual({kind: "transcript", role: "user", text: "hello there"});
    expect(parseOpenAILiveEvent(JSON.stringify({type: "turn.done", turn: {role: "assistant", transcript: "hi"}}))).toEqual({kind: "transcript", role: "assistant", text: "hi"});
  });

  it("never exposes the OAuth bearer through structured errors", () => {
    const headers = buildHeaders({token: "private-token", accountId: "acct-1"}, createRequestIds());
    expect(headers.Authorization).toBe("Bearer private-token");
    expect(JSON.stringify(parseOpenAILiveEvent(JSON.stringify({type: "error", error: {status: 401, message: "unauthorized"}})))).not.toContain("private-token");
  });
});
