import os from "node:os";
import path from "node:path";

import {firstNonEmptyString} from "../../lib/strings.js";
import {LlmContext} from "../../kernel/agent/llm-context.js";
import {renderEnvironmentContext} from "../../prompts/contexts/environment.js";

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
  return firstNonEmptyString(username, process.env.USER, process.env.USERNAME) ?? safeUserInfoUsername() ?? "unknown";
}

function safeUserInfoUsername(): string | null {
  try {
    return firstNonEmptyString(os.userInfo().username) ?? null;
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
    const hostname = firstNonEmptyString(this.options.hostname, os.hostname()) ?? "unknown-host";
    const username = resolveUsername(this.options.username);
    const platform = this.options.platform ?? os.platform();
    const release = firstNonEmptyString(this.options.release, os.release()) ?? "unknown";
    const arch = firstNonEmptyString(this.options.arch, os.arch()) ?? "unknown";
    const cpuModel = firstNonEmptyString(this.options.cpuModel, os.cpus()[0]?.model) ?? "unknown CPU";
    const cpuCount = resolveCpuCount(this.options.cpuCount);
    const totalMemoryBytes = this.options.totalMemoryBytes ?? os.totalmem();
    const shell = formatShellLabel(firstNonEmptyString(this.options.shell, process.env.SHELL) ?? null);
    const terminalProgram = firstNonEmptyString(this.options.terminalProgram, process.env.TERM_PROGRAM);
    const nodeVersion = firstNonEmptyString(this.options.nodeVersion, process.version) ?? "unknown";

    return renderEnvironmentContext({
      username,
      hostname,
      osLabel: formatOperatingSystem(platform, release, arch),
      hardware: joinCompact([cpuModel, `${cpuCount} cores`, formatMemory(totalMemoryBytes)]),
      runtime: joinCompact([`Node ${nodeVersion}`, shell, terminalProgram]),
      workspace: cwd,
    });
  }
}
