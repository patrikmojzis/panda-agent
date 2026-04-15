import {randomUUID} from "node:crypto";
import {access, copyFile, mkdir, readdir, readFile} from "node:fs/promises";
import path from "node:path";

import {resolvePandaAgentDir} from "../../app/runtime/data-dir.js";
import type {CredentialService} from "../credentials/index.js";
import type {SessionStore} from "../sessions/store.js";
import type {ThreadRuntimeStore} from "../threads/runtime/store.js";
import type {AgentStore} from "./store.js";
import {DEFAULT_AGENT_DOCUMENT_TEMPLATES} from "./templates.js";
import type {AgentPromptSlug} from "./types.js";
import {normalizeAgentKey, normalizeSkillKey} from "./types.js";

export interface LegacyAgentPromptPlan {
  slug: AgentPromptSlug;
  content: string;
  sourcePath?: string;
}

export interface LegacyAgentDiaryPlan {
  entryDate: string;
  content: string;
  sourcePaths: readonly string[];
}

export interface LegacyAgentSkillPlan {
  skillKey: string;
  description: string;
  content: string;
  sourcePath: string;
}

export interface LegacyAgentCredentialPlan {
  envKey: string;
  value: string;
  sourcePath: string;
}

export interface LegacyAgentMemoryPlan {
  content: string;
  sourcePaths: readonly string[];
}

export interface LegacyAgentImportPlan {
  sourceDir: string;
  agentKey: string;
  displayName: string;
  prompts: readonly LegacyAgentPromptPlan[];
  memory: LegacyAgentMemoryPlan | null;
  diary: readonly LegacyAgentDiaryPlan[];
  skills: readonly LegacyAgentSkillPlan[];
  credentials: readonly LegacyAgentCredentialPlan[];
  warnings: readonly string[];
  homeDir: string;
  legacyCopyDir: string;
}

export interface ImportLegacyAgentOptions {
  agentStore: AgentStore;
  sessionStore?: SessionStore;
  threadStore?: ThreadRuntimeStore;
  credentialService?: CredentialService;
  env?: NodeJS.ProcessEnv;
  copyLegacyWorkspace?: boolean;
}

export interface ImportedLegacyAgentResult {
  agentKey: string;
  displayName: string;
  sourceDir: string;
  homeDir: string;
  legacyCopyDir: string;
  createdAgent: boolean;
  createdMainSession: boolean;
  promptCount: number;
  importedMemory: boolean;
  diaryEntryCount: number;
  skillCount: number;
  credentialCount: number;
  skippedCredentialCount: number;
  warnings: readonly string[];
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function titleCaseWords(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

function renderGeneratedAgentPrompt(displayName: string): string {
  return `
# Agent

You are ${displayName}.

This agent was imported from a legacy OpenClaw workspace.
IDENTITY.md was intentionally left out of Panda's prompt store.
`.trim();
}

function cleanImportedBlock(content: string): string {
  return content.trim() || "(empty)";
}

function mergeImportedMarkdownBlocks(blocks: readonly {label: string; content: string}[]): string {
  if (blocks.length === 0) {
    return "";
  }

  if (blocks.length === 1) {
    return cleanImportedBlock(blocks[0]?.content ?? "");
  }

  return blocks
    .map((block) => `<!-- Imported from ${block.label} -->\n${cleanImportedBlock(block.content)}`)
    .join("\n\n---\n\n");
}

function extractDiaryDate(fileName: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[-_].+)?\.md$/i.exec(fileName);
  return match?.[1] ?? null;
}

function sortDiaryFiles(entryDate: string, left: string, right: string): number {
  const canonical = `${entryDate}.md`;
  if (left === canonical && right !== canonical) {
    return -1;
  }
  if (right === canonical && left !== canonical) {
    return 1;
  }

  return left.localeCompare(right);
}

function parseFrontmatterValue(content: string, key: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    return null;
  }

