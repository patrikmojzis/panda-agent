import type {AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage} from "@mariozechner/pi-ai";

import {PiAiRuntime} from "../../../integrations/providers/shared/runtime.js";
import type {LlmRuntime} from "../../../kernel/agent/runtime.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {resolveModelSelector} from "../../../kernel/models/model-selector.js";
import {renderImageBriefPrompt, renderImageBriefUserInput} from "../../../prompts/runtime/image-brief.js";
import {isRecord} from "../../../lib/records.js";
import {trimToNull} from "../../../lib/strings.js";

export interface ImagePromptComposition {
  compiledPrompt: string;
  contextEnabled: boolean;
  contextUsed: boolean;
  contextMessages: number;
  briefChars: number;
  promptChars: number;
  compiledPromptChars: number;
  briefModel?: string;
  contextError?: string;
}

export interface ComposeImagePromptOptions {
  prompt: string;
  messages: readonly Message[];
  contextEnabled: boolean;
  env?: NodeJS.ProcessEnv;
  runtime?: Pick<LlmRuntime, "complete">;
  signal?: AbortSignal;
  maxMessages?: number;
  maxBriefChars?: number;
  maxFinalPromptChars?: number;
}

export const DEFAULT_IMAGE_CONTEXT_MESSAGES = 16;
export const DEFAULT_IMAGE_BRIEF_MAX_CHARS = 4_000;
export const DEFAULT_IMAGE_FINAL_PROMPT_MAX_CHARS = 12_000;
export const DEFAULT_IMAGE_BRIEF_MODEL = "openai-codex/gpt-5.4-mini";

const MAX_TRANSCRIPT_MESSAGE_CHARS = 1_200;
const IMAGE_CONTEXT_TOOL_NAMES = new Set(["image_generate", "view_media"]);

export interface ImageBriefTranscriptMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

function envDisablesImageContext(env: NodeJS.ProcessEnv): boolean {
  return /^(0|false|off|no)$/i.test(env.PANDA_IMAGE_CONTEXT_DEFAULT?.trim() ?? "");
}

