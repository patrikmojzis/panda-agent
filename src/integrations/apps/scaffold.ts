import {escapeAgentAppHtml} from "./html.js";

interface BlankAgentAppScaffoldInput {
  appName: string;
  description?: string;
  identityScoped: boolean;
  schemaSql?: string;
}

interface BlankAgentAppScaffoldFiles {
  actionJson: string;
  appCss: string;
  appJs: string;
  indexHtml: string;
  manifestJson: string;
  readme: string;
  schemaApplied: boolean;
  schemaSql: string;
  viewJson: string;
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function buildDefaultSchemaSql(appName: string): string {
  return [
    `-- Bootstrap schema for ${appName}.`,
    "-- Panda does not run this file automatically yet.",
    "-- Write SQL here, then apply it to data/app.sqlite when you are ready.",
    "",
  ].join("\n");
}

function buildBlankIndexHtml(input: {
  appName: string;
  description?: string;
}): string {
  const title = escapeAgentAppHtml(input.appName);
  const description = input.description?.trim()
    ? `<p class="blank-app__lede">${escapeAgentAppHtml(input.description)}</p>`
    : "";

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `    <title>${title}</title>`,
    "  <link rel=\"stylesheet\" href=\"./app.css\">",
    "</head>",
    "<body>",
    "  <main class=\"blank-app\">",
    `    <h1>${title}</h1>`,
    description ? `    ${description}` : "",
    "    <p class=\"blank-app__status\" id=\"app-status\">Loading app context...</p>",
    "    <p>Edit <code>schema.sql</code>, <code>views.json</code>, <code>actions.json</code>, and <code>public/</code>.</p>",
    "  </main>",
    "  <script src=\"/panda-app-sdk.js\"></script>",
    "  <script type=\"module\" src=\"./app.js\"></script>",
    "</body>",
    "</html>",
    "",
  ].filter(Boolean).join("\n");
}

function buildBlankAppJs(): string {
  return [
    "const status = document.querySelector('#app-status');",
    "",
    "async function main() {",
    "  const bootstrap = await window.panda.bootstrap();",
    "  const {app, context} = bootstrap;",
    "  const bits = [",
    "    `${app.viewNames.length} view${app.viewNames.length === 1 ? '' : 's'}`,",
    "    `${app.actionNames.length} action${app.actionNames.length === 1 ? '' : 's'}`",
    "  ];",
    "  if (context.identityHandle) {",
    "    bits.push(`identity ${context.identityHandle}`);",
    "  }",
    "  status.textContent = `Loaded ${app.name}. ${bits.join(' | ')}`;",
    "}",
    "",
    "main().catch((error) => {",
    "  status.textContent = error instanceof Error ? error.message : String(error);",
    "});",
    "",
  ].join("\n");
}

function buildBlankAppCss(): string {
  return [
    ":root {",
    "  font-family: system-ui, sans-serif;",
    "  color: #111827;",
    "  background: #f8fafc;",
    "}",
    "",
    "* {",
    "  box-sizing: border-box;",
    "}",
    "",
    "body {",
    "  margin: 0;",
    "}",
    "",
    ".blank-app {",
    "  max-width: 680px;",
    "  margin: 0 auto;",
    "  padding: 48px 20px;",
    "}",
    "",
    ".blank-app h1 {",
    "  margin: 0 0 16px;",
    "  font-size: 2rem;",
    "}",
    "",
    ".blank-app p {",
    "  line-height: 1.6;",
    "}",
    "",
    ".blank-app code {",
    "  font-family: 'SFMono-Regular', 'Cascadia Code', monospace;",
    "}",
    "",
  ].join("\n");
}

function buildBlankReadme(input: {
  appName: string;
  description?: string;
  identityScoped: boolean;
  schemaApplied: boolean;
}): string {
  const descriptionLine = input.description?.trim()
    ? `${input.description.trim()}\n\n`
    : "";
  const identityLine = input.identityScoped
    ? "- This app is identity-scoped. Local/dev browser links can use `?identityHandle=<handle>`; public links should come from `panda micro-app link create`, which uses the current input identity.\n"
    : "- This app is not identity-scoped.\n";
  const schemaLine = input.schemaApplied
    ? "- `schema.sql` was applied to `data/app.sqlite` during scaffold creation.\n"
    : "- `schema.sql` is just a placeholder right now. Panda does not apply it automatically yet.\n";

  return [
    `# ${input.appName}`,
    "",
    `${descriptionLine}This is a blank Panda app scaffold.`,
    "Read `/app/docs/agents/apps.md` in Docker or `docs/agents/apps.md` in a source checkout for the global contract and tool guidance.",
    "",
    "## Files",
    "",
    "- `schema.sql`: bootstrap SQL. Panda does not auto-run later edits.",
    "- `views.json`: readonly SQLite queries.",
    "- `actions.json`: fixed SQLite actions.",
    "- `public/`: UI served by the app host.",
    "- `data/app.sqlite`: the app database file",
    "",
    "## Current State",
    "",
    "- This README is scaffold-time guidance. After you edit the app, trust the actual files over this checklist.",
    identityLine.trimEnd(),
    schemaLine.trimEnd(),
    "- `views.json` is empty.",
    "- `actions.json` is empty.",
    "- `public/` still contains the default placeholder UI.",
    "",
    "## Safety Rules",
    "",
    "- Views run against SQLite in readonly mode.",
    "- App SQL must not use `ATTACH`, `DETACH`, `VACUUM INTO`, or `load_extension()`.",
    "- `data/app.sqlite` must not be a symlink.",
    "- Served files in `public/` must be normal app-local files, not symlinks or hardlinks.",
    "",
    "## Next Steps",
    "",
    "1. Define and apply the schema.",
    "2. Add views and actions.",
    "3. Replace the placeholder UI.",
    "4. Run `panda micro-app check <app-slug>`.",
    "5. Use `panda micro-app link create <app-slug>` for human-facing public access.",
    "",
  ].join("\n");
}

/** Builds the default files for a new filesystem-backed Panda micro-app. */
export function buildBlankAgentAppScaffold(input: BlankAgentAppScaffoldInput): BlankAgentAppScaffoldFiles {
  const schemaSql = input.schemaSql?.trim();
  const schemaApplied = Boolean(schemaSql);

  return {
    actionJson: stringifyJson({}),
    appCss: buildBlankAppCss(),
    appJs: buildBlankAppJs(),
    indexHtml: buildBlankIndexHtml({
      appName: input.appName,
      description: input.description,
    }),
    manifestJson: stringifyJson({
      name: input.appName,
      ...(input.description ? {description: input.description} : {}),
      ...(input.identityScoped ? {identityScoped: true} : {}),
    }),
    readme: buildBlankReadme({
      appName: input.appName,
      description: input.description,
      identityScoped: input.identityScoped,
      schemaApplied,
    }),
    schemaApplied,
    schemaSql: ensureTrailingNewline(schemaSql ?? buildDefaultSchemaSql(input.appName)),
    viewJson: stringifyJson({}),
  };
}