  const frontmatter = match[1];
  if (frontmatter === undefined) {
    return null;
  }

  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }

    const currentKey = line.slice(0, separator).trim();
    if (currentKey !== key) {
      continue;
    }

    const rawValue = line.slice(separator + 1).trim();
    const unquoted = rawValue.replace(/^['"]|['"]$/g, "").trim();
    return unquoted || null;
  }

  return null;
}

function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

function deriveSkillDescription(skillKey: string, content: string): string {
  const frontmatterDescription = parseFrontmatterValue(content, "description");
  if (frontmatterDescription) {
    return frontmatterDescription;
  }

  const body = stripFrontmatter(content);
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (paragraph.startsWith("#")) {
      continue;
    }

    return paragraph.replace(/\s+/g, " ").slice(0, 400);
  }

  return `Imported legacy skill ${skillKey}.`;
}

function isEnvLikeFileName(fileName: string): boolean {
  return fileName === ".env"
    || fileName.startsWith(".env.")
    || fileName.endsWith(".env")
    || fileName.endsWith(".pass");
}

function isSecretEnvFileName(fileName: string): boolean {
  return fileName === ".env"
    || fileName.startsWith(".env.")
    || fileName.endsWith(".env");
}

function stripInlineEnvComment(value: string): string {
  if (!value || value.startsWith("'") || value.startsWith("\"")) {
    return value;
  }

  const commentIndex = value.indexOf(" #");
  if (commentIndex < 0) {
    return value;
  }

  return value.slice(0, commentIndex).trimEnd();
}

