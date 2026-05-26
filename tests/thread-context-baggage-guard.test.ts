import {readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";

import {describe, expect, it} from "vitest";

const repoRoot = process.cwd();
const self = "tests/thread-context-baggage-guard.test.ts";
const removedWorkerContextPath = ["thread", "context", "worker"].join(".");
const staleCwdPhrase = ["stored", "thread", "cwd"].join(" ");
const currentThreadContextAccessPattern = new RegExp(["currentThread", "context"].join("\\."), "g");

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(absolute));
    } else if (entry.endsWith(".ts") || entry.endsWith(".md")) {
      files.push(absolute);
    }
  }
  return files;
}

function relativePath(absolute: string): string {
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function topLevelProperties(source: string, objectStart: number, objectEnd: number): Set<string> {
  const properties = new Set<string>();
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = objectStart; index < objectEnd; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 1 || !/[A-Za-z_]/.test(char)) {
      continue;
    }

    let end = index + 1;
    while (end < objectEnd && /[A-Za-z0-9_$]/.test(source[end] ?? "")) {
      end += 1;
    }
    const name = source.slice(index, end);
    let cursor = end;
    while (cursor < objectEnd && /\s/.test(source[cursor] ?? "")) {
      cursor += 1;
    }
    if (source[cursor] === ":") {
      properties.add(name);
    }
    index = end - 1;
  }

  return properties;
}

function hasTopLevelContextProperty(source: string, objectStart: number, objectEnd: number): boolean {
  return topLevelProperties(source, objectStart, objectEnd).has("context");
}

function scanObjectCall(
  source: string,
  file: string,
  pattern: RegExp,
  label: string,
): string[] {
  const violations: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const openIndex = source.indexOf("{", match.index);
    if (openIndex === -1) continue;
    const objectEnd = findMatchingBrace(source, openIndex);
    if (objectEnd === -1) continue;
    if (hasTopLevelContextProperty(source, openIndex, objectEnd)) {
      violations.push(`${file}:${lineNumber(source, match.index)} ${label}`);
    }
  }
  return violations;
}

function scanCreateSessionThreadFixture(source: string, file: string): string[] {
  const violations: string[] = [];
  for (const match of source.matchAll(/createSessionWithInitialThread\s*\(\s*\{/g)) {
    const callStart = source.indexOf("{", match.index);
    const callEnd = findMatchingBrace(source, callStart);
    if (callEnd === -1) continue;
    const callBody = source.slice(callStart, callEnd);
    const threadMatch = /thread\s*:\s*\{/.exec(callBody);
    if (!threadMatch) continue;
    const threadStart = callStart + threadMatch.index + threadMatch[0].length - 1;
    const threadEnd = findMatchingBrace(source, threadStart);
    if (threadEnd === -1) continue;
    if (hasTopLevelContextProperty(source, threadStart, threadEnd)) {
      violations.push(`${file}:${lineNumber(source, threadStart)} createSessionWithInitialThread thread.context fixture`);
    }
  }
  return violations;
}

function scanThreadRecordLikeFixture(source: string, file: string): string[] {
  const violations: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "{") continue;
    const objectEnd = findMatchingBrace(source, index);
    if (objectEnd === -1) continue;
    const properties = topLevelProperties(source, index, objectEnd);
    if (["id", "sessionId", "createdAt", "updatedAt", "context"].every((property) => properties.has(property))) {
      violations.push(`${file}:${lineNumber(source, index)} ThreadRecord-like context fixture`);
    }
  }
  return violations;
}

function collectDurableThreadContextBaggage(): string[] {
  const files = [
    ...listSourceFiles(path.join(repoRoot, "tests")),
    ...listSourceFiles(path.join(repoRoot, "docs", "developers")),
  ];
  const violations: string[] = [];

  for (const absolute of files) {
    const file = relativePath(absolute);
    if (file === self) continue;
    const source = readFileSync(absolute, "utf8");

    if (source.includes(removedWorkerContextPath)) {
      violations.push(`${file} documents removed worker thread-context path`);
    }
    if (source.includes(staleCwdPhrase)) {
      violations.push(`${file} references stale thread cwd phrase`);
    }
    for (const match of source.matchAll(currentThreadContextAccessPattern)) {
      violations.push(`${file}:${lineNumber(source, match.index)} currentThread context access`);
    }

    violations.push(...scanObjectCall(source, file, /\bcreateThread\s*\(\s*\{/g, "createThread context fixture"));
    violations.push(...scanObjectCall(source, file, /currentThread\s*=\s*\{/g, "currentThread context fixture"));
    violations.push(...scanObjectCall(source, file, /currentThread\s*:\s*\{/g, "currentThread context fixture"));
    violations.push(...scanCreateSessionThreadFixture(source, file));
    violations.push(...scanThreadRecordLikeFixture(source, file));
  }

  return violations;
}

describe("durable thread context baggage guard", () => {
  it("keeps removed thread context shapes out of docs and fixtures", () => {
    expect(collectDurableThreadContextBaggage()).toEqual([]);
  });
});
