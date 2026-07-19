import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {buildDefaultAgentLlmContexts, gatherContexts,} from "../src/index.js";
import type {CommandDescriptor} from "../src/domain/commands/index.js";
import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

const customCommandDescriptor: CommandDescriptor = {
  name: "custom.echo",
  summary: "Echo a custom message.",
  description: "Echo a custom message.",
  usage: "panda custom echo <message>",
  inputModes: ["flags", "json"],
  outputModes: ["json"],
  arguments: [],
  examples: [],
};

describe("buildDefaultAgentLlmContexts", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createFixture() {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const identityStore = new PostgresIdentityStore({ pool });
    const agentStore = new PostgresAgentStore({ pool });
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
    });
    await agentStore.setAgentSkill("panda", "calendar", "Use this for calendar work.", "# Calendar\nLong skill body.");

    return {
      agentStore,
      context: {
        cwd: "/workspace/panda",
      },
    };
  }

  it("keeps the full agent profile in default Panda contexts", async () => {
    const fixture = await createFixture();

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: fixture.context,
      agentStore: fixture.agentStore,
      agentKey: "panda",
    }));

    expect(dump).toContain("**Environment Overview:**");
    expect(dump).toContain("**Panda CLI Catalog:**");
    expect(dump).toContain("panda commands --output json");
    expect(dump).toContain("returns the full machine-readable catalog; invoke commands with the spaced CLI paths shown below");
    expect(dump).toContain("`panda watch list [--status enabled|disabled|all] [--limit <n>]`");
    expect(dump).toContain("`panda watch show <watch-id>`");
    expect(dump).toContain("`panda watch create --title <text|@file|@-> --every <minutes> (--url <url> --value-path <path> --percent-change <n> [--label <text|@file|@->]|--source-json <json|@file|@-> --detector-json <json|@file|@-> [--source-kind <kind>] [--detector-kind <kind>]) [--disabled]`");
    expect(dump).toContain("`panda watch update <watch-id> [--title <text|@file|@->] [--every <minutes>] [--url <url> --value-path <path> [--label <text|@file|@->]] [--percent-change <n>] [--source-json <json|@file|@->] [--detector-json <json|@file|@->] [--source-kind <kind>] [--detector-kind <kind>] [--enable|--disable]`");
    expect(dump).toContain("`panda schedule create <title> (--at <iso>|--cron <expr> --timezone <tz>) --instruction <text|@file|@-> [--disabled]`");
    expect(dump).toContain("`panda schedule list [--status active|disabled|completed|cancelled|all] [--limit <n>]`");
    expect(dump).toContain("`panda schedule show <task-id>`");
    expect(dump).toContain("`panda micro-app create <slug> --name <text|@file|@-> [--description <text|@file|@->] [--identity-scoped] [--schema <sql|@file|@->]`");
    expect(dump).toContain("`panda micro-app link create <app-slug> [--expires <minutes|Nm|Nh>]`");
    expect(dump).toContain("`panda micro-app view <app-slug> <view-name> [--param key=value] [--params <json|@file|@->] [--page-size <n>] [--offset <n>]`");
    expect(dump).toContain("`panda environment list [--state <state>]`");
    expect(dump).toContain("`panda environment show <environment-id>`");
    expect(dump).toContain("`panda environment stop <environment-id>`");
    expect(dump).toContain("`panda skill list [--tag <tag>...] [--output keys|json|table]`");
    expect(dump).toContain("`panda skill show <skill-key>`");
    expect(dump).toContain("`panda skill load <skill-key>`");
    expect(dump).toContain("`panda skill set <skill-key> --description <text|@file|@-> --content <text|@file|@-> [--tag <tag>...]`");
    expect(dump).toContain("`panda skill patch <skill-key> --description <text|@file|@->`");
    expect(dump).toContain("`panda postgres readonly query (--sql <text|@file|@-> [--max-rows <n>]|--schema-help)`");
    expect(dump).toContain("`panda wiki read <path> [--locale <locale>] [--format json|markdown]`");
    expect(dump).toContain("`panda wiki search <query> [--path <path>] [--locale <locale>] [--limit <n>]`");
    expect(dump).toContain("`panda wiki list [path] [--limit <n>] [--include-archived] [--locale <locale>]`");
    expect(dump).toContain("`panda wiki diff <left-path> <right-path> [--locale <locale>] [--context <n>]`");
    expect(dump).toContain("`panda wiki write page <path> --content <text|@file|@-> [--title <text|@file|@->] [--description <text|@file|@->] [--tag <tag>...] [--published|--draft] [--private|--public] [--create|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]`");
    expect(dump).toContain("`panda wiki write section <path> <section> --content <text|@file|@-> [--title <text|@file|@->] [--create|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]`");
    expect(dump).toContain("`panda wiki attach image <path> <section> --slot <slot> --source <image-path> --alt <text|@file|@-> [--caption <text|@file|@->] [--title <text|@file|@->] [--create|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]`");
    expect(dump).toContain("`panda wiki move <path> <destination-path> [--rewrite-links] [--locale <locale>] [--base-updated-at <timestamp>]`");
    expect(dump).toContain("`panda wiki archive <path> [--locale <locale>] [--base-updated-at <timestamp>]`");
    expect(dump).toContain("`panda wiki restore <archived-path> <destination-path> [--locale <locale>] [--base-updated-at <timestamp>]`");
    expect(dump).toContain("`panda wiki delete asset <asset-path> --yes`");
    expect(dump).toContain("`panda session prompt current read <brief|memory|heartbeat> [--raw]`");
    expect(dump).toContain("`panda session prompt current set <brief|memory|heartbeat> --content <text|@file|@->`");
    expect(dump).toContain("`panda session prompt current transform <brief|memory|heartbeat> (--append <text|@file|@->|--prepend <text|@file|@->|--replace <pattern> --with <text|@file|@->|--expression <expr|@file|@->)`");
    expect(dump).toContain("`panda todo add <text|@file|@-> [--status pending|in_progress|blocked]`");
    expect(dump).toContain("`panda todo list [--status all|open|pending|in_progress|blocked|done]`");
    expect(dump).toContain("`panda todo show <index>`");
    expect(dump).toContain("`panda todo done <index>`");
    expect(dump).toContain("`panda todo block <index>`");
    expect(dump).toContain("`panda todo clear`");
    expect(dump).toContain("`panda subagent spawn (<task|@file|@->|--prompt <text|@file|@->) [--profile <slug>|--tool-group <group>...] [--context <text|@file|@->] [(--environment <environment-id> [--isolated]|--agent-workspace)] [--credential <env-key>...]`");
    expect(dump).toContain("`panda subagent profile list [--include-disabled]`");
    expect(dump).toContain("`panda subagent profile show <slug> [--include-disabled]`");
    expect(dump).toContain("`panda subagent profile upsert <slug> --description <text|@file|@-> --prompt <text|@file|@-> --tool-group <group>... [--model <model>] [--thinking low|medium|high|xhigh] [--enabled|--disabled]`");
    expect(dump).toContain("`panda subagent profile enable <slug>`");
    expect(dump).toContain("`panda subagent profile disable <slug>`");
    expect(dump).toContain("`panda env set <key> (--stdin|--from-file <path>)`");
    expect(dump).toContain("`panda vent (--message <text|@file|@->|--stdin)`");
    expect(dump).toContain("`panda a2a send (--to-session <session-id>|--to-agent <agent-key>) (--text <text|@file|@->|--stdin|--file <path>)...`");
    expect(dump).toContain("`panda a2a inspect <delivery-id>`");
    expect(dump).toContain("`panda a2a history [--peer-session <session-id>] [--direction inbound|outbound|all] [--limit <n>]`");
    expect(dump).toContain("`panda web fetch <url> [--chunk-chars <n>] [--format markdown|text] [--save <path>] [--include-links|--no-links]`");
    expect(dump).toContain("`panda web read <resource-ref> [--cursor <cursor>] [--chunk-chars <n>]`");
    expect(dump).toContain("`panda brave web search <query> [-n|--count <n>] [--offset <n>] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off|moderate|strict] [--extra-snippets] [--goggles <url-or-inline>]`");
    expect(dump).toContain("`panda brave news search <query> [-n|--count <n>] [--offset <n>] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off|moderate|strict] [--extra-snippets] [--goggles <url-or-inline>]`");
    expect(dump).toContain("`panda brave video search <query> [-n|--count <n>] [--offset <n>] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off|moderate|strict] [--no-spellcheck]`");
    expect(dump).toContain("`panda brave image search <query> [-n|--count <n>] [--country <code>] [--lang <code>] [--safe strict|off] [--no-spellcheck]`");
    expect(dump).toContain("`panda brave llm context <query> [-n|--count <n>] [--max-tokens <n>] [--max-urls <n>] [--threshold strict|balanced|lenient|disabled] [--local] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--goggles <url-or-inline>]`");
    expect(dump).toContain("`panda brave place search [query] [--location <location>|--lat <number> --lon <number>] [-n|--count <n>] [--radius <meters>] [--country <code>] [--lang <code>] [--units metric|imperial] [--safe off|moderate|strict] [--no-spellcheck]`");
    expect(dump).toContain("`panda brave place poi <id> [id...]`");
    expect(dump).toContain("`panda brave place description <id> [id...]`");
    expect(dump).toContain("`panda openai web-research <query|@file|@-> [--model <model>] [--effort low|medium|high]`");
    expect(dump).toContain("`panda image generate --prompt <text|@file|@-> [--image <path>...] [--model <model>] [--size <size>] [--quality low|medium|high|auto] [--format png|jpeg|webp] [--compression <0-100>] [--background transparent|opaque|auto] [--moderation low|auto] [--count <n>]`");
    expect(dump).toContain("`panda whisper transcribe <path> [--language <code>] [--prompt <text|@file|@->]`");
    expect(dump).toContain("`panda whisper translate <path> [--prompt <text|@file|@->]`");
    expect(dump).toContain("`panda email account list [--sendable-only]`");
    expect(dump).toContain("`panda email send --account <key> (--to <address>... --subject <text|@file|@->|--reply-to-email-id <email-id> [--reply-mode sender|all]) --text <text|@file|@-> [--html <text|@file|@->] [--cc <address>...] [--file <path>...]`");
    expect(dump).toContain("`panda telegram chat list [--connector <key>]`");
    expect(dump).toContain("`panda telegram chat info <conversation-id> [--connector <key>]`");
    expect(dump).toContain("`panda telegram send --chat <conversation-id> --connector <key> (--text <text|@file|@->|--stdin|--image <path>|--file <path>)... [--reply-to-message-id <message-id>]`");
    expect(dump).toContain("`panda telegram sticker send --chat <conversation-id> --connector <key> (--file <path>|--file-id <id>)`");
    expect(dump).toContain("`panda telegram edit <message-id> (--text <text|@file|@->|--stdin) --chat <conversation-id> --connector <key>`");
    expect(dump).toContain("`panda telegram delete <message-id> --chat <conversation-id> --connector <key>`");
    expect(dump).toContain("`panda telegram pin <message-id> --chat <conversation-id> --connector <key> [--silent]`");
    expect(dump).toContain("`panda telegram unpin <message-id> --chat <conversation-id> --connector <key>`");
    expect(dump).toContain("`panda discord channel list [--connector <key>]`");
    expect(dump).toContain("`panda discord send --channel <channel-id> --connector <key> [--thread <thread-id>] [--guild <guild-id>] (--text <text|@file|@->|--stdin|--image <path>|--file <path>)... [--reply-to-message-id <message-id>]`");
    expect(dump).toContain("`panda whatsapp chat list [--connector <key>]`");
    expect(dump).toContain("`panda whatsapp send --chat <jid-or-phone> --connector <key> (--text <text|@file|@->|--stdin|--image <path>|--file <path>)...`");
    expect(dump).toContain("Direct native tools remain: bash, background_job_status, background_job_wait, background_job_cancel, view_media, thinking_set.");
    expect(dump).not.toContain("panda session prompt.set");
    expect(dump).not.toContain("panda watch schema");
    expect(dump).not.toContain("panda agent skill");
    expect(dump).not.toContain("panda todo update");
    expect(dump).not.toContain("panda message agent send");
    expect(dump).not.toContain("panda outbound send");
    expect(dump).not.toContain("panda agent vent");
    expect(dump).not.toContain("panda web search");
    expect(dump).not.toContain("panda web research");
    expect(dump).not.toContain("panda audio transcribe");
    expect(dump).not.toContain("browser,");
    expect(dump).toContain("**Agent Profile:**");
    expect(dump).toContain("Summaries only. Query `session.agent_skills` for full skill bodies when you need the exact content.");
    expect(dump).toContain("calendar: Use this for calendar work.");
    expect(dump).not.toContain("Long skill body.");
    expect(dump).not.toContain("**Current DateTime:**");
    expect(dump).not.toContain("**Heartbeat Guidance**");
  });

  it("can limit Panda contexts to datetime and environment only", async () => {
    const fixture = await createFixture();

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: fixture.context,
      agentStore: fixture.agentStore,
      agentKey: "panda",
      sections: ["datetime", "environment"],
    }));

    expect(dump).toContain("**Current DateTime:**");
    expect(dump).toContain("**Environment Overview:**");
    expect(dump).not.toContain("**Agent Profile:**");
  });

  it("renders caller-supplied command descriptors in the CLI catalog", async () => {
    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {
        cwd: "/workspace/panda",
      },
      sections: ["command_catalog"],
      commandDescriptors: [customCommandDescriptor],
    }));

    expect(dump).toContain("**Panda CLI Catalog:**");
    expect(dump).toContain("`panda custom echo <message>`: Echo a custom message.");
    expect(dump).not.toContain("`panda watch list");
  });

  it("shows paired identities with recent route and channel hints", async () => {
    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {
        agentKey: "panda",
        cwd: "/workspace/panda",
        sessionId: "session-panda",
        threadId: "thread-panda",
      },
      agentKey: "panda",
      sections: ["paired_identities"],
      agentStore: {
        listAgentSkills: async () => [],
        listAgentPairings: async () => [
          {
            agentKey: "panda",
            identityId: "alice-id",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            agentKey: "panda",
            identityId: "bob-id",
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      },
      identityStore: {
        getIdentity: async (identityId) => {
          if (identityId === "alice-id") {
            return {
              id: "alice-id",
              handle: "alice",
              displayName: "Alice A.",
              status: "active" as const,
              createdAt: 1,
              updatedAt: 1,
            };
          }
          return {
            id: "bob-id",
            handle: "bob",
            displayName: "Bob B.",
            status: "active" as const,
            createdAt: 2,
            updatedAt: 2,
          };
        },
        listIdentityBindings: async (identityId) => identityId === "alice-id"
          ? [
            {
              id: "00000000-0000-0000-0000-000000000001",
              identityId,
              source: "telegram",
              connectorKey: "bot-main",
              externalActorId: "user-1",
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: "00000000-0000-0000-0000-000000000002",
              identityId,
              source: "whatsapp",
              connectorKey: "wa-main",
              externalActorId: "+421900000000",
              createdAt: 2,
              updatedAt: 2,
            },
          ]
          : [
            {
              id: "00000000-0000-0000-0000-000000000003",
              identityId,
              source: "discord",
              connectorKey: "discord-main",
              externalActorId: "bob-user",
              createdAt: 3,
              updatedAt: 3,
            },
          ],
      },
      sessionRoutes: {
        listLatestIdentityRoutes: async (lookup) => {
          expect(lookup).toEqual({
            sessionId: "session-panda",
            identityIds: ["alice-id", "bob-id"],
          });
          return [
            {
              sessionId: "session-panda",
              identityId: "alice-id",
              channel: "telegram",
              route: {
                source: "telegram",
                connectorKey: "bot-main",
                externalConversationId: "chat-1",
                externalActorId: "user-1",
                capturedAt: 100,
              },
              createdAt: 1,
              updatedAt: 1,
            },
          ];
        },
      },
    }));

    expect(dump).toContain("**Paired Identities:**");
    expect(dump).toContain("These identities are paired with this agent.");
    expect(dump).toContain("- alice (Alice A.): recent telegram/bot-main, conversation chat-1, actor user-1; whatsapp/wa-main actor +421900000000");
    expect(dump).toContain("- bob (Bob B.): discord/discord-main actor bob-user");
  });

  it("instantiates the wiki overview context when bindings are configured", async () => {
    const contexts = buildDefaultAgentLlmContexts({
      context: {
        cwd: "/workspace/panda",
      },
      agentKey: "panda",
      wikiBindings: {
        getBinding: async () => null,
      },
    });

    expect(contexts.some((context) => context.name === "Wiki Overview")).toBe(true);
  });

  it("shows running background bash jobs in the default Panda contexts when available", async () => {
    const threadStore = new TestThreadRuntimeStore();
    await threadStore.createThread({
      id: "thread-bg-context",
      sessionId: "session-bg-context",
    });
    await threadStore.createToolJob({
      id: "job-running",
      threadId: "thread-bg-context",
      kind: "bash",
      summary: "sleep 10 && printf running",
      startedAt: Date.now() - 1_500,
    });
    await threadStore.createToolJob({
      id: "job-done",
      threadId: "thread-bg-context",
      kind: "bash",
      summary: "printf done",
      startedAt: Date.now() - 5_000,
      status: "completed",
    });

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {
        cwd: "/workspace/panda",
      },
      threadStore,
      threadId: "thread-bg-context",
    }));

    expect(dump).toContain("**Background Jobs:**");
    expect(dump).toContain("job-running");
    expect(dump).toContain("sleep 10 && printf running");
    expect(dump).not.toContain("job-done");
  });

  it("shows active scheduled reminders in the default Panda contexts when available", async () => {
    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {
        cwd: "/workspace/panda",
        agentKey: "panda",
        sessionId: "session-main",
        threadId: "thread-main",
      },
      scheduledTasks: {
        listActiveTasks: async () => [{
          id: "task-1",
          sessionId: "session-main",
          title: "Follow up",
          instruction: "Check the deployment.",
          schedule: {
            kind: "once",
            runAt: "2026-05-09T09:00:00.000Z",
          },
          enabled: true,
          nextFireAt: Date.parse("2026-05-09T09:00:00.000Z"),
          createdAt: Date.parse("2026-05-08T09:00:00.000Z"),
          updatedAt: Date.parse("2026-05-08T09:00:00.000Z"),
        }],
      },
    }));

    expect(dump).toContain("**Scheduled Reminders:**");
    expect(dump).toContain("task-1");
    expect(dump).toContain("Follow up");
  });

  it("shows session todo context in the default Panda contexts when available", async () => {
    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {
        cwd: "/workspace/panda",
        agentKey: "panda",
        sessionId: "session-main",
        threadId: "thread-main",
      },
      sessionStore: {
        readSessionTodo: async () => ({
          sessionId: "session-main",
          items: [
            {status: "in_progress", content: "Implement todo context"},
            {status: "pending", content: "Run validation"},
          ],
          itemsHash: "hash",
          createdAt: 1,
          updatedAt: 2,
        }),
      },
    }));

    expect(dump).toContain("**Todo Context:**");
    expect(dump).toContain("- [in_progress] Implement todo context");
    expect(dump).toContain("- [pending] Run validation");
  });

  it("omits the background bash section when no jobs are running", async () => {
    const threadStore = new TestThreadRuntimeStore();
    await threadStore.createThread({
      id: "thread-no-bg-context",
      sessionId: "session-no-bg-context",
    });
    await threadStore.createToolJob({
      id: "job-done",
      threadId: "thread-no-bg-context",
      kind: "bash",
      summary: "printf done",
      startedAt: Date.now() - 5_000,
      status: "completed",
    });

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {
        cwd: "/workspace/panda",
      },
      threadStore,
      threadId: "thread-no-bg-context",
      sections: ["background_jobs"],
    }));

    expect(dump).toBe("");
  });
});
