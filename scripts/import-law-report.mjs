#!/usr/bin/env node
import {readdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");
const defaultBaselinePath = path.join(repoRoot, "scripts/import-law-baseline.json");

const bucketOrder = new Map([
  ["lib", 0],
  ["prompts", 1],
  ["kernel", 2],
  ["domain", 3],
  ["integrations", 4],
  ["panda", 5],
  ["ui", 6],
  ["app", 7],
]);

async function listTypescriptFiles(dir) {
  const entries = await readdir(dir, {withFileTypes: true});
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listTypescriptFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  }));
  return files.flat();
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function sourceBucket(relativePath) {
  if (relativePath === "src/index.ts") {
    return "root";
  }
  const match = relativePath.match(/^src\/([^/]+)/);
  return match?.[1];
}

function importSpecifiers(source) {
  const imports = [];
  const importPattern = /^\s*(import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?|export\s+(?:type\s+)?[^'"]*?\s+from\s+)["']([^"']+)["']/gm;
  for (const match of source.matchAll(importPattern)) {
    const statement = match[1] ?? "";
    const specifier = match[2] ?? "";
    imports.push({
      specifier,
      typeOnly: /\bimport\s+type\b|\bexport\s+type\b/.test(statement),
    });
  }
  return imports;
}

function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const normalizedSpecifier = specifier.replace(/\.js$/, ".ts");
  return relativeToRepo(path.resolve(path.dirname(fromFile), normalizedSpecifier));
}

function isDomainCliAppImportAllowed(fromPath, toPath) {
  return /^src\/domain\/.+\/cli\.ts$/.test(fromPath)
    && (toPath.startsWith("src/app/cli") || toPath.startsWith("src/app/runtime/postgres-bootstrap"));
}

function isKernelProviderSharedImportAllowed(toPath) {
  return toPath.startsWith("src/integrations/providers/shared/");
}

function isPandaAppRuntimeContextImportAllowed(toPath) {
  return [
    "src/app/runtime/panda-path-context.ts",
    "src/app/runtime/panda-session-context.ts",
  ].includes(toPath);
}

function isImportAllowed(importRecord) {
  const {fromPath, toPath, fromBucket, toBucket, typeOnly} = importRecord;
  if (!fromBucket || !toBucket || fromBucket === toBucket) {
    return true;
  }

  if (fromBucket === "root") {
    return true;
  }
  if (fromBucket === "app") {
    return true;
  }
  if (fromBucket === "ui" && toBucket === "app") {
    return true;
  }
  if (fromBucket === "panda" && toBucket === "app" && isPandaAppRuntimeContextImportAllowed(toPath)) {
    return true;
  }
  if (fromBucket === "kernel" && isKernelProviderSharedImportAllowed(toPath)) {
    return true;
  }
  if (fromBucket === "domain" && isDomainCliAppImportAllowed(fromPath, toPath)) {
    return true;
  }
  if (fromBucket === "prompts" && toBucket === "domain" && typeOnly) {
    return true;
  }

  const fromOrder = bucketOrder.get(fromBucket);
  const toOrder = bucketOrder.get(toBucket);
  return fromOrder !== undefined && toOrder !== undefined && toOrder <= fromOrder;
}

function describeRule(importRecord) {
  return `${importRecord.fromBucket ?? "unknown"} -> ${importRecord.toBucket ?? "unknown"}`;
}

function violationKey(violation) {
  return [
    violation.fromPath,
    violation.toPath,
    violation.specifier,
    violation.rule ?? describeRule(violation),
  ].join("\0");
}

function formatViolation(violation) {
  return `${violation.fromPath} imports ${violation.toPath} (${violation.rule ?? describeRule(violation)})`;
}

function baselineEntryFromViolation(violation) {
  return {
    fromPath: violation.fromPath,
    toPath: violation.toPath,
    specifier: violation.specifier,
    rule: describeRule(violation),
  };
}

function sortBaselineEntries(entries) {
  return entries.toSorted((left, right) => (
    left.fromPath.localeCompare(right.fromPath)
    || left.toPath.localeCompare(right.toPath)
    || left.specifier.localeCompare(right.specifier)
    || left.rule.localeCompare(right.rule)
  ));
}

async function readBaseline(baselinePath) {
  try {
    const parsed = JSON.parse(await readFile(baselinePath, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.violations)) {
      throw new Error("expected { version: 1, violations: [...] }");
    }
    return sortBaselineEntries(parsed.violations.map((entry) => {
      if (
        typeof entry?.fromPath !== "string"
        || typeof entry.toPath !== "string"
        || typeof entry.specifier !== "string"
        || typeof entry.rule !== "string"
      ) {
        throw new Error("baseline violations must include fromPath, toPath, specifier, and rule strings");
      }
      return {
        fromPath: entry.fromPath,
        toPath: entry.toPath,
        specifier: entry.specifier,
        rule: entry.rule,
      };
    }));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw new Error(`Failed to read import-law baseline ${relativeToRepo(baselinePath)}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const args = {
    ratchet: false,
    updateBaseline: false,
    baselinePath: defaultBaselinePath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ratchet") {
      args.ratchet = true;
      continue;
    }
    if (arg === "--update-baseline") {
      args.updateBaseline = true;
      continue;
    }
    if (arg === "--baseline") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--baseline requires a path");
      }
      args.baselinePath = path.resolve(repoRoot, next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function compareToBaseline(violations, baselineEntries) {
  const baselineKeys = new Set(baselineEntries.map(violationKey));
  const violationKeys = new Set(violations.map(violationKey));
  return {
    newViolations: violations.filter((violation) => !baselineKeys.has(violationKey(violation))),
    fixedBaselineEntries: baselineEntries.filter((entry) => !violationKeys.has(violationKey(entry))),
  };
}

function printList(title, entries, formatter) {
  if (entries.length === 0) {
    return;
  }
  console.log(title);
  for (const entry of entries.slice(0, 100)) {
    console.log(`- ${formatter(entry)}`);
  }
  if (entries.length > 100) {
    console.log(`... ${entries.length - 100} more omitted.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const violations = [];
  for (const file of await listTypescriptFiles(srcRoot)) {
    const source = await readFile(file, "utf8");
    const fromPath = relativeToRepo(file);
    const fromBucket = sourceBucket(fromPath);
    for (const imported of importSpecifiers(source)) {
      const toPath = resolveRelativeImport(file, imported.specifier);
      if (!toPath?.startsWith("src/")) {
        continue;
      }
      const importRecord = {
        fromPath,
        toPath,
        fromBucket,
        toBucket: sourceBucket(toPath),
        specifier: imported.specifier,
        typeOnly: imported.typeOnly,
      };
      if (!isImportAllowed(importRecord)) {
        violations.push({
          ...importRecord,
          rule: describeRule(importRecord),
        });
      }
    }
  }

  violations.sort((left, right) => (
    left.fromPath.localeCompare(right.fromPath)
    || left.toPath.localeCompare(right.toPath)
    || left.specifier.localeCompare(right.specifier)
  ));

  const baselineEntries = await readBaseline(args.baselinePath);
  const {newViolations, fixedBaselineEntries} = compareToBaseline(violations, baselineEntries);

  if (args.updateBaseline) {
    const nextBaseline = {
      version: 1,
      description: "Known dependency-direction violations. Shrink this file as cleanup chunks remove violations.",
      violations: sortBaselineEntries(violations.map(baselineEntryFromViolation)),
    };
    await writeFile(args.baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`);
    console.log(`Updated import-law baseline: ${nextBaseline.violations.length} violation(s).`);
    return;
  }

  if (violations.length === 0) {
    console.log("Import law report: no violations.");
    if (baselineEntries.length > 0) {
      console.log(`Import law baseline: ${baselineEntries.length} known, 0 new, ${fixedBaselineEntries.length} fixed.`);
      printList("Fixed baseline entries:", fixedBaselineEntries, formatViolation);
    }
    return;
  }

  console.log(`Import law report: ${violations.length} violation(s).`);
  console.log(`Import law baseline: ${baselineEntries.length} known, ${newViolations.length} new, ${fixedBaselineEntries.length} fixed.`);

  printList("New violations:", newViolations, formatViolation);
  printList("Fixed baseline entries:", fixedBaselineEntries, formatViolation);

  const baselineKeys = new Set(baselineEntries.map(violationKey));
  for (const violation of violations.slice(0, 100)) {
    const status = baselineKeys.has(violationKey(violation)) ? "known" : "new";
    console.log(`- [${status}] ${formatViolation(violation)}`);
  }
  if (violations.length > 100) {
    console.log(`... ${violations.length - 100} more violation(s) omitted.`);
  }

  if (args.ratchet && newViolations.length > 0) {
    console.error(`Import law ratchet failed: ${newViolations.length} new violation(s).`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