function parseEnvValue(rawValue: string): string {
  const value = stripInlineEnvComment(rawValue.trim());
  const first = value[0];
  const last = value.at(-1);
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

function parseEnvEntries(content: string): readonly {envKey: string; value: string}[] {
  const entries: {envKey: string; value: string}[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const exported = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = exported.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const envKey = exported.slice(0, separator).trim();
    if (!envKey) {
      continue;
    }

    entries.push({
      envKey,
      value: parseEnvValue(exported.slice(separator + 1)),
    });
  }

  return entries;
}

async function readUtf8IfExists(targetPath: string): Promise<string | null> {
  if (!await pathExists(targetPath)) {
    return null;
  }

  return readFile(targetPath, "utf8");
}

async function buildPromptPlans(sourceDir: string, displayName: string, warnings: string[]): Promise<readonly LegacyAgentPromptPlan[]> {
  const promptFiles: ReadonlyArray<{slug: AgentPromptSlug; fileName: string}> = [
    {slug: "playbook", fileName: "AGENTS.md"},
    {slug: "heartbeat", fileName: "HEARTBEAT.md"},
    {slug: "soul", fileName: "SOUL.md"},
  ];

  const prompts: LegacyAgentPromptPlan[] = [{
    slug: "agent",
    content: renderGeneratedAgentPrompt(displayName),
  }];

  for (const promptFile of promptFiles) {
    const sourcePath = path.join(sourceDir, promptFile.fileName);
    const content = await readUtf8IfExists(sourcePath);
    if (content === null) {
      warnings.push(`Missing ${promptFile.fileName}; kept Panda default for ${promptFile.slug}.`);
      prompts.push({
        slug: promptFile.slug,
        content: DEFAULT_AGENT_DOCUMENT_TEMPLATES[promptFile.slug],
      });
      continue;
    }

    prompts.push({
      slug: promptFile.slug,
      content,
      sourcePath,
    });
  }

  return prompts;
}

async function buildMemoryPlan(sourceDir: string): Promise<LegacyAgentMemoryPlan | null> {
  const sources: {label: string; sourcePath: string; content: string}[] = [];

  for (const fileName of ["USER.md", "MEMORY.md"]) {
    const sourcePath = path.join(sourceDir, fileName);
    const content = await readUtf8IfExists(sourcePath);
    if (content === null) {
      continue;
    }

    sources.push({
      label: fileName,
      sourcePath,
      content,
    });
  }

  if (sources.length === 0) {
    return null;
  }

  return {
    content: mergeImportedMarkdownBlocks(sources),
    sourcePaths: sources.map((source) => source.sourcePath),
  };
}

async function buildDiaryPlan(sourceDir: string): Promise<readonly LegacyAgentDiaryPlan[]> {
  const memoryDir = path.join(sourceDir, "memory");
  if (!await pathExists(memoryDir)) {
    return [];
  }

  const files = await readdir(memoryDir, {withFileTypes: true});
  const grouped = new Map<string, string[]>();

  for (const entry of files) {
    if (!entry.isFile()) {
      continue;
    }

    const entryDate = extractDiaryDate(entry.name);
    if (!entryDate) {
      continue;
    }

    const current = grouped.get(entryDate);
    if (current) {
      current.push(entry.name);
      continue;
    }

    grouped.set(entryDate, [entry.name]);
  }

  const diaryPlans: LegacyAgentDiaryPlan[] = [];
  const sortedDates = [...grouped.keys()].sort();

  for (const entryDate of sortedDates) {
    const fileNames = [...(grouped.get(entryDate) ?? [])].sort((left, right) => sortDiaryFiles(entryDate, left, right));
    const sections = await Promise.all(fileNames.map(async (fileName) => {
      const sourcePath = path.join(memoryDir, fileName);
      return {
        label: fileName,
        sourcePath,
        content: await readFile(sourcePath, "utf8"),
      };
    }));

    // Panda stores one diary row per day. Legacy agents sometimes split the same
    // day across multiple files, so we collapse them into one stable markdown blob.
    diaryPlans.push({
      entryDate,
      content: mergeImportedMarkdownBlocks(sections),
      sourcePaths: sections.map((section) => section.sourcePath),
    });
  }

  return diaryPlans;
}

async function buildSkillPlans(sourceDir: string, warnings: string[]): Promise<readonly LegacyAgentSkillPlan[]> {
  const skillsDir = path.join(sourceDir, "skills");
  if (!await pathExists(skillsDir)) {
    return [];
  }

  const entries = await readdir(skillsDir, {withFileTypes: true});
  const skillPlans: LegacyAgentSkillPlan[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillKey = normalizeSkillKey(entry.name);
    const sourcePath = path.join(skillsDir, entry.name, "SKILL.md");
    const content = await readUtf8IfExists(sourcePath);
    if (content === null) {
      warnings.push(`Skipped skill ${entry.name}; missing SKILL.md.`);
      continue;
    }

    skillPlans.push({
      skillKey,
      description: deriveSkillDescription(skillKey, content),
      content,
      sourcePath,
    });
  }

  return skillPlans.sort((left, right) => left.skillKey.localeCompare(right.skillKey));
}

async function walkDirectory(rootDir: string): Promise<readonly string[]> {
  const results: string[] = [];

  async function visit(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, {withFileTypes: true});
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        results.push(absolutePath);
      }
    }
  }

  await visit(rootDir);
  return results.sort((left, right) => left.localeCompare(right));
}

async function buildCredentialPlans(sourceDir: string, warnings: string[]): Promise<readonly LegacyAgentCredentialPlan[]> {
  const skillsDir = path.join(sourceDir, "skills");
  if (!await pathExists(skillsDir)) {
    return [];
  }

  const files = await walkDirectory(skillsDir);
  const credentialFiles = files.filter((filePath) => isSecretEnvFileName(path.basename(filePath)));
  const credentialsByKey = new Map<string, LegacyAgentCredentialPlan>();

  for (const filePath of credentialFiles) {
    const content = await readFile(filePath, "utf8");
    for (const entry of parseEnvEntries(content)) {
      if (!trimNonEmpty(entry.value)) {
        warnings.push(`Skipped blank credential ${entry.envKey} from ${filePath}.`);
        continue;
      }

      const previous = credentialsByKey.get(entry.envKey);
      if (previous && previous.value !== entry.value) {
        warnings.push(`Credential ${entry.envKey} appeared multiple times; kept ${filePath}.`);
      }

      credentialsByKey.set(entry.envKey, {
        envKey: entry.envKey,
        value: entry.value,
        sourcePath: filePath,
      });
    }
  }

  return [...credentialsByKey.values()].sort((left, right) => left.envKey.localeCompare(right.envKey));
}

