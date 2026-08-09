import {describe, expect, it, vi} from "vitest";

import {resolveOpenAILiveAuth} from "../src/integrations/providers/openai-live/auth.js";
import {buildHeaders, buildSession, createOpenAILiveCall, createRequestIds, delegationContextMessages, parseOpenAILiveEvent, sessionContextMessages} from "../src/integrations/providers/openai-live/wire.js";

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
        }),
      });
      expect(JSON.parse(String(init?.body)).session).not.toHaveProperty("initial_items");
      expect(JSON.parse(String(init?.body)).session.instructions).toContain("asks you to leave or disconnect from voice");
      return new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}});
    });
    await expect(createOpenAILiveCall({
      auth: {token: "secret", accountId: "acct-1"}, ids: createRequestIds(), offerSdp: "offer-sdp", voice: "cove",
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
    const messages = delegationContextMessages("delegation-1", "é".repeat(800), "commentary");
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => Buffer.byteLength(JSON.parse(message).content[0].text) <= 500)).toBe(true);
    expect(JSON.parse(messages[0]!)).toMatchObject({type: "delegation.context.append", channel: "commentary"});
    expect(JSON.parse(sessionContextMessages("done", "speakable")[0]!)).toMatchObject({type: "session.context.append", channel: "speakable"});
  });

  it("retains only bounded completed-turn text for transient reconnect context", () => {
    const parsed = parseOpenAILiveEvent(JSON.stringify({type: "turn.done", turn: {role: "user", transcript: "hello there"}}));
    expect(parsed).toEqual({kind: "turn_done", role: "user", transcript: "hello there", transcriptChars: 11, transcriptBytes: 11, truncated: false});
  });

  it("reports malformed and transcript events without retaining transcript text", () => {
    expect(parseOpenAILiveEvent("not json")).toEqual({kind: "malformed", reason: "invalid_json"});
    expect(parseOpenAILiveEvent(JSON.stringify({type: "conversation.item.input_audio_transcription.completed", transcript: "čau panda"})))
      .toEqual({kind: "transcript_metadata", type: "conversation.item.input_audio_transcription.completed", role: "unknown", transcriptChars: 9, transcriptBytes: 10, truncated: false});
  });

  it("never exposes the OAuth bearer through structured errors", () => {
    const headers = buildHeaders({token: "private-token", accountId: "acct-1"}, createRequestIds());
    expect(headers.Authorization).toBe("Bearer private-token");
    expect(JSON.stringify(parseOpenAILiveEvent(JSON.stringify({type: "error", error: {status: 401, message: "unauthorized"}})))).not.toContain("private-token");
  });

  it("seeds a replacement call with bounded role-bearing history and optional delegation acknowledgement", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const session = JSON.parse(String(init?.body)).session;
      expect(session.initial_items).toEqual([
        {type: "message", role: "user", content: [{type: "input_text", text: "what is the weather?"}]},
        {type: "message", role: "assistant", content: [{type: "output_text", text: "It is sunny."}]},
      ]);
      expect(session.delegation).toEqual({type: "client", ack_filler: true});
      return new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}});
    });

    await createOpenAILiveCall({
      auth: {token: "secret", accountId: "acct-1"}, ids: createRequestIds(), offerSdp: "offer-sdp", voice: "cove",
      initialItems: [{role: "user", text: "what is the weather?"}, {role: "assistant", text: "It is sunny."}],
      delegationAckFiller: true,
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps the most recent reconnect history within the provider payload bound", () => {
    const history = Array.from({length: 40}, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `${index}:`.padEnd(1_000, "x"),
    }));

    const items = buildSession("cove", {initialItems: history}).initial_items ?? [];
    const text = items.flatMap((item) => item.content.map((content) => content.text));

    expect(items.length).toBeLessThanOrEqual(32);
    expect(text.reduce((total, item) => total + item.length, 0)).toBeLessThanOrEqual(8_192);
    expect(text.at(-1)).toContain("39:");
    expect(text.some((item) => item.includes("0:"))).toBe(false);
  });
});
