import {randomUUID} from "node:crypto";
import {mkdir, readFile} from "node:fs/promises";
import path from "node:path";

import type {PersistedEnvEntry} from "./bash-protocol.js";
import type {ShellSession} from "./types.js";

export interface InvocationPaths {
  directory: string;
  cwdStatePath: string;
  envStatePath: string;
  stdoutPath: string;
  stderrPath: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveCommandCwd(commandCwd: string | undefined, baseCwd: string): string {
  if (!commandCwd?.trim()) {
    return baseCwd;
  }

  return path.isAbsolute(commandCwd)
    ? path.resolve(commandCwd)
    : path.resolve(baseCwd, commandCwd);
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function consumeLeadingAssignment(body: string, start: number): { name: string; end: number } | null {
  const slice = body.slice(start);
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*=(?:'(?:[^']*)'|"(?:\\.|[^"])*"|[^ \t]+))?/.exec(slice);
  if (!match || !match[1]) {
    return null;
  }

  return {
    name: match[1],
    end: start + match[0].length,
  };
}

function parseExportNames(segment: string): string[] {
  const body = segment.replace(/^export\s+/, "").trim();
  if (!body || body.startsWith("-")) {
    return [];
  }

  const names: string[] = [];
  let index = 0;

  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index] ?? "")) {
      index += 1;
    }

    const parsed = consumeLeadingAssignment(body, index);
    if (!parsed) {
      break;
    }

    names.push(parsed.name);
    index = parsed.end;
  }

  return names;
}

function parseUnsetNames(segment: string): string[] {
  const body = segment.replace(/^unset\s+/, "").trim();
  if (!body || body.startsWith("-")) {
    return [];
  }

  const names: string[] = [];
  let index = 0;

  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index] ?? "")) {
      index += 1;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(body.slice(index));
    if (!match || !match[1]) {
      break;
    }

    names.push(match[1]);
    index += match[0].length;
  }

  return names;
}

export function collectTrackedEnvKeys(command: string): string[] {
  const keys = new Set<string>();

  for (const segment of splitCommandSegments(command)) {
    if (segment.startsWith("export ")) {
      for (const name of parseExportNames(segment)) {
        keys.add(name);
      }
    }

    if (segment.startsWith("unset ")) {
      for (const name of parseUnsetNames(segment)) {
        keys.add(name);
      }
    }
  }

  return [...keys];
}

export function buildWrappedCommand(options: {
  command: string;
  cwdStatePath: string;
  envStatePath: string;
  trackedEnvKeys: string[];
}): string {
  const lines = [
    options.command,
    "__panda_status=$?",
    'if [ "$__panda_status" -eq 0 ]; then',
    `  pwd -P >| ${shellQuote(options.cwdStatePath)}`,
  ];

  if (options.trackedEnvKeys.length > 0) {
    lines.push(`  : >| ${shellQuote(options.envStatePath)}`);

    for (const key of options.trackedEnvKeys) {
      const quotedKey = shellQuote(key);
      lines.push(`  if printenv ${quotedKey} >/dev/null 2>&1; then`);
      lines.push(
        `    printf '%s\\0present\\0%s\\0' ${quotedKey} "$(printenv ${quotedKey})" >> ${shellQuote(options.envStatePath)}`,
      );
      lines.push("  else");
      lines.push(
        `    printf '%s\\0absent\\0\\0' ${quotedKey} >> ${shellQuote(options.envStatePath)}`,
      );
      lines.push("  fi");
    }
  }

  lines.push("fi", 'exit "$__panda_status"');
  return lines.join("\n");
}

export async function createInvocationPaths(rootDirectory: string): Promise<InvocationPaths> {
  const directory = path.join(rootDirectory, randomUUID());
  await mkdir(directory, { recursive: true });

  return {
    directory,
    cwdStatePath: path.join(directory, "cwd.txt"),
    envStatePath: path.join(directory, "env.bin"),
    stdoutPath: path.join(directory, "stdout.txt"),
    stderrPath: path.join(directory, "stderr.txt"),
  };
}

export async function readPersistedCwd(cwdStatePath: string, fallbackCwd: string): Promise<string> {
  try {
    const value = (await readFile(cwdStatePath, "utf8")).trim();
    return value ? path.resolve(value) : fallbackCwd;
  } catch {
    return fallbackCwd;
  }
}

function parsePersistedEnvDump(buffer: Buffer): PersistedEnvEntry[] {
  if (buffer.length === 0) {
    return [];
  }

  const parts = buffer.toString("utf8").split("\0");
  const entries: PersistedEnvEntry[] = [];

  for (let index = 0; index + 2 < parts.length; index += 3) {
    const key = parts[index];
    const state = parts[index + 1];
    const value = parts[index + 2];
    if (!key || !state) {
      continue;
    }

    entries.push({
      key,
      present: state === "present",
      value: value ?? "",
    });
  }

  return entries;
}

export async function readPersistedEnv(envStatePath: string): Promise<PersistedEnvEntry[]> {
  try {
    const buffer = await readFile(envStatePath);
    return parsePersistedEnvDump(buffer);
  } catch {
    return [];
  }
}

export function applyPersistedEnv(shellSession: ShellSession | null, entries: PersistedEnvEntry[]): string[] {
  if (!shellSession || entries.length === 0) {
    return [];
  }

  const changedKeys: string[] = [];
  for (const entry of entries) {
    if (entry.present) {
      shellSession.env[entry.key] = entry.value;
      changedKeys.push(entry.key);
      continue;
    }

    if (entry.key in shellSession.env) {
      delete shellSession.env[entry.key];
    }
    changedKeys.push(entry.key);
  }

  return changedKeys;
}
