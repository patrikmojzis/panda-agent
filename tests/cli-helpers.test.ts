import { describe, expect, it } from "vitest";

import {
  applySlashCompletion,
  getSlashCompletionContext,
} from "../src/features/tui/commands.js";
import {
  createComposerState,
  insertText,
  moveCursorDown,
  moveCursorLineEnd,
  moveCursorUp,
  setComposerValue,
} from "../src/features/tui/composer.js";

describe("composer helpers", () => {
  it("moves through multiline content while preserving the preferred column", () => {
    let state = createComposerState("alpha\nbe\ncharlie");

    state = setComposerValue(state, state.value, 4);
    state = moveCursorDown(state);
    expect(state.cursor).toBe("alpha\nbe".length);

    state = moveCursorDown(state);
    expect(state.cursor).toBe("alpha\nbe\nchar".length);

    state = moveCursorUp(state);
    expect(state.cursor).toBe("alpha\nbe".length);
  });

  it("keeps line-end movement aligned after inserting a newline", () => {
    let state = createComposerState("hello");

    state = moveCursorLineEnd(state);
    state = insertText(state, "\nworld");
    state = moveCursorLineEnd(state);
    expect(state.value).toBe("hello\nworld");
    expect(state.cursor).toBe(state.value.length);
  });
});

describe("slash command helpers", () => {
  it("finds slash completion only on the first line around the cursor", () => {
    const context = getSlashCompletionContext("/pro", 4);
    const thinkingContext = getSlashCompletionContext("/thi", 4);

    expect(context?.token).toBe("/pro");
    expect(context?.matches.map((command) => command.name)).toEqual(["/provider"]);
    expect(thinkingContext?.matches.map((command) => command.name)).toEqual(["/thinking"]);
    expect(getSlashCompletionContext("hello\n/pro", 9)).toBeNull();
  });

  it("applies slash completion with trailing space for commands expecting values", () => {
    const context = getSlashCompletionContext("/mod", 4);

    expect(context).not.toBeNull();
    const completed = applySlashCompletion("/mod", context!, context!.matches[0]!);
    expect(completed).toEqual({
      value: "/model ",
      cursor: "/model ".length,
    });
  });
});
