import os from "node:os";
import path from "node:path";

import {LlmContext} from "../../../kernel/agent/llm-context.js";

export interface EnvironmentContextOptions {
  cwd?: string;
  hostname?: string;
  username?: string;
  shell?: string;
  terminalProgram?: string;
  platform?: NodeJS.Platform;
  release?: string;
  arch?: string;
  cpuModel?: string;
  cpuCount?: number;
  totalMemoryBytes?: number;
  nodeVersion?: string;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function joinCompact(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
}

function formatShellLabel(shell: string | null): string | null {
  if (!shell) {
    return null;
  }

  return path.basename(shell) || shell;
}

function formatOperatingSystem(platform: NodeJS.Platform, release: string, arch: string): string {
  const labels: Partial<Record<NodeJS.Platform, string>> = {
    aix: "AIX",
    android: "Android",
    darwin: "macOS",
    freebsd: "FreeBSD",
    linux: "Linux",
    openbsd: "OpenBSD",
    sunos: "SunOS",
    win32: "Windows",
  };
  const label = labels[platform] ?? platform;

  return `${label} ${release} (${arch})`;
}

function formatMemory(totalMemoryBytes: number): string {
  const totalMemoryGb = Math.round((totalMemoryBytes / (1024 ** 3)) * 10) / 10;
  const displayValue = Number.isInteger(totalMemoryGb)
    ? totalMemoryGb.toFixed(0)
    : totalMemoryGb.toFixed(1);

  return `${displayValue} GB RAM`;
}

function resolveUsername(username?: string): string {
  return firstNonEmpty(username, process.env.USER, process.env.USERNAME) ?? safeUserInfoUsername() ?? "unknown";
}

function safeUserInfoUsername(): string | null {
  try {
    return firstNonEmpty(os.userInfo().username);
  } catch {
    return null;
  }
}

function resolveCpuCount(cpuCount?: number): number {
  if (typeof cpuCount === "number" && Number.isFinite(cpuCount) && cpuCount > 0) {
    return Math.trunc(cpuCount);
  }

  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
}

export class EnvironmentContext extends LlmContext {
  override name = "Environment Overview";

  private readonly options: EnvironmentContextOptions;

  constructor(options: EnvironmentContextOptions = {}) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const cwd = path.resolve(this.options.cwd ?? process.cwd());
    const hostname = firstNonEmpty(this.options.hostname, os.hostname()) ?? "unknown-host";
    const username = resolveUsername(this.options.username);
    const platform = this.options.platform ?? os.platform();
    const release = firstNonEmpty(this.options.release, os.release()) ?? "unknown";
    const arch = firstNonEmpty(this.options.arch, os.arch()) ?? "unknown";
    const cpuModel = firstNonEmpty(this.options.cpuModel, os.cpus()[0]?.model) ?? "unknown CPU";
    const cpuCount = resolveCpuCount(this.options.cpuCount);
    const totalMemoryBytes = this.options.totalMemoryBytes ?? os.totalmem();
    const shell = formatShellLabel(firstNonEmpty(this.options.shell, process.env.SHELL));
    const terminalProgram = firstNonEmpty(this.options.terminalProgram, process.env.TERM_PROGRAM);
    const nodeVersion = firstNonEmpty(this.options.nodeVersion, process.version) ?? "unknown";

    return [
      `User: ${username} @ ${hostname}`,
      `OS: ${formatOperatingSystem(platform, release, arch)}`,
      `Hardware: ${joinCompact([cpuModel, `${cpuCount} cores`, formatMemory(totalMemoryBytes)])}`,
      `Runtime: ${joinCompact([`Node ${nodeVersion}`, shell, terminalProgram])}`,
      `Workspace: ${cwd}`,
    ].join("\n");
  }
}