export function resolveImageContextEnabled(params: {
  requested?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (params.requested !== undefined) {
    return params.requested;
  }

  return !envDisablesImageContext(params.env ?? process.env);
}

function trimText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxChars - 16)).trimEnd()} [truncated]`;
}

function userMessageText(message: UserMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content.flatMap((part) => {
    if (part.type === "text" && part.text.trim()) {
      return [part.text];
    }
    if (part.type === "image") {
      return ["[image attachment omitted]"];
    }
    return [];
  }).join("\n");
}

function valueLabel(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function renderRecordFields(value: unknown, fields: readonly string[]): string[] {
  if (!isRecord(value)) {
    return [];
  }

  return fields.flatMap((field) => {
    const label = valueLabel(value[field]);
    return label ? [`${field}: ${label}`] : [];
  });
}

function renderStringArray(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return entries.length > 0 ? entries.join(", ") : null;
}

function imageGenerateToolCallText(call: ToolCall): string | null {
  if (call.name !== "image_generate") {
    return null;
  }

  const args = call.arguments ?? {};
  const parts = [
    "image_generate request",
    ...renderRecordFields(args, [
      "prompt",
      "size",
      "quality",
      "outputFormat",
      "background",
      "moderation",
      "count",
    ]),
  ];
  const images = renderStringArray(args.images);
  if (images) {
    parts.push(`referenceImages: ${images}`);
  }

  return parts.length > 1 ? parts.join("\n") : null;
}

function assistantMessageText(message: AssistantMessage): string {
  return message.content.flatMap((part) => {
    if (part.type === "text" && part.text.trim()) {
      return [part.text];
    }

    if (part.type === "toolCall") {
      const imageText = imageGenerateToolCallText(part);
      return imageText ? [imageText] : [];
    }

    return [];
  }).join("\n");
}

function renderImageGenerateResultDetails(details: unknown): string[] {
  if (!isRecord(details)) {
    return [];
  }

  const parts: string[] = [];
  if (Array.isArray(details.images)) {
    for (const [index, image] of details.images.entries()) {
      const imageParts = renderRecordFields(image, ["path", "revisedPrompt", "mimeType"]);
      if (imageParts.length > 0) {
        parts.push(`generatedImage ${index + 1}\n${imageParts.join("\n")}`);
      }
    }
  }

  if (isRecord(details.settings)) {
    const settings = renderRecordFields(details.settings, ["size", "quality", "outputFormat", "background"]);
    if (settings.length > 0) {
      parts.push(`settings\n${settings.join("\n")}`);
    }
  }

  return parts;
}

function renderViewMediaResultDetails(details: unknown): string[] {
  if (!isRecord(details)) {
    return [];
  }

  const fields = renderRecordFields(details, ["path", "originalPath", "mimeType", "width", "height"]);
  return fields.length > 0 ? [`viewed media\n${fields.join("\n")}`] : [];
}

function toolResultMessageText(message: ToolResultMessage): string {
  if (!IMAGE_CONTEXT_TOOL_NAMES.has(message.toolName)) {
    return "";
  }

  const text = message.content.flatMap((part) => {
    return part.type === "text" && part.text.trim() ? [part.text] : [];
  }).join("\n");
  const detailParts = message.toolName === "image_generate"
    ? renderImageGenerateResultDetails(message.details)
    : renderViewMediaResultDetails(message.details);
  if (!text && detailParts.length === 0) {
    return "";
  }

  return [
    `${message.toolName} result`,
    ...(text ? [text] : []),
    ...detailParts,
  ].join("\n");
}

function messageText(message: Message): string {
  switch (message.role) {
    case "user":
      return userMessageText(message);
    case "assistant":
      return assistantMessageText(message);
    case "toolResult":
      return toolResultMessageText(message);
  }
}

export function collectImageBriefTranscriptMessages(
  messages: readonly Message[],
  maxMessages: number = DEFAULT_IMAGE_CONTEXT_MESSAGES,
): ImageBriefTranscriptMessage[] {
  return messages
    .flatMap((message) => {
      const text = trimToNull(messageText(message));
      if (!text) {
        return [];
      }

      const role: ImageBriefTranscriptMessage["role"] = message.role === "toolResult" ? "tool" : message.role;
      return [{
        role,
        text: trimText(text, MAX_TRANSCRIPT_MESSAGE_CHARS),
      }];
    })
    .slice(-maxMessages);
}

export function renderImageBriefTranscript(
  messages: readonly ImageBriefTranscriptMessage[],
): string {
  return messages
    .map((message, index) => `[${index + 1}] ${message.role}\n${message.text}`)
    .join("\n\n");
}

export function buildCompiledImagePrompt(params: {
  prompt: string;
  brief?: string;
  maxChars?: number;
}): string {
  const maxChars = params.maxChars ?? DEFAULT_IMAGE_FINAL_PROMPT_MAX_CHARS;
  const prompt = trimText(params.prompt, maxChars);
  const brief = trimToNull(params.brief);

  if (!brief) {
    return prompt;
  }

  const suffix = `\n\nCurrent image request:\n${prompt}`;
  const prefix = "Conversation brief:\n";
  const briefBudget = maxChars - prefix.length - suffix.length;
  if (briefBudget < 400) {
    return prompt;
  }

  return `${prefix}${trimText(brief, briefBudget)}${suffix}`;
}

function extractAssistantText(message: Awaited<ReturnType<LlmRuntime["complete"]>>): string {
  return message.content.flatMap((part) => {
    return part.type === "text" && part.text.trim() ? [part.text.trim()] : [];
  }).join("\n\n").trim();
}

export async function composeImagePrompt(
  options: ComposeImagePromptOptions,
): Promise<ImagePromptComposition> {
  const maxBriefChars = options.maxBriefChars ?? DEFAULT_IMAGE_BRIEF_MAX_CHARS;
  const maxFinalPromptChars = options.maxFinalPromptChars ?? DEFAULT_IMAGE_FINAL_PROMPT_MAX_CHARS;
  const promptChars = options.prompt.length;

  if (!options.contextEnabled) {
    const compiledPrompt = buildCompiledImagePrompt({
      prompt: options.prompt,
      maxChars: maxFinalPromptChars,
    });
    return {
      compiledPrompt,
      contextEnabled: false,
      contextUsed: false,
      contextMessages: 0,
      briefChars: 0,
      promptChars,
      compiledPromptChars: compiledPrompt.length,
    };
  }

  const transcriptMessages = collectImageBriefTranscriptMessages(
    options.messages,
    options.maxMessages ?? DEFAULT_IMAGE_CONTEXT_MESSAGES,
  );
  if (transcriptMessages.length === 0) {
    const compiledPrompt = buildCompiledImagePrompt({
      prompt: options.prompt,
      maxChars: maxFinalPromptChars,
    });
    return {
      compiledPrompt,
      contextEnabled: true,
      contextUsed: false,
      contextMessages: 0,
      briefChars: 0,
      promptChars,
      compiledPromptChars: compiledPrompt.length,
    };
  }

  const runtime = options.runtime ?? new PiAiRuntime();
  const model = trimToNull(options.env?.PANDA_IMAGE_BRIEF_MODEL) ?? DEFAULT_IMAGE_BRIEF_MODEL;
  const modelSelection = resolveModelSelector(model);
  const response = await runtime.complete({
    providerName: modelSelection.providerName,
    modelId: modelSelection.modelId,
    signal: options.signal,
    context: {
      systemPrompt: renderImageBriefPrompt(maxBriefChars),
      messages: [stringToUserMessage(renderImageBriefUserInput({
        transcript: renderImageBriefTranscript(transcriptMessages),
        prompt: options.prompt,
      }))],
    },
  });

  const brief = trimText(extractAssistantText(response), maxBriefChars);
  const compiledPrompt = buildCompiledImagePrompt({
    prompt: options.prompt,
    brief,
    maxChars: maxFinalPromptChars,
  });

  return {
    compiledPrompt,
    contextEnabled: true,
    contextUsed: brief.length > 0,
    contextMessages: transcriptMessages.length,
    briefChars: brief.length,
    promptChars,
    compiledPromptChars: compiledPrompt.length,
    briefModel: modelSelection.canonical,
  };
}