export async function discoverLegacyAgentSourceDirs(inputPath: string): Promise<readonly string[]> {
  const resolvedInput = path.resolve(inputPath);
  if (await pathExists(path.join(resolvedInput, "AGENTS.md"))) {
    return [resolvedInput];
  }

  const entries = await readdir(resolvedInput, {withFileTypes: true});
  const discovered = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(resolvedInput, entry.name));

  const matches: string[] = [];
  for (const entryPath of discovered) {
    if (await pathExists(path.join(entryPath, "AGENTS.md"))) {
      matches.push(entryPath);
    }
  }

  return matches.sort((left, right) => left.localeCompare(right));
}

export async function planLegacyAgentImport(
  sourceDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyAgentImportPlan> {
  const resolvedSourceDir = path.resolve(sourceDir);
  const agentKey = normalizeAgentKey(path.basename(resolvedSourceDir));
  const displayName = titleCaseWords(agentKey);
  const warnings: string[] = [];

  const prompts = await buildPromptPlans(resolvedSourceDir, displayName, warnings);
  const memory = await buildMemoryPlan(resolvedSourceDir);
  const diary = await buildDiaryPlan(resolvedSourceDir);
  const skills = await buildSkillPlans(resolvedSourceDir, warnings);
  const credentials = await buildCredentialPlans(resolvedSourceDir, warnings);
  const homeDir = resolvePandaAgentDir(agentKey, env);

  const nonEnvSecretFiles = (await pathExists(path.join(resolvedSourceDir, "skills")))
    ? (await walkDirectory(path.join(resolvedSourceDir, "skills")))
      .filter((filePath) => path.basename(filePath).endsWith(".pass"))
      .map((filePath) => path.relative(resolvedSourceDir, filePath))
    : [];
  for (const relativePath of nonEnvSecretFiles) {
    warnings.push(`Left ${relativePath} out of credentials import; copied workspace will skip it.`);
  }

  return {
    sourceDir: resolvedSourceDir,
    agentKey,
    displayName,
    prompts,
    memory,
    diary,
    skills,
    credentials,
    warnings,
    homeDir,
    legacyCopyDir: path.join(homeDir, "legacy-import"),
  };
}

function shouldSkipLegacyCopy(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const parts = normalized.split("/");
  const baseName = parts.at(-1) ?? normalized;

  if (parts.some((part) => [".git", ".openclaw", ".pi", "node_modules", "venv"].includes(part))) {
    return true;
  }

  if (baseName === ".DS_Store") {
    return true;
  }

  if (isEnvLikeFileName(baseName)) {
    return true;
  }

  if (/\.(?:db|sqlite)-(?:shm|wal)$/i.test(baseName)) {
    return true;
  }

  if (baseName.endsWith(".lock")) {
    return true;
  }

  return false;
}

async function copyLegacyWorkspace(sourceDir: string, destinationDir: string): Promise<void> {
  async function visit(currentSourceDir: string, currentDestinationDir: string): Promise<void> {
    await mkdir(currentDestinationDir, {recursive: true});
    const entries = await readdir(currentSourceDir, {withFileTypes: true});

    for (const entry of entries) {
      const sourcePath = path.join(currentSourceDir, entry.name);
      const relativePath = path.relative(sourceDir, sourcePath);
      if (shouldSkipLegacyCopy(relativePath)) {
        continue;
      }

      const destinationPath = path.join(currentDestinationDir, entry.name);
      if (entry.isDirectory()) {
        await visit(sourcePath, destinationPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      await mkdir(path.dirname(destinationPath), {recursive: true});
      await copyFile(sourcePath, destinationPath);
    }
  }

  await visit(sourceDir, destinationDir);
}

async function ensureAgentRecord(
  plan: LegacyAgentImportPlan,
  store: AgentStore,
): Promise<boolean> {
  try {
    await store.getAgent(plan.agentKey);
    return false;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(`Unknown agent ${plan.agentKey}.`)) {
      throw error;
    }

    await store.bootstrapAgent({
      agentKey: plan.agentKey,
      displayName: plan.displayName,
      prompts: Object.fromEntries(plan.prompts.map((prompt) => [prompt.slug, prompt.content])) as Record<AgentPromptSlug, string>,
      metadata: {
        legacyImport: {
          sourceDir: plan.sourceDir,
        },
      },
    });
    return true;
  }
}

async function ensureMainSession(
  agentKey: string,
  homeDir: string,
  sessionStore?: SessionStore,
  threadStore?: ThreadRuntimeStore,
): Promise<boolean> {
  if (!sessionStore || !threadStore) {
    return false;
  }

  const existing = await sessionStore.getMainSession(agentKey);
  if (existing) {
    return false;
  }

  const sessionId = randomUUID();
  const threadId = randomUUID();
  await sessionStore.createSession({
    id: sessionId,
    agentKey,
    kind: "main",
    currentThreadId: threadId,
  });
  await threadStore.createThread({
    id: threadId,
    sessionId,
    context: {
      agentKey,
      sessionId,
      cwd: homeDir,
    },
  });

  return true;
}

export async function importLegacyAgent(
  plan: LegacyAgentImportPlan,
  options: ImportLegacyAgentOptions,
): Promise<ImportedLegacyAgentResult> {
  const env = options.env ?? process.env;
  const homeDir = resolvePandaAgentDir(plan.agentKey, env);
  await mkdir(homeDir, {recursive: true});

  const createdAgent = await ensureAgentRecord(plan, options.agentStore);
  if (!createdAgent) {
    for (const prompt of plan.prompts) {
      await options.agentStore.setAgentPrompt(plan.agentKey, prompt.slug, prompt.content);
    }
  }

  if (plan.memory) {
    await options.agentStore.setAgentDocument(plan.agentKey, "memory", plan.memory.content);
  }

  for (const entry of plan.diary) {
    await options.agentStore.setDiaryEntry(plan.agentKey, entry.entryDate, entry.content);
  }

  for (const skill of plan.skills) {
    await options.agentStore.setAgentSkill(
      plan.agentKey,
      skill.skillKey,
      skill.description,
      skill.content,
    );
  }

  let credentialCount = 0;
  let skippedCredentialCount = 0;
  if (options.credentialService) {
    for (const credential of plan.credentials) {
      await options.credentialService.setCredential({
        envKey: credential.envKey,
        value: credential.value,
        scope: "agent",
        agentKey: plan.agentKey,
      });
      credentialCount += 1;
    }
  } else {
    skippedCredentialCount = plan.credentials.length;
  }

  if (options.copyLegacyWorkspace !== false) {
    await copyLegacyWorkspace(plan.sourceDir, plan.legacyCopyDir);
  }

  const createdMainSession = await ensureMainSession(
    plan.agentKey,
    homeDir,
    options.sessionStore,
    options.threadStore,
  );

  return {
    agentKey: plan.agentKey,
    displayName: plan.displayName,
    sourceDir: plan.sourceDir,
    homeDir,
    legacyCopyDir: plan.legacyCopyDir,
    createdAgent,
    createdMainSession,
    promptCount: plan.prompts.length,
    importedMemory: plan.memory !== null,
    diaryEntryCount: plan.diary.length,
    skillCount: plan.skills.length,
    credentialCount,
    skippedCredentialCount,
    warnings: [
      ...plan.warnings,
      ...(skippedCredentialCount > 0
        ? [`Skipped ${skippedCredentialCount} credentials because PANDA_CREDENTIALS_MASTER_KEY is not set.`]
        : []),
    ],
  };
}
