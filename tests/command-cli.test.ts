import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";

import {buildCommandRouteTree} from "../src/domain/commands/index.js";
import {registerCommandCatalogCommands, registerCommandRouteHelpCommands} from "../src/domain/commands/cli.js";
import type {CommandDescriptor} from "../src/domain/commands/types.js";
import {registerA2ACommands} from "../src/domain/a2a/cli.js";
import {registerAppCommandHelpCommands} from "../src/domain/apps/cli.js";
import {registerSkillCommandHelpCommands} from "../src/domain/agents/skill-cli.js";
import {registerEnvCommandHelpCommands} from "../src/domain/credentials/env-cli.js";
import {registerEmailCommands} from "../src/domain/email/cli.js";
import {registerEnvironmentCommandHelpCommands} from "../src/domain/execution-environments/cli.js";
import {registerScheduleCommandHelpCommands} from "../src/domain/scheduling/tasks/cli.js";
import {registerSessionCommands} from "../src/domain/sessions/cli.js";
import {registerTodoCommandHelpCommands} from "../src/domain/sessions/todo-cli.js";
import {subagentSpawnCommandDescriptor} from "../src/domain/subagents/commands.js";
import {registerSubagentCommandHelpCommands} from "../src/domain/subagents/cli.js";
import {registerTimeCommandHelpCommands} from "../src/domain/time/cli.js";
import {registerWatchCommandHelpCommands} from "../src/domain/watches/cli.js";
import {registerWhisperCommandHelpCommands} from "../src/integrations/audio/cli.js";
import {registerTelegramCommands} from "../src/integrations/channels/telegram/cli.js";
import {registerDiscordCommands} from "../src/integrations/channels/discord/cli.js";
import {registerWhatsAppCommands} from "../src/integrations/channels/whatsapp/cli.js";
import {registerVentCommandHelpCommands} from "../src/integrations/panda-trace/vent-cli.js";
import {ventSendCommandDescriptor} from "../src/integrations/panda-trace/vent-commands.js";
import {registerPostgresCommandHelpCommands} from "../src/integrations/postgres/cli.js";
import {registerWebCommandHelpCommands} from "../src/integrations/web/cli.js";
import {
  braveImageSearchCommandDescriptor,
  braveLlmContextCommandDescriptor,
  braveNewsSearchCommandDescriptor,
  bravePlaceDescriptionCommandDescriptor,
  bravePlacePoiCommandDescriptor,
  bravePlaceSearchCommandDescriptor,
  braveVideoSearchCommandDescriptor,
  braveWebSearchCommandDescriptor,
  openAIWebResearchCommandDescriptor,
  webFetchCommandDescriptor,
} from "../src/integrations/web/commands.js";
import {imageGenerateCommandDescriptor} from "../src/panda/commands/image-generate-command.js";
import {whisperTranscribeCommandDescriptor, whisperTranslateCommandDescriptor} from "../src/integrations/audio/commands.js";
import {registerWikiCommands} from "../src/domain/wiki/cli.js";
import {DEFAULT_AGENT_COMMAND_DESCRIPTORS} from "../src/panda/commands/agent-command-descriptors.js";
import {DEFAULT_AGENT_COMMAND_CATALOG} from "../src/panda/commands/agent-command-modules.js";
import {registerImageCommandHelpCommands} from "../src/panda/commands/image-cli.js";
import {todoClearCommandDescriptor} from "../src/domain/sessions/todo-commands.js";

const defaultCommandRouteTree = buildCommandRouteTree({
  routes: DEFAULT_AGENT_COMMAND_CATALOG.routes(),
  descriptors: DEFAULT_AGENT_COMMAND_DESCRIPTORS,
});

function extractUsageOptionNames(usage: string): string[] {
  return [...new Set(
    [...usage.matchAll(/--[a-z][a-z0-9-]*/g)].map((match) => match[0].slice(2)),
  )];
}

function createProgram(): Command {
  const program = new Command();
  registerCommandCatalogCommands(program, DEFAULT_AGENT_COMMAND_DESCRIPTORS);
  registerAppCommandHelpCommands(program);
  registerEnvironmentCommandHelpCommands(program);
  registerEnvCommandHelpCommands(program);
  registerScheduleCommandHelpCommands(program);
  registerWatchCommandHelpCommands(program);
  registerTimeCommandHelpCommands(program);
  registerSkillCommandHelpCommands(program);
  registerVentCommandHelpCommands(program);
  registerPostgresCommandHelpCommands(program);
  registerWebCommandHelpCommands(program);
  registerImageCommandHelpCommands(program);
  registerWhisperCommandHelpCommands(program);
  registerWikiCommands(program);
  registerTodoCommandHelpCommands(program);
  registerSessionCommands(program);
  registerSubagentCommandHelpCommands(program);
  registerA2ACommands(program);
  registerEmailCommands(program);
  registerTelegramCommands(program);
  registerDiscordCommands(program);
  registerWhatsAppCommands(program);
  registerCommandRouteHelpCommands(program, defaultCommandRouteTree);
  return program;
}

