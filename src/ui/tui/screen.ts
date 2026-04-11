import {stripAnsi} from "./theme.js";

export const ALT_SCREEN_ON = "\u001b[?1049h";
export const ALT_SCREEN_OFF = "\u001b[?1049l";
export const CLEAR_SCREEN = "\u001b[2J\u001b[H";
export const HIDE_CURSOR = "\u001b[?25l";
export const SHOW_CURSOR = "\u001b[?25h";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function cursorTo(row: number, column: number): string {
  return `\u001b[${row};${column}H`;
}

export function padAnsiEnd(value: string, width: number): string {
  const visibleLength = stripAnsi(value).length;
  if (visibleLength >= width) {
    return value;
  }

  return value + " ".repeat(width - visibleLength);
}

export function truncatePlainText(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value;
  }

  if (width === 1) {
    return "…";
  }

  return value.slice(0, width - 1) + "…";
}

export function wrapPlainText(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }

  const sourceLines = text.length === 0 ? [""] : text.split("\n");
  const wrapped: string[] = [];

  for (const sourceLine of sourceLines) {
    if (sourceLine.length === 0) {
      wrapped.push("");
      continue;
    }

    for (let index = 0; index < sourceLine.length; index += width) {
      wrapped.push(sourceLine.slice(index, index + width));
    }
  }

  return wrapped;
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}