describe("Panda command CLI discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the allowed command catalog as JSON", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["commands", "--output", "json"], {from: "user"});

    const payload = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(payload.commands[0]).toMatchObject({
      name: DEFAULT_AGENT_COMMAND_DESCRIPTORS[0]?.name,
      usage: DEFAULT_AGENT_COMMAND_DESCRIPTORS[0]?.usage,
    });
    expect(payload.commands.map((command: {name: string}) => command.name)).toEqual(
      DEFAULT_AGENT_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name),
    );
    const commandNames = payload.commands.map((command: {name: string}) => command.name);
    for (const unavailableCommand of [
      "watch.schema",
      "agent.skill.load",
      "agent.skill.set",
      "agent.skill.patch",
      "agent.skill.delete",
      "todo.update",
      "message.agent.send",
      "outbound.send",
      "web.search",
      "web.research",
    ]) {
      expect(commandNames).not.toContain(unavailableCommand);
    }
    expect(commandNames).not.toContain("agent.vent");
    expect(commandNames).toContain("whisper.translate");
    expect(commandNames).not.toContain("audio.transcribe");
    expect(payload.commands.find((command: {name: string}) => command.name === "watch.create")).not.toHaveProperty(
      "schemaCatalog",
    );
  });

  it("prints command keys by default and a stable table explicitly", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["commands"], {from: "user"});
    const keys = String(write.mock.calls[0]?.[0]);
    expect(keys.split("\n")).toContain("skill.list");

    write.mockClear();
    await createProgram().parseAsync(["commands", "--output", "table"], {from: "user"});
    expect(String(write.mock.calls[0]?.[0])).toMatch(/^COMMAND\tSUMMARY\tINPUT MODES\tOUTPUT MODES\n/);
  });

  it("rejects the removed commands --json output alias", async () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({writeErr: vi.fn()});
    const commands = program.commands.find((command) => command.name() === "commands");
    commands?.exitOverride();
    commands?.configureOutput({writeErr: vi.fn()});

    await expect(program.parseAsync(["commands", "--json"], {from: "user"}))
      .rejects.toMatchObject({code: "commander.unknownOption"});
  });

  it("marks file and stdin value sources on descriptor body inputs", () => {
    const missing = DEFAULT_AGENT_COMMAND_DESCRIPTORS.flatMap((descriptor) =>
      descriptor.arguments
        .filter((argument) => String(argument.valueName ?? "").includes("@file") || String(argument.valueName ?? "").includes("@-"))
        .filter((argument) => !argument.valueSources?.includes("file") || !argument.valueSources.includes("stdin"))
        .map((argument) => `${descriptor.name}:${argument.name}`),
    );

    expect(missing).toEqual([]);
  });

  it("keeps descriptor option metadata aligned with advertised usage flags", () => {
    const missingFromUsage: string[] = [];
    const missingFromMetadata: string[] = [];

    for (const descriptor of DEFAULT_AGENT_COMMAND_DESCRIPTORS) {
      const metadataOptions = descriptor.arguments
        .filter((argument) => argument.kind !== "positional")
        .map((argument) => argument.name);
      const usageOptions = extractUsageOptionNames(descriptor.usage);
      for (const option of metadataOptions) {
        if (option !== "json" && !usageOptions.includes(option)) {
          missingFromUsage.push(`${descriptor.name}:--${option}`);
        }
      }
      for (const option of usageOptions) {
        if (option !== "help" && !metadataOptions.includes(option)) {
          missingFromMetadata.push(`${descriptor.name}:--${option}`);
        }
      }
    }

    expect(missingFromUsage).toEqual([]);
    expect(missingFromMetadata).toEqual([]);
  });

  it("prints descriptor-backed JSON help for every default catalog route", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    for (const leaf of defaultCommandRouteTree.commands) {
      write.mockClear();
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([...leaf.argv, "--help", "--json"], {from: "user"});

      expect(write.mock.calls.length, leaf.command).toBeGreaterThan(0);
      expect(JSON.parse(String(write.mock.calls[0]?.[0])), leaf.command).toMatchObject({
        name: leaf.command,
        usage: leaf.descriptor.usage,
      });
    }
  });

  it("registers descriptor-backed help for catalog routes without bespoke CLI stubs", async () => {
    const descriptor: CommandDescriptor = {
      name: "custom.echo",
      summary: "Echo custom text.",
      description: "Echo custom text.",
      usage: "panda custom echo <text>",
      inputModes: ["json"],
      outputModes: ["json"],
      arguments: [
        {
          name: "text",
          kind: "positional",
          description: "Text to echo.",
          required: true,
          valueType: "string",
        },
      ],
      examples: [],
    };
    const routeTree = buildCommandRouteTree({
      routes: [{
        command: "custom.echo",
        helpArgv: ["custom", "echo"],
        jsonArgv: ["custom", "echo", "--json", "@payload.json"],
      }],
      descriptors: [descriptor],
    });
    const program = new Command();
    registerCommandRouteHelpCommands(program, routeTree);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["custom", "echo", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "custom.echo",
      usage: "panda custom echo <text>",
    });
  });

  it("refuses native-shaped host invocations with shim transport guidance", async () => {
    const cases: readonly {argv: readonly string[]; message: string}[] = [
      {
        argv: ["watch", "create", "--title", "Check API", "--every", "5", "--source-json", "{}", "--detector-json", "{}"],
        message: "panda watch create execution requires the agent command shim transport",
      },
      {
        argv: ["schedule", "create", "check CI", "--at", "2026-07-06T09:00:00+02:00", "--instruction", "check status"],
        message: "panda schedule create execution requires the agent command shim transport",
      },
      {
        argv: ["env", "set", "GITHUB_TOKEN", "--stdin"],
        message: "panda env set execution requires the agent command shim transport",
      },
      {
        argv: ["web", "fetch", "https://example.com", "--max-chars", "100"],
        message: "panda web fetch execution requires the agent command shim transport",
      },
      {
        argv: ["image", "generate", "--prompt", "red mug"],
        message: "panda image generate execution requires the agent command shim transport",
      },
      {
        argv: ["postgres", "readonly", "query", "--sql", "select 1"],
        message: "panda postgres readonly query execution requires the agent command shim transport",
      },
      {
        argv: ["skill", "set", "calendar", "--description", "Calendar helper", "--content", "Use calendars."],
        message: "panda skill set execution requires the agent command shim transport",
      },
      {
        argv: ["todo", "add", "ship this", "--status", "pending"],
        message: "panda todo add execution requires the agent command shim transport",
      },
      {
        argv: ["environment", "create", "--label", "scratch", "--ttl", "1h"],
        message: "panda environment create execution requires the agent command shim transport",
      },
      {
        argv: ["vent", "--message", "done"],
        message: "panda vent execution requires the agent command shim transport",
      },
      {
        argv: ["micro-app", "create", "notes", "--name", "Notes"],
        message: "panda micro-app create execution requires the agent command shim transport",
      },
      {
        argv: ["a2a", "send", "--to-agent", "assistant", "--text", "status"],
        message: "panda a2a send execution requires the agent command shim transport",
      },
      {
        argv: ["telegram", "send", "--chat", "chat-1", "--connector", "main", "--text", "hello"],
        message: "panda telegram send execution requires the agent command shim transport",
      },
      {
        argv: ["discord", "send", "--channel", "123", "--connector", "main", "--text", "hello"],
        message: "panda discord send execution requires the agent command shim transport",
      },
      {
        argv: ["whatsapp", "send", "--chat", "421900000000", "--connector", "main", "--text", "hello"],
        message: "panda whatsapp send execution requires the agent command shim transport",
      },
      {
        argv: ["email", "send", "--account", "work", "--to", "alice@example.com", "--subject", "Report", "--text", "Done"],
        message: "panda email send execution requires the agent command shim transport",
      },
      {
        argv: ["wiki", "write", "page", "docs/native-cli", "--content", "Native CLI notes"],
        message: "panda wiki write page execution requires the agent command shim transport",
      },
      {
        argv: ["session", "prompt", "current", "set", "brief", "--content", "Focus on CLI polish"],
        message: "panda session prompt current set execution requires the agent command shim transport",
      },
      {
        argv: ["subagent", "spawn", "review the diff", "--profile", "reviewer", "--context", "CLI polish"],
        message: "panda subagent spawn execution requires the agent command shim transport",
      },
      {
        argv: ["time", "now", "--timezone", "Europe/Bratislava"],
        message: "panda time now execution requires the agent command shim transport",
      },
    ];

    for (const {argv, message} of cases) {
      const program = createProgram();
      program.exitOverride();

      await expect(program.parseAsync(argv, {from: "user"}), argv.join(" ")).rejects.toThrow(message);
    }
  });

  it("includes descriptor-backed JSON help for web.fetch", async () => {
    expect(webFetchCommandDescriptor).toMatchObject({
      name: "web.fetch",
      usage: "panda web fetch <url> [--max-chars <n>] [--format markdown|text] [--save <path>] [--include-links|--no-links]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        finalUrl: "string",
        content: "string|absent when saved",
        saved: "object|null",
      },
    });
  });

  it("includes descriptor-backed JSON help for Brave verticals", async () => {
    expect(braveWebSearchCommandDescriptor).toMatchObject({
      name: "brave.web.search",
      usage: "panda brave web search <query> [-n|--count <n>] [--offset <n>] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off|moderate|strict] [--extra-snippets] [--goggles <url-or-inline>]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        provider: "brave",
        vertical: "web",
      },
    });
    expect(braveNewsSearchCommandDescriptor).toMatchObject({
      name: "brave.news.search",
      usage: "panda brave news search <query> [-n|--count <n>] [--offset <n>] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off|moderate|strict] [--extra-snippets] [--goggles <url-or-inline>]",
      resultShape: {
        vertical: "news",
      },
    });
    expect(braveVideoSearchCommandDescriptor).toMatchObject({
      name: "brave.video.search",
      usage: "panda brave video search <query> [-n|--count <n>] [--offset <n>] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off|moderate|strict] [--no-spellcheck]",
      resultShape: {
        vertical: "video",
      },
    });
    expect(braveImageSearchCommandDescriptor).toMatchObject({
      name: "brave.image.search",
      usage: "panda brave image search <query> [-n|--count <n>] [--country <code>] [--lang <code>] [--safe strict|off] [--no-spellcheck]",
      resultShape: {
        vertical: "image",
      },
    });
    expect(braveLlmContextCommandDescriptor).toMatchObject({
      name: "brave.llm.context",
      usage: "panda brave llm context <query> [-n|--count <n>] [--max-tokens <n>] [--max-urls <n>] [--threshold strict|balanced|lenient|disabled] [--local] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--goggles <url-or-inline>]",
      resultShape: {
        vertical: "llm_context",
        grounding: "object",
      },
    });
    expect(bravePlaceSearchCommandDescriptor).toMatchObject({
      name: "brave.place.search",
      usage: "panda brave place search [query] [--location <location>|--lat <number> --lon <number>] [-n|--count <n>] [--radius <meters>] [--country <code>] [--lang <code>] [--units metric|imperial] [--safe off|moderate|strict] [--no-spellcheck]",
      resultShape: {
        vertical: "place",
        places: ["object"],
      },
    });
    expect(bravePlacePoiCommandDescriptor).toMatchObject({
      name: "brave.place.poi",
      usage: "panda brave place poi <id> [id...]",
      resultShape: {
        vertical: "place_poi",
        payload: "object",
      },
    });
    expect(bravePlaceDescriptionCommandDescriptor).toMatchObject({
      name: "brave.place.description",
      usage: "panda brave place description <id> [id...]",
      resultShape: {
        vertical: "place_description",
        payload: "object",
      },
    });
  });

  it("includes descriptor-backed JSON help for openai.web_research", async () => {
    expect(openAIWebResearchCommandDescriptor).toMatchObject({
      name: "openai.web_research",
      usage: "panda openai web-research <query|@file|@-> [--model <model>] [--effort low|medium|high]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "query",
          kind: "positional",
          valueName: "query|@file|@-",
          valueSources: ["literal", "file", "stdin"],
        }),
        expect.objectContaining({name: "model", valueName: "model"}),
        expect.objectContaining({name: "effort", valueName: "low|medium|high"}),
      ]),
      resultShape: {
        jobId: "string",
        kind: "web_research",
      },
    });
  });

  it("includes descriptor-backed JSON help for image.generate", async () => {
    expect(imageGenerateCommandDescriptor).toMatchObject({
      name: "image.generate",
      usage: "panda image generate --prompt <text|@file|@-> [--image <path>...] [--model <model>] [--size <size>] [--quality low|medium|high|auto] [--format png|jpeg|webp] [--compression <0-100>] [--background transparent|opaque|auto] [--moderation low|auto] [--count <n>]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "prompt",
          valueName: "text|@file|@-",
          required: true,
        }),
        expect.objectContaining({
          name: "image",
          valueName: "path",
        }),
        expect.objectContaining({
          name: "format",
          valueName: "png|jpeg|webp",
        }),
      ]),
      resultShape: {
        jobId: "string",
        kind: "image_generate",
      },
    });
  });

  it("includes descriptor-backed JSON help for whisper audio commands", async () => {
    expect(whisperTranscribeCommandDescriptor).toMatchObject({
      name: "whisper.transcribe",
      usage: "panda whisper transcribe <path> [--language <code>] [--prompt <text|@file|@->]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "path",
          kind: "positional",
          valueName: "path",
          required: true,
        }),
        expect.objectContaining({
          name: "prompt",
          valueName: "text|@file|@-",
        }),
      ]),
      resultShape: {
        text: "string",
        model: "whisper-1",
      },
    });
    expect(whisperTranslateCommandDescriptor).toMatchObject({
      name: "whisper.translate",
      usage: "panda whisper translate <path> [--prompt <text|@file|@->]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "path",
          kind: "positional",
          valueName: "path",
          required: true,
        }),
        expect.objectContaining({
          name: "prompt",
          valueName: "text|@file|@-",
        }),
      ]),
      resultShape: {
        text: "string",
        model: "whisper-1",
        targetLanguage: "en",
      },
    });
  });

  it("includes descriptor-backed JSON help for subagent.spawn", async () => {
    expect(subagentSpawnCommandDescriptor).toMatchObject({
      name: "subagent.spawn",
      usage: "panda subagent spawn (<task|@file|@->|--prompt <text|@file|@->) [--profile <slug>|--tool-group <group>...] [--context <text|@file|@->] [(--environment <environment-id> [--isolated]|--agent-workspace)] [--credential <env-key>...]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "task",
          kind: "positional",
          valueName: "text|@file|@-",
          required: true,
        }),
        expect.objectContaining({
          name: "profile",
          valueName: "slug",
        }),
        expect.objectContaining({
          name: "environment",
          valueName: "environment-id",
        }),
        expect.objectContaining({
          name: "tool-group",
          valueName: "group",
        }),
      ]),
      resultShape: {
        status: "spawned",
        sessionId: "string",
      },
    });
  });

  it("includes descriptor-backed JSON help for vent command", async () => {
    expect(ventSendCommandDescriptor).toMatchObject({
      name: "vent.send",
      usage: "panda vent (--message <text|@file|@->|--stdin)",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "message",
          valueName: "text|@file|@-",
        }),
        expect.objectContaining({
          name: "stdin",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        status: "sent|dropped",
        messageLength: "number",
      },
    });
  });

  it("prints descriptor-backed JSON help for vent", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["vent", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "vent.send",
      usage: "panda vent (--message <text|@file|@->|--stdin)",
    });
  });

  it("prints descriptor-backed JSON help for time commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["time", "now", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "time.now",
      usage: "panda time now [--timezone <iana>] [--format iso|local|full]",
      inputModes: ["flags", "json"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "timezone",
          valueName: "iana",
        }),
        expect.objectContaining({
          name: "format",
          valueName: "iso|local|full",
        }),
      ]),
      resultShape: {
        display: "string",
        isoTimestamp: "string",
        timeZone: "string",
      },
    });
  });

  it("prints descriptor-backed JSON help for watch create", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["watch", "create", "--help", "--json"], {from: "user"});

    const payload = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      name: "watch.create",
      usage: "panda watch create --title <text|@file|@-> --every <minutes> (--url <url> --value-path <path> --percent-change <n> [--label <text|@file|@->]|--source-json <json|@file|@-> --detector-json <json|@file|@-> [--source-kind <kind>] [--detector-kind <kind>]) [--disabled]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "title",
          required: true,
          valueName: "text|@file|@-",
        }),
        expect.objectContaining({
          name: "every",
          required: true,
          valueName: "minutes",
        }),
        expect.objectContaining({
          name: "source-json",
          valueName: "json|@file|@-",
        }),
        expect.objectContaining({
          name: "detector-json",
          valueName: "json|@file|@-",
        }),
        expect.objectContaining({
          name: "url",
          valueName: "url",
        }),
        expect.objectContaining({
          name: "value-path",
          valueName: "path",
        }),
        expect.objectContaining({
          name: "percent-change",
          valueName: "n",
        }),
        expect.objectContaining({
          name: "disabled",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        watchId: "string",
      },
      schemaCatalog: {
        sourceKinds: expect.arrayContaining(["http_json"]),
        detectorKinds: expect.arrayContaining(["percent_change"]),
        sources: {
          http_json: {
            schema: expect.any(Object),
            example: expect.objectContaining({
              kind: "http_json",
            }),
            notes: expect.arrayContaining([expect.stringContaining("credentialEnvKey")]),
          },
        },
        detectors: {
          percent_change: {
            schema: expect.any(Object),
            example: expect.objectContaining({
              kind: "percent_change",
            }),
            notes: expect.arrayContaining([expect.stringContaining("scalar")]),
          },
        },
      },
    });
  });

  it("prints descriptor-backed JSON help for watch update and disable", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["watch", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["watch", "show", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["watch", "runs", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["watch", "update", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["watch", "disable", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "watch.list",
      usage: "panda watch list [--status enabled|disabled|all] [--limit <n>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "status",
          valueName: "enabled|disabled|all",
        }),
      ]),
      resultShape: {
        operation: "list",
        watches: expect.arrayContaining([
          expect.objectContaining({
            watchId: "string",
          }),
        ]),
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "watch.show",
      usage: "panda watch show <watch-id>",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "watch-id",
          kind: "positional",
        }),
      ]),
      resultShape: {
        operation: "show",
        source: "object",
        detector: "object",
      },
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "watch.runs",
      usage: "panda watch runs <watch-id> [--limit <n>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "watch-id",
          kind: "positional",
        }),
        expect.objectContaining({
          name: "limit",
          valueName: "n",
        }),
      ]),
      resultShape: {
        operation: "runs",
        runs: expect.arrayContaining([
          expect.objectContaining({
            runId: "string",
          }),
        ]),
      },
    });
    expect(JSON.parse(String(write.mock.calls[3]?.[0]))).toMatchObject({
      name: "watch.update",
      usage: "panda watch update <watch-id> [--title <text|@file|@->] [--every <minutes>] [--url <url> --value-path <path> [--label <text|@file|@->]] [--percent-change <n>] [--source-json <json|@file|@->] [--detector-json <json|@file|@->] [--source-kind <kind>] [--detector-kind <kind>] [--enable|--disable]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "watch-id",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "enable",
          valueType: "boolean",
        }),
        expect.objectContaining({
          name: "url",
          valueName: "url",
        }),
        expect.objectContaining({
          name: "value-path",
          valueName: "path",
        }),
        expect.objectContaining({
          name: "percent-change",
          valueName: "n",
        }),
        expect.objectContaining({
          name: "disable",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        updated: true,
      },
      schemaCatalog: {
        sourceKinds: expect.arrayContaining(["http_json"]),
        detectorKinds: expect.arrayContaining(["percent_change"]),
        sources: {
          http_json: {
            schema: expect.any(Object),
          },
        },
        detectors: {
          percent_change: {
            schema: expect.any(Object),
          },
        },
      },
    });
    expect(JSON.parse(String(write.mock.calls[4]?.[0]))).toMatchObject({
      name: "watch.disable",
      usage: "panda watch disable <watch-id> [--reason <text|@file|@->]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: [
        {
          name: "watch-id",
          kind: "positional",
          valueName: "watch-id",
          required: true,
        },
        {
          name: "reason",
          valueName: "text|@file|@-",
          valueSources: ["literal", "file", "stdin"],
        },
        {
          name: "json",
          required: false,
        },
      ],
      resultShape: {
        disabled: true,
      },
    });
  });

  it("prints descriptor-backed JSON help for schedule commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["schedule", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["schedule", "show", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["schedule", "runs", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["schedule", "create", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["schedule", "update", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["schedule", "cancel", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "schedule.list",
      usage: "panda schedule list [--status active|disabled|completed|cancelled|all] [--limit <n>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "status",
          valueName: "active|disabled|completed|cancelled|all",
        }),
      ]),
      resultShape: {
        operation: "list",
        tasks: expect.arrayContaining([
          expect.objectContaining({
            taskId: "string",
          }),
        ]),
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "schedule.show",
      usage: "panda schedule show <task-id>",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "task-id",
          kind: "positional",
        }),
      ]),
      resultShape: {
        operation: "show",
        instruction: "string",
        schedule: "object",
      },
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "schedule.runs",
      usage: "panda schedule runs <task-id> [--limit <n>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "task-id",
          kind: "positional",
        }),
        expect.objectContaining({
          name: "limit",
          valueName: "n",
        }),
      ]),
      resultShape: {
        operation: "runs",
        runs: expect.arrayContaining([
          expect.objectContaining({
            runId: "string",
          }),
        ]),
      },
    });
    expect(JSON.parse(String(write.mock.calls[3]?.[0]))).toMatchObject({
      name: "schedule.create",
      usage: "panda schedule create <title> (--at <iso>|--cron <expr> --timezone <tz>) --instruction <text|@file|@-> [--disabled]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "title",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "at",
          valueName: "iso",
        }),
        expect.objectContaining({
          name: "instruction",
          valueName: "text|@file|@-",
          required: true,
        }),
        expect.objectContaining({
          name: "disabled",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        taskId: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[4]?.[0]))).toMatchObject({
      name: "schedule.update",
      usage: "panda schedule update <task-id> [--title <text|@file|@->] [--at <iso>|--cron <expr> --timezone <tz>] [--instruction <text|@file|@->] [--enable|--disable]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "task-id",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "enable",
          valueType: "boolean",
        }),
        expect.objectContaining({
          name: "disable",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        updated: true,
      },
    });
    expect(JSON.parse(String(write.mock.calls[5]?.[0]))).toMatchObject({
      name: "schedule.cancel",
      usage: "panda schedule cancel <task-id> [--reason <text|@file|@->]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: [
        {
          name: "task-id",
          kind: "positional",
          valueName: "task-id",
          required: true,
        },
        {
          name: "reason",
          valueName: "text|@file|@-",
          valueSources: ["literal", "file", "stdin"],
        },
        {
          name: "json",
          required: false,
        },
      ],
      resultShape: {
        cancelled: true,
      },
    });
  });

  it("prints descriptor-backed JSON help for micro-app commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["micro-app", "view", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["micro-app", "action", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["micro-app", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["micro-app", "create", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["micro-app", "link", "create", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "micro-app.view",
      usage: "panda micro-app view <app-slug> <view-name> [--param key=value] [--params <json|@file|@->] [--page-size <n>] [--offset <n>]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "app-slug",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "view-name",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "params",
          valueName: "json|@file|@-",
        }),
        expect.objectContaining({
          name: "page-size",
          valueType: "number",
        }),
        expect.objectContaining({
          name: "offset",
          valueType: "number",
        }),
      ]),
      resultShape: {
        appSlug: "string",
        viewName: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "micro-app.action",
      usage: "panda micro-app action <app-slug> <action-name> [--input <json|@file|@->]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "app-slug",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "action-name",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "input",
          valueName: "json|@file|@-",
        }),
      ]),
      resultShape: {
        actionName: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "micro-app.list",
      usage: "panda micro-app list [app-slug] [--full]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "app-slug",
          kind: "positional",
        }),
        expect.objectContaining({
          name: "full",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        apps: ["object"],
      },
    });
    expect(JSON.parse(String(write.mock.calls[3]?.[0]))).toMatchObject({
      name: "micro-app.create",
      usage: "panda micro-app create <slug> --name <text|@file|@-> [--description <text|@file|@->] [--identity-scoped] [--schema <sql|@file|@->]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "slug",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "name",
          required: true,
          valueName: "text|@file|@-",
        }),
        expect.objectContaining({
          name: "description",
          valueName: "text|@file|@-",
        }),
        expect.objectContaining({
          name: "identity-scoped",
          valueType: "boolean",
        }),
        expect.objectContaining({
          name: "schema",
          valueName: "sql|@file|@-",
        }),
      ]),
      resultShape: {
        appDir: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[4]?.[0]))).toMatchObject({
      name: "micro-app.link.create",
      usage: "panda micro-app link create <app-slug> [--expires <minutes|Nm|Nh>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "app-slug",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "expires",
          valueName: "minutes|Nm|Nh",
        }),
      ]),
      resultShape: {
        openUrl: "string",
      },
    });
  });

  it("prints descriptor-backed JSON help for environment commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["environment", "create", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["environment", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["environment", "show", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["environment", "stop", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["environment", "logs", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "environment.create",
      usage: "panda environment create [--label <text|@file|@->] [--ttl <hours|Nh>] [--setup-script <path>]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "label",
          valueName: "text|@file|@-",
          valueSources: ["literal", "file", "stdin"],
        }),
        expect.objectContaining({
          name: "ttl",
          valueName: "hours|Nh",
        }),
        expect.objectContaining({
          name: "setup-script",
          valueName: "path",
        }),
      ]),
      resultShape: {
        environmentId: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "environment.list",
      usage: "panda environment list [--state <state>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "state",
        }),
      ]),
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "environment.show",
      usage: "panda environment show <environment-id>",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "environment-id",
          kind: "positional",
        }),
      ]),
    });
    expect(JSON.parse(String(write.mock.calls[3]?.[0]))).toMatchObject({
      name: "environment.stop",
      usage: "panda environment stop <environment-id>",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "environment-id",
          kind: "positional",
        }),
      ]),
      resultShape: {
        environmentState: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[4]?.[0]))).toMatchObject({
      name: "environment.logs",
      usage: "panda environment logs <environment-id> [--role control|workspace|all] [--tail <n>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "environment-id",
          kind: "positional",
        }),
        expect.objectContaining({
          name: "role",
          valueName: "control|workspace|all",
        }),
        expect.objectContaining({
          name: "tail",
          valueName: "n",
        }),
      ]),
      resultShape: {
        operation: "logs",
      },
    });
  });

  it("prints descriptor-backed JSON help for env commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["env", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["env", "set", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["env", "clear", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "env.list",
      usage: "panda env list [--prefix <prefix>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "prefix",
          valueName: "prefix",
        }),
      ]),
      resultShape: {
        count: "number",
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "env.set",
      usage: "panda env set <key> (--stdin|--from-file <path>)",
      inputModes: ["flags", "stdin", "json", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "from-file",
          valueName: "path",
        }),
      ]),
      resultShape: {
        envKey: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "env.clear",
      usage: "panda env clear <key>",
      resultShape: {
        deleted: "boolean",
      },
    });
  });

  it("prints descriptor-backed JSON help for channel sends", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["telegram", "chat", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "chat", "info", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "history", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "media", "fetch", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "send", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "sticker", "send", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "react", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "edit", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "delete", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "pin", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["telegram", "unpin", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["discord", "channel", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["discord", "history", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["discord", "send", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["whatsapp", "chat", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["whatsapp", "history", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["whatsapp", "send", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "telegram.chat.list",
      usage: "panda telegram chat list [--connector <key>]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "connector",
          valueName: "key",
        }),
      ]),
      resultShape: {
        count: "number",
        chats: ["object"],
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "telegram.chat.info",
      usage: "panda telegram chat info <conversation-id> [--connector <key>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "conversation-id",
          kind: "positional",
        }),
      ]),
      resultShape: {
        chat: "object",
      },
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "telegram.history",
      usage: "panda telegram history --chat <conversation-id> [--connector <key>] [--direction inbound|outbound|all] [--limit <n>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "chat",
          required: true,
        }),
        expect.objectContaining({
          name: "direction",
          enumValues: ["inbound", "outbound", "all"],
        }),
      ]),
      resultShape: {
        source: "durable_panda_records",
        items: ["object"],
      },
    });
    expect(JSON.parse(String(write.mock.calls[3]?.[0]))).toMatchObject({
      name: "telegram.media.fetch",
      usage: "panda telegram media fetch <media-id> --chat <conversation-id> [--connector <key>] [--save <path>] [--overwrite]",
      outputModes: ["json", "text"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "media-id",
          kind: "positional",
        }),
        expect.objectContaining({
          name: "save",
          valueName: "path",
        }),
        expect.objectContaining({
          name: "overwrite",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        media: "object",
        saved: "object",
      },
    });
    expect(JSON.parse(String(write.mock.calls[4]?.[0]))).toMatchObject({
      name: "telegram.send",
      usage: "panda telegram send --chat <conversation-id> --connector <key> (--text <text|@file|@->|--stdin|--image <path>|--file <path>)... [--reply-to-message-id <message-id>]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "chat",
          required: true,
        }),
        expect.objectContaining({
          name: "text",
          valueName: "text|@file|@-",
        }),
        expect.objectContaining({
          name: "stdin",
          valueType: "boolean",
        }),
        expect.objectContaining({
          name: "image",
          valueName: "path",
        }),
      ]),
      resultShape: {
        deliveryId: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[5]?.[0]))).toMatchObject({
      name: "telegram.sticker.send",
      usage: "panda telegram sticker send --chat <conversation-id> --connector <key> (--file <path>|--file-id <id>)",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "file",
          valueName: "path",
        }),
        expect.objectContaining({
          name: "file-id",
          valueName: "id",
        }),
      ]),
      resultShape: {
        queued: "boolean",
      },
    });
    expect(JSON.parse(String(write.mock.calls[6]?.[0]))).toMatchObject({
      name: "telegram.react",
      usage: "panda telegram react <message-id> (--emoji <emoji>|--remove) --chat <conversation-id> --connector <key>",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "message-id",
          kind: "positional",
        }),
        expect.objectContaining({
          name: "emoji",
          valueName: "emoji",
        }),
        expect.objectContaining({
          name: "remove",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        messageId: "string",
        queued: "boolean",
      },
    });
    expect(JSON.parse(String(write.mock.calls[7]?.[0]))).toMatchObject({
      name: "telegram.edit",
      usage: "panda telegram edit <message-id> (--text <text|@file|@->|--stdin) --chat <conversation-id> --connector <key>",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "text",
          valueName: "text|@file|@-",
        }),
        expect.objectContaining({
          name: "stdin",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        edited: "boolean",
        queued: "boolean",
      },
    });
    expect(JSON.parse(String(write.mock.calls[8]?.[0]))).toMatchObject({
      name: "telegram.delete",
      usage: "panda telegram delete <message-id> --chat <conversation-id> --connector <key>",
      resultShape: {
        deleted: "boolean",
        queued: "boolean",
      },
    });
    expect(JSON.parse(String(write.mock.calls[9]?.[0]))).toMatchObject({
      name: "telegram.pin",
      usage: "panda telegram pin <message-id> --chat <conversation-id> --connector <key> [--silent]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "silent",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        pinned: "boolean",
        queued: "boolean",
      },
    });
    expect(JSON.parse(String(write.mock.calls[10]?.[0]))).toMatchObject({
      name: "telegram.unpin",
      usage: "panda telegram unpin <message-id> --chat <conversation-id> --connector <key>",
      resultShape: {
        unpinned: "boolean",
        queued: "boolean",
      },
    });
    expect(JSON.parse(String(write.mock.calls[11]?.[0]))).toMatchObject({
      name: "discord.channel.list",
      usage: "panda discord channel list [--connector <key>]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "connector",
          valueName: "key",
        }),
      ]),
      resultShape: {
        count: "number",
        channels: ["object"],
      },
    });
    expect(JSON.parse(String(write.mock.calls[12]?.[0]))).toMatchObject({
      name: "discord.history",
      usage: "panda discord history --channel <channel-id> [--connector <key>] [--direction inbound|outbound|all] [--limit <n>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "channel",
          required: true,
        }),
        expect.objectContaining({
          name: "direction",
          enumValues: ["inbound", "outbound", "all"],
        }),
      ]),
      resultShape: {
        source: "durable_panda_records",
        items: ["object"],
      },
    });
    expect(JSON.parse(String(write.mock.calls[13]?.[0]))).toMatchObject({
      name: "discord.send",
      usage: "panda discord send --channel <channel-id> --connector <key> [--thread <thread-id>] [--guild <guild-id>] (--text <text|@file|@->|--stdin|--image <path>|--file <path>)... [--reply-to-message-id <message-id>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "channel",
          required: true,
        }),
        expect.objectContaining({
          name: "thread",
          valueName: "thread-id",
        }),
        expect.objectContaining({
          name: "stdin",
          valueType: "boolean",
        }),
        expect.objectContaining({
          name: "reply-to-message-id",
          valueName: "message-id",
        }),
      ]),
      resultShape: {
        deliveryId: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[14]?.[0]))).toMatchObject({
      name: "whatsapp.chat.list",
      usage: "panda whatsapp chat list [--connector <key>]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "connector",
          valueName: "key",
        }),
      ]),
      resultShape: {
        count: "number",
        chats: ["object"],
      },
    });
    expect(JSON.parse(String(write.mock.calls[15]?.[0]))).toMatchObject({
      name: "whatsapp.history",
      usage: "panda whatsapp history --chat <jid-or-phone> [--connector <key>] [--direction inbound|outbound|all] [--limit <n>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "chat",
          required: true,
        }),
        expect.objectContaining({
          name: "direction",
          enumValues: ["inbound", "outbound", "all"],
        }),
      ]),
      resultShape: {
        source: "durable_panda_records",
        items: ["object"],
      },
    });
    expect(JSON.parse(String(write.mock.calls[16]?.[0]))).toMatchObject({
      name: "whatsapp.send",
      usage: "panda whatsapp send --chat <jid-or-phone> --connector <key> (--text <text|@file|@->|--stdin|--image <path>|--file <path>)...",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "chat",
          required: true,
        }),
        expect.objectContaining({
          name: "stdin",
          valueType: "boolean",
        }),
        expect.objectContaining({
          name: "image",
          valueName: "path",
        }),
      ]),
      resultShape: {
        deliveryId: "string",
      },
    });
  });

  it("prints descriptor-backed JSON help for wiki commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["wiki", "read", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "search", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "diff", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "write", "page", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "write", "section", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "move", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "archive", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "restore", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "attach", "image", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "fetch", "asset", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["wiki", "delete", "asset", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "wiki.read",
      usage: "panda wiki read <path> [--locale <locale>] [--format json|markdown]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: [
        {
          name: "path",
          kind: "positional",
          valueName: "path",
          required: true,
        },
        {
          name: "locale",
          valueName: "locale",
        },
        {
          name: "format",
          valueName: "json|markdown",
        },
        {
          name: "json",
          required: false,
        },
      ],
      resultShape: {
        found: "boolean",
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "wiki.search",
      usage: "panda wiki search <query> [--path <path>] [--locale <locale>] [--limit <n>]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: [
        {
          name: "query",
          kind: "positional",
          valueName: "query",
          required: true,
        },
        {
          name: "path",
          valueName: "path",
        },
        {
          name: "locale",
          valueName: "locale",
        },
        {
          name: "limit",
          valueName: "n",
        },
        {
          name: "json",
          required: false,
        },
      ],
      resultShape: {
        totalHits: "number",
        count: "number",
        truncated: "boolean",
      },
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "wiki.list",
      usage: "panda wiki list [path] [--limit <n>] [--include-archived] [--locale <locale>]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: [
        {
          name: "path",
          kind: "positional",
          valueName: "path",
          required: false,
        },
        {
          name: "limit",
          valueName: "n",
        },
        {
          name: "include-archived",
          valueType: "boolean",
        },
        {
          name: "locale",
          valueName: "locale",
        },
        {
          name: "json",
          required: false,
        },
      ],
      resultShape: {
        pages: ["object"],
      },
    });
    const wikiDiff = JSON.parse(String(write.mock.calls[3]?.[0]));
    expect(wikiDiff).toMatchObject({
      name: "wiki.diff",
      usage: "panda wiki diff <left-path> <right-path> [--locale <locale>] [--context <n>]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        equal: "boolean",
        hunks: ["object"],
        truncated: "boolean",
      },
    });
    expect(wikiDiff.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "left-path",
        kind: "positional",
        valueName: "left-path",
        required: true,
      }),
      expect.objectContaining({
        name: "right-path",
        kind: "positional",
        valueName: "right-path",
        required: true,
      }),
      expect.objectContaining({
        name: "context",
        valueName: "n",
      }),
    ]));
    const wikiWrite = JSON.parse(String(write.mock.calls[4]?.[0]));
    expect(wikiWrite).toMatchObject({
      name: "wiki.write",
      usage: "panda wiki write page <path> --content <text|@file|@-> [--title <text|@file|@->] [--description <text|@file|@->] [--tag <tag>...] [--published|--draft] [--private|--public] [--create|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        action: "created|updated",
      },
    });
    expect(wikiWrite.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "path",
        kind: "positional",
        valueName: "path",
        required: true,
      }),
      expect.objectContaining({
        name: "content",
        valueName: "text|@file|@-",
        required: true,
      }),
      expect.objectContaining({
        name: "title",
        valueName: "text|@file|@-",
      }),
      expect.objectContaining({
        name: "description",
        valueName: "text|@file|@-",
      }),
    ]));
    const wikiWriteSection = JSON.parse(String(write.mock.calls[5]?.[0]));
    expect(wikiWriteSection).toMatchObject({
      name: "wiki.write.section",
      usage: "panda wiki write section <path> <section> --content <text|@file|@-> [--title <text|@file|@->] [--create|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        section: {
          title: "string",
        },
      },
    });
    expect(wikiWriteSection.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "path",
        kind: "positional",
        valueName: "path",
        required: true,
      }),
      expect.objectContaining({
        name: "section",
        kind: "positional",
        valueName: "section",
        required: true,
      }),
      expect.objectContaining({
        name: "content",
        valueName: "text|@file|@-",
        required: true,
      }),
      expect.objectContaining({
        name: "title",
        valueName: "text|@file|@-",
      }),
    ]));
    const wikiMove = JSON.parse(String(write.mock.calls[6]?.[0]));
    expect(wikiMove).toMatchObject({
      name: "wiki.move",
      usage: "panda wiki move <path> <destination-path> [--rewrite-links] [--locale <locale>] [--base-updated-at <timestamp>]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        movedTo: "string",
      },
    });
    expect(wikiMove.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "path",
        kind: "positional",
        valueName: "path",
        required: true,
      }),
      expect.objectContaining({
        name: "destination-path",
        kind: "positional",
        valueName: "destination-path",
        required: true,
      }),
      expect.objectContaining({
        name: "rewrite-links",
        valueType: "boolean",
      }),
    ]));
    const wikiArchive = JSON.parse(String(write.mock.calls[7]?.[0]));
    expect(wikiArchive).toMatchObject({
      name: "wiki.archive",
      usage: "panda wiki archive <path> [--locale <locale>] [--base-updated-at <timestamp>]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        archivedTo: "string",
      },
    });
    expect(wikiArchive.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "path",
        kind: "positional",
        valueName: "path",
        required: true,
      }),
      expect.objectContaining({
        name: "base-updated-at",
        valueName: "timestamp",
      }),
    ]));
    const wikiRestore = JSON.parse(String(write.mock.calls[8]?.[0]));
    expect(wikiRestore).toMatchObject({
      name: "wiki.restore",
      usage: "panda wiki restore <archived-path> <destination-path> [--locale <locale>] [--base-updated-at <timestamp>]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        restoredTo: "string",
      },
    });
    expect(wikiRestore.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "archived-path",
        kind: "positional",
        valueName: "archived-path",
        required: true,
      }),
      expect.objectContaining({
        name: "destination-path",
        kind: "positional",
        valueName: "destination-path",
        required: true,
      }),
      expect.objectContaining({
        name: "base-updated-at",
        valueName: "timestamp",
      }),
    ]));
    expect(JSON.parse(String(write.mock.calls[9]?.[0]))).toMatchObject({
      name: "wiki.attach.image",
      usage: "panda wiki attach image <path> <section> --slot <slot> --source <image-path> --alt <text|@file|@-> [--caption <text|@file|@->] [--title <text|@file|@->] [--create|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        assetPath: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[9]?.[0]))).toMatchObject({
      arguments: expect.arrayContaining([
        expect.objectContaining({name: "path", kind: "positional"}),
        expect.objectContaining({name: "section", kind: "positional"}),
        expect.objectContaining({name: "slot", required: true}),
        expect.objectContaining({name: "source", required: true, valueName: "image-path"}),
        expect.objectContaining({name: "alt", required: true, valueName: "text|@file|@-"}),
        expect.objectContaining({name: "title", valueName: "text|@file|@-"}),
      ]),
    });
    expect(JSON.parse(String(write.mock.calls[10]?.[0]))).toMatchObject({
      name: "wiki.fetch.asset",
      usage: "panda wiki fetch asset <asset-path>",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        localPath: "string",
        artifact: {
          source: "view_media",
        },
      },
    });
    expect(JSON.parse(String(write.mock.calls[10]?.[0])).arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "asset-path",
        kind: "positional",
        valueName: "asset-path",
        required: true,
      }),
    ]));
    expect(JSON.parse(String(write.mock.calls[11]?.[0]))).toMatchObject({
      name: "wiki.delete.asset",
      usage: "panda wiki delete asset <asset-path> --yes",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        deleted: true,
      },
    });
    expect(JSON.parse(String(write.mock.calls[11]?.[0])).arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "asset-path",
        kind: "positional",
        valueName: "asset-path",
        required: true,
      }),
      expect.objectContaining({
        name: "yes",
        valueType: "boolean",
      }),
    ]));
  });

  it("prints descriptor-backed JSON help for todo commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["todo", "add", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["todo", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["todo", "show", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["todo", "done", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["todo", "block", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["todo", "clear", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "todo.add",
      usage: "panda todo add <text|@file|@-> [--status pending|in_progress|blocked]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "content",
          kind: "positional",
          valueName: "text|@file|@-",
        }),
      ]),
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "todo.list",
      usage: "panda todo list [--status all|open|pending|in_progress|blocked|done]",
      inputModes: ["flags", "json"],
      resultShape: {
        operation: "list",
        items: [{
          index: "number",
          status: "pending|in_progress|blocked|done",
          content: "string",
        }],
      },
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "todo.show",
      usage: "panda todo show <index>",
      inputModes: ["flags", "json"],
    });
    expect(JSON.parse(String(write.mock.calls[3]?.[0]))).toMatchObject({
      name: "todo.done",
      usage: "panda todo done <index>",
      inputModes: ["flags", "json"],
    });
    expect(JSON.parse(String(write.mock.calls[4]?.[0]))).toMatchObject({
      name: "todo.block",
      usage: "panda todo block <index>",
      inputModes: ["flags", "json"],
    });
    expect(JSON.parse(String(write.mock.calls[5]?.[0]))).toMatchObject({
      name: "todo.clear",
      usage: "panda todo clear",
      resultShape: {
        cleared: true,
        itemCount: 0,
      },
    });
    expect(todoClearCommandDescriptor.arguments).toEqual([]);
  });

  it("includes descriptor-backed JSON help for session prompt commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["commands", "--output", "json"], {from: "user"});

    const payload = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(payload.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "session.prompt.read",
        usage: "panda session prompt current read <brief|memory|heartbeat> [--raw]",
        resultShape: expect.objectContaining({
          content: "string",
        }),
      }),
      expect.objectContaining({
        name: "session.prompt.set",
        usage: "panda session prompt current set <brief|memory|heartbeat> --content <text|@file|@->",
      }),
      expect.objectContaining({
        name: "session.prompt.transform",
        usage: "panda session prompt current transform <brief|memory|heartbeat> (--append <text|@file|@->|--prepend <text|@file|@->|--replace <pattern> --with <text|@file|@->|--expression <expr|@file|@->)",
        inputModes: ["flags", "json", "stdin", "file"],
      }),
    ]));

    const transformCommand = payload.commands.find((command: {name: string}) => command.name === "session.prompt.transform");
    expect(transformCommand).toMatchObject({
      name: "session.prompt.transform",
      usage: "panda session prompt current transform <brief|memory|heartbeat> (--append <text|@file|@->|--prepend <text|@file|@->|--replace <pattern> --with <text|@file|@->|--expression <expr|@file|@->)",
      arguments: expect.arrayContaining([
        expect.objectContaining({name: "slug", kind: "positional"}),
        expect.objectContaining({name: "append", valueName: "text|@file|@-"}),
        expect.objectContaining({name: "prepend", valueName: "text|@file|@-"}),
        expect.objectContaining({name: "replace", valueName: "pattern"}),
        expect.objectContaining({name: "with", valueName: "text|@file|@-"}),
        expect.objectContaining({name: "expression", valueName: "expr|@file|@-"}),
        expect.objectContaining({
          name: "json",
          description: expect.stringContaining("operation:'replace'"),
        }),
      ]),
      resultShape: expect.objectContaining({
        transformOperation: "append|prepend|replace|expression",
        changed: "boolean",
        matchCount: "number (replace only)",
      }),
    });
  });

  it("exposes current-session prompt command help without colliding with operator prompt commands", async () => {
    const program = new Command();
    registerSessionCommands(program);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["session", "prompt", "current", "read", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "session.prompt.read",
      usage: "panda session prompt current read <brief|memory|heartbeat> [--raw]",
    });
  });

  it("includes descriptor-backed JSON help for skill commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["commands", "--output", "json"], {from: "user"});
    await createProgram().parseAsync(["skill", "list", "--help", "--json"], {from: "user"});

    const payload = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(payload.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "skill.list",
        usage: "panda skill list [--tag <tag>...] [--output keys|json|table]",
        arguments: expect.arrayContaining([
          expect.objectContaining({
            name: "output",
            enumValues: ["keys", "json", "table"],
            defaultValue: "keys",
          }),
        ]),
      }),
      expect.objectContaining({
        name: "skill.show",
        usage: "panda skill show <skill-key>",
      }),
      expect.objectContaining({
        name: "skill.load",
        usage: "panda skill load <skill-key>",
      }),
      expect.objectContaining({
        name: "skill.set",
        usage: "panda skill set <skill-key> --description <text|@file|@-> --content <text|@file|@-> [--tag <tag>...]",
        resultShape: expect.objectContaining({
          contentBytes: "number",
        }),
      }),
      expect.objectContaining({
        name: "skill.patch",
        usage: "panda skill patch <skill-key> --description <text|@file|@->",
      }),
      expect.objectContaining({
        name: "skill.delete",
        usage: "panda skill delete <skill-key> --yes",
      }),
    ]));
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "skill.list",
      usage: "panda skill list [--tag <tag>...] [--output keys|json|table]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "output",
          enumValues: ["keys", "json", "table"],
          defaultValue: "keys",
        }),
      ]),
    });
  });

  it("includes descriptor-backed JSON help for readonly postgres query", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["commands", "--output", "json"], {from: "user"});

    const payload = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(payload.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "postgres.readonly.query",
        usage: "panda postgres readonly query (--sql <text|@file|@-> [--max-rows <n>]|--schema-help)",
        inputModes: ["flags", "json", "stdin", "file"],
        arguments: expect.arrayContaining([
          expect.objectContaining({
            name: "sql",
            valueName: "text|@file|@-",
          }),
          expect.objectContaining({
            name: "max-rows",
            valueName: "n",
            minimum: 1,
            maximum: 50,
          }),
          expect.objectContaining({
            name: "schema-help",
            valueType: "boolean",
          }),
        ]),
        resultShape: expect.objectContaining({
          operation: "query|schema_help",
          requestedMaxRows: "number|absent for schema_help",
          maxRowsCapped: "boolean|absent for schema_help",
          rows: ["object"],
        }),
      }),
    ]));
  });

  it("prints descriptor-backed JSON help for subagent commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["subagent", "spawn", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["subagent", "profile", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["subagent", "profile", "show", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["subagent", "profile", "upsert", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["subagent", "profile", "enable", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["subagent", "profile", "disable", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "subagent.spawn",
      usage: "panda subagent spawn (<task|@file|@->|--prompt <text|@file|@->) [--profile <slug>|--tool-group <group>...] [--context <text|@file|@->] [(--environment <environment-id> [--isolated]|--agent-workspace)] [--credential <env-key>...]",
      inputModes: ["flags", "json", "stdin", "file"],
      resultShape: {
        sessionId: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "subagent.profile.list",
      usage: "panda subagent profile list [--include-disabled]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "include-disabled",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        count: "number",
      },
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "subagent.profile.show",
      usage: "panda subagent profile show <slug> [--include-disabled]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "slug",
          kind: "positional",
          required: true,
        }),
      ]),
      resultShape: {
        prompt: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[3]?.[0]))).toMatchObject({
      name: "subagent.profile.upsert",
      usage: "panda subagent profile upsert <slug> --description <text|@file|@-> --prompt <text|@file|@-> --tool-group <group>... [--model <model>] [--thinking low|medium|high|xhigh] [--enabled|--disabled]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "slug",
          kind: "positional",
          required: true,
        }),
        expect.objectContaining({
          name: "description",
          valueName: "text|@file|@-",
          required: true,
        }),
        expect.objectContaining({
          name: "prompt",
          valueName: "text|@file|@-",
          required: true,
        }),
        expect.objectContaining({
          name: "tool-group",
          valueName: "group",
          required: true,
        }),
      ]),
      resultShape: {
        slug: "string",
      },
    });
    expect(JSON.parse(String(write.mock.calls[4]?.[0]))).toMatchObject({
      name: "subagent.profile.enable",
      usage: "panda subagent profile enable <slug>",
      resultShape: {
        enabled: true,
      },
    });
    expect(JSON.parse(String(write.mock.calls[5]?.[0]))).toMatchObject({
      name: "subagent.profile.disable",
      usage: "panda subagent profile disable <slug>",
      resultShape: {
        enabled: false,
      },
    });
  });

  it("prints descriptor-backed JSON help for a2a send", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["a2a", "send", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "a2a.send",
      usage: "panda a2a send (--to-session <session-id>|--to-agent <agent-key>) (--text <text|@file|@->|--stdin|--file <path>)...",
      arguments: [
        {
          name: "to-session",
          valueName: "session-id",
          conflictsWith: ["to-agent"],
        },
        {
          name: "to-agent",
          valueName: "agent-key",
          conflictsWith: ["to-session"],
        },
        {
          name: "text",
          valueName: "text|@file|@-",
          valueSources: ["literal", "file", "stdin"],
          repeatable: true,
        },
        {
          name: "stdin",
          valueType: "boolean",
        },
        {
          name: "file",
          valueName: "path",
          repeatable: true,
        },
        {
          name: "json",
          required: false,
        },
      ],
      resultShape: {
        deliveryId: "string",
        status: "queued",
      },
    });
  });

  it("prints descriptor-backed JSON help for a2a inspect and history", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["a2a", "inspect", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["a2a", "history", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "a2a.inspect",
      usage: "panda a2a inspect <delivery-id>",
      arguments: [
        {
          name: "delivery-id",
          required: true,
        },
        {
          name: "json",
        },
      ],
      resultShape: {
        deliveryId: "string",
        direction: "inbound|outbound",
        status: "pending|sending|sent|failed",
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "a2a.history",
      usage: "panda a2a history [--peer-session <session-id>] [--direction inbound|outbound|all] [--limit <n>]",
      arguments: [
        {
          name: "peer-session",
          valueName: "session-id",
        },
        {
          name: "direction",
          enumValues: ["inbound", "outbound", "all"],
          defaultValue: "all",
        },
        {
          name: "limit",
          valueType: "number",
          defaultValue: 10,
        },
        {
          name: "json",
        },
      ],
      resultShape: {
        count: "number",
      },
    });
  });

  it("prints descriptor-backed JSON help for email send", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["email", "send", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "email.send",
      usage: "panda email send --account <key> (--to <address>... --subject <text|@file|@->|--reply-to-email-id <email-id> [--reply-mode sender|all]) --text <text|@file|@-> [--html <text|@file|@->] [--cc <address>...] [--file <path>...]",
      inputModes: ["flags", "json", "stdin", "file"],
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "account",
          valueName: "key",
          required: true,
        }),
        expect.objectContaining({
          name: "to",
          valueName: "address",
          repeatable: true,
          conflictsWith: ["reply-to-email-id"],
        }),
        expect.objectContaining({
          name: "subject",
          valueName: "text|@file|@-",
          valueSources: ["literal", "file", "stdin"],
          conflictsWith: ["reply-to-email-id"],
        }),
        expect.objectContaining({
          name: "text",
          valueName: "text|@file|@-",
          valueSources: ["literal", "file", "stdin"],
          required: true,
        }),
        expect.objectContaining({
          name: "file",
          valueName: "path",
          repeatable: true,
        }),
        expect.objectContaining({
          name: "reply-mode",
          requires: ["reply-to-email-id"],
        }),
      ]),
      resultShape: {
        deliveryId: "string",
        channel: "email",
      },
    });
  });

  it("prints descriptor-backed JSON help for email account/list/read/search/attachments fetch", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["email", "account", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["email", "list", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["email", "read", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["email", "search", "--help", "--json"], {from: "user"});
    await createProgram().parseAsync(["email", "attachments", "fetch", "--help", "--json"], {from: "user"});

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      name: "email.account.list",
      usage: "panda email account list [--sendable-only]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "sendable-only",
          valueType: "boolean",
        }),
      ]),
      resultShape: {
        count: "number",
      },
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({
      name: "email.list",
      usage: "panda email list [--account <key>] [--mailbox <name>] [--direction inbound|outbound] [--limit <n>]",
      resultShape: {
        count: "number",
      },
    });
    expect(JSON.parse(String(write.mock.calls[2]?.[0]))).toMatchObject({
      name: "email.read",
      usage: "panda email read <email-id>",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "email-id",
          required: true,
          kind: "positional",
        }),
      ]),
    });
    expect(JSON.parse(String(write.mock.calls[3]?.[0]))).toMatchObject({
      name: "email.search",
      usage: "panda email search <query> [--account <key>] [--mailbox <name>] [--direction inbound|outbound] [--limit <n>]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "query",
          required: true,
          kind: "positional",
        }),
      ]),
    });
    expect(JSON.parse(String(write.mock.calls[4]?.[0]))).toMatchObject({
      name: "email.attachments.fetch",
      usage: "panda email attachments fetch <attachment-id> [--save <path>] [--overwrite]",
      arguments: expect.arrayContaining([
        expect.objectContaining({
          name: "attachment-id",
          required: true,
          kind: "positional",
        }),
        expect.objectContaining({
          name: "save",
          valueName: "path",
        }),
      ]),
    });
  });
});
