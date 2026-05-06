import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_PROMPT_TEMPLATES,} from "../src/domain/agents/index.js";
import {PostgresTelepathyDeviceStore} from "../src/domain/telepathy/index.js";
import {ensureReadonlySessionQuerySchema} from "../src/domain/threads/runtime/index.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/index.js";
import {PostgresWatchStore} from "../src/domain/watches/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

class RecordingQueryable {
  readonly queries: string[] = [];

  async query(text: string): Promise<{ rows: never[] }> {
    this.queries.push(text);
    return { rows: [] };
  }
}

class PgMemReadonlySchemaQueryable {
  constructor(
    private readonly pool: { query(text: string): Promise<{ rows: unknown[] }> },
  ) {}

  async query(text: string): Promise<{ rows: unknown[] }> {
    const statements = text
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      if (/^DROP VIEW IF EXISTS\b/i.test(statement)) {
        continue;
      }

      if (/^CREATE VIEW "session"."threads"/i.test(statement)) {
        const whereMatches = [...statement.matchAll(/\bWHERE\b/gi)];
        const whereIndex = whereMatches.at(-1)?.index;
        const whereClause = whereIndex === undefined
          ? undefined
          : statement.slice(whereIndex + "WHERE".length).trim();
        if (!whereClause) {
          throw new Error("Expected session.threads view SQL to contain a WHERE clause.");
        }

        await this.pool.query(`
          CREATE VIEW "session"."threads" AS
          SELECT
            t.id,
            t.session_id,
            session.agent_key
          FROM "runtime"."threads" AS t
          INNER JOIN "runtime"."agent_sessions" AS session
            ON session.id = t.session_id
          WHERE ${whereClause}
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."(messages_raw|messages|tool_results|inputs|runs)"/i.test(statement)) {
        continue;
      }

      if (/^CREATE VIEW "session"."scheduled_tasks"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."scheduled_tasks" AS
          SELECT
            scheduled_tasks.id,
            scheduled_tasks.session_id,
            scheduled_tasks.created_by_identity_id,
            session.current_thread_id AS resolved_thread_id
          FROM "runtime"."scheduled_tasks" AS scheduled_tasks
          INNER JOIN "runtime"."agent_sessions" AS session
            ON session.id = scheduled_tasks.session_id
          WHERE scheduled_tasks.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."scheduled_task_runs"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."scheduled_task_runs" AS
          SELECT
            scheduled_task_runs.id,
            scheduled_task_runs.task_id,
            scheduled_task_runs.session_id
          FROM "runtime"."scheduled_task_runs" AS scheduled_task_runs
          WHERE scheduled_task_runs.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."watches"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."watches" AS
          SELECT
            watch.id,
            watch.session_id,
            watch.created_by_identity_id,
            session.current_thread_id AS resolved_thread_id
          FROM "runtime"."watches" AS watch
          INNER JOIN "runtime"."agent_sessions" AS session
            ON session.id = watch.session_id
          WHERE watch.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."watch_runs"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."watch_runs" AS
          SELECT
            watch_runs.id,
            watch_runs.watch_id,
            watch_runs.session_id
          FROM "runtime"."watch_runs" AS watch_runs
          WHERE watch_runs.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."watch_events"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."watch_events" AS
          SELECT
            watch_events.id,
            watch_events.watch_id,
            watch_events.session_id
          FROM "runtime"."watch_events" AS watch_events
          WHERE watch_events.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      const sanitized = statement.replace(
        /\bWITH\s*\(security_barrier\s*=\s*true\)\s+AS\b/gi,
        "AS",
      );
      await this.pool.query(sanitized);
    }

    return { rows: [] };
  }
}

function createScopedPool() {
  const db = newDb();
  const scope = new Map<string, string | null>();

  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  db.public.registerFunction({
    name: "current_setting",
    args: [DataType.text, DataType.bool],
    returns: DataType.text,
    implementation: (key: string) => scope.get(key) ?? null,
  });
  db.public.registerFunction({
    name: "convert_to",
    args: [DataType.text, DataType.text],
    returns: DataType.bytea,
    implementation: (value: string, encoding: string) => Buffer.from(value, encoding),
  });
  db.public.registerFunction({
    name: "octet_length",
    args: [DataType.bytea],
    returns: DataType.integer,
    implementation: (value: Buffer) => value.length,
  });

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  return {
    pool,
    setScope(next: { sessionId?: string | null; agentKey?: string | null }) {
      scope.set("runtime.session_id", next.sessionId ?? null);
      scope.set("runtime.agent_key", next.agentKey ?? null);
    },
  };
}

describe("ensureReadonlySessionQuerySchema", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("creates split session views and grants access to them", async () => {
    const queryable = new RecordingQueryable();

    const views = await ensureReadonlySessionQuerySchema({
      queryable,
      readonlyRole: "readonly_user",
    });

    expect(views).toEqual({
      agentSessions: "\"session\".\"agent_sessions\"",
      threads: "\"session\".\"threads\"",
      messages: "\"session\".\"messages\"",
      messagesRaw: "\"session\".\"messages_raw\"",
      toolResults: "\"session\".\"tool_results\"",
      inputs: "\"session\".\"inputs\"",
      runs: "\"session\".\"runs\"",
      agentPrompts: "\"session\".\"agent_prompts\"",
      sidecars: "\"session\".\"sidecars\"",
      agentPairings: "\"session\".\"agent_pairings\"",
      agentSkills: "\"session\".\"agent_skills\"",
      agentTelepathyDevices: "\"session\".\"agent_telepathy_devices\"",
      scheduledTasks: "\"session\".\"scheduled_tasks\"",
      scheduledTaskRuns: "\"session\".\"scheduled_task_runs\"",
      watches: "\"session\".\"watches\"",
      watchRuns: "\"session\".\"watch_runs\"",
      watchEvents: "\"session\".\"watch_events\"",
      emailAccounts: "\"session\".\"email_accounts\"",
      emailAllowedRecipients: "\"session\".\"email_allowed_recipients\"",
      emailMessages: "\"session\".\"email_messages\"",
      emailMessageRecipients: "\"session\".\"email_message_recipients\"",
      emailAttachments: "\"session\".\"email_attachments\"",
    });

    expect(queryable.queries).toHaveLength(2);
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_sessions\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"messages_raw\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"messages\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"tool_results\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_prompts\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"sidecars\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_pairings\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_skills\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_telepathy_devices\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"scheduled_tasks\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"scheduled_task_runs\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"watches\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"watch_runs\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"watch_events\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"email_accounts\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"email_messages\"");
    expect(queryable.queries[0]).toContain("FROM \"session\".\"messages_raw\" AS raw");
    expect(queryable.queries[0]).toContain("WHERE raw.role IN ('user', 'assistant')");
    expect(queryable.queries[0]).toContain("t.inference_projection");
    expect(queryable.queries[0]).toContain("t.session_id = current_setting('runtime.session_id', true)");
    expect(queryable.queries[0]).toContain("prompt.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[0]).toContain("sidecar.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[0]).toContain("pairing.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[0]).toContain("skill.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[0]).toContain("device.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[1]).toContain("GRANT SELECT ON \"session\".\"agent_sessions\", \"session\".\"threads\", \"session\".\"messages\", \"session\".\"messages_raw\", \"session\".\"tool_results\", \"session\".\"inputs\", \"session\".\"runs\", \"session\".\"agent_prompts\", \"session\".\"sidecars\", \"session\".\"agent_pairings\", \"session\".\"agent_skills\", \"session\".\"agent_telepathy_devices\", \"session\".\"scheduled_tasks\", \"session\".\"scheduled_task_runs\", \"session\".\"watches\", \"session\".\"watch_runs\", \"session\".\"watch_events\"");
  });

  it("filters readonly threads by session when multiple identities share an agent", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore, identityStore, sessionStore, threadStore: store} = await createRuntimeStores(pool);
    await new PostgresTelepathyDeviceStore({ pool }).ensureSchema();
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();

    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    const bob = await identityStore.createIdentity({
      id: "bob-id",
      handle: "bob",
      displayName: "Bob",
    });

    await sessionStore.createSession({
      id: "alice-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "alice-thread",
      createdByIdentityId: alice.id,
    });
    await sessionStore.createSession({
      id: "bob-session",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "bob-thread",
      createdByIdentityId: bob.id,
    });
    await store.createThread({
      id: "alice-thread",
      sessionId: "alice-session",
    });
    await store.createThread({
      id: "bob-thread",
      sessionId: "bob-session",
    });

    setScope({
      sessionId: "alice-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT id, session_id, agent_key FROM \"session\".\"threads\" ORDER BY id",
    );

    expect(result.rows).toEqual([
      {
        id: "alice-thread",
        session_id: "alice-session",
        agent_key: "panda",
      },
    ]);
  });

  it("filters readonly threads by agent when one identity has multiple agents", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore, identityStore, sessionStore, threadStore: store} = await createRuntimeStores(pool);
    await new PostgresTelepathyDeviceStore({ pool }).ensureSchema();
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();

    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });

    await sessionStore.createSession({
      id: "panda-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "alice-panda-thread",
      createdByIdentityId: alice.id,
    });
    await sessionStore.createSession({
      id: "ops-session",
      agentKey: "ops",
      kind: "main",
      currentThreadId: "alice-ops-thread",
      createdByIdentityId: alice.id,
    });
    await store.createThread({
      id: "alice-panda-thread",
      sessionId: "panda-session",
    });
    await store.createThread({
      id: "alice-ops-thread",
      sessionId: "ops-session",
    });

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT id, session_id, agent_key FROM \"session\".\"threads\" ORDER BY id",
    );

    expect(result.rows).toEqual([
      {
        id: "alice-panda-thread",
        session_id: "panda-session",
        agent_key: "panda",
      },
    ]);
  });

  it("filters readonly agent skills by agent key", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore} = await createRuntimeStores(pool);
    await new PostgresTelepathyDeviceStore({ pool }).ensureSchema();
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await agentStore.setAgentSkill("panda", "calendar", "Panda calendar skill.", "# Panda");
    await agentStore.loadAgentSkill("panda", "calendar");
    await agentStore.setAgentSkill("ops", "calendar", "Ops calendar skill.", "# Ops");

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT skill_key, description, content_bytes, load_count, last_loaded_at IS NOT NULL AS has_last_loaded_at FROM \"session\".\"agent_skills\" ORDER BY skill_key",
    );

    expect(result.rows).toEqual([
      {
        skill_key: "calendar",
        description: "Panda calendar skill.",
        content_bytes: 7,
        load_count: 1,
        has_last_loaded_at: true,
      },
    ]);
  });

  it("filters readonly agent prompts by agent key", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore} = await createRuntimeStores(pool);
    await new PostgresTelepathyDeviceStore({ pool }).ensureSchema();
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await pool.query(`
      INSERT INTO "runtime"."agent_prompts" (agent_key, slug, content)
      VALUES ('panda', 'soul', 'Old soul prompt.')
    `);
    await agentStore.setAgentPrompt("panda", "heartbeat", "Panda heartbeat prompt.");
    await agentStore.setAgentPrompt("ops", "heartbeat", "Ops heartbeat prompt.");

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT slug, content_bytes FROM \"session\".\"agent_prompts\" WHERE slug = 'heartbeat'",
    );

    expect(result.rows).toEqual([
      {
        slug: "heartbeat",
        content_bytes: 23,
      },
    ]);

    const visibleSlugs = await pool.query(
      "SELECT slug FROM \"session\".\"agent_prompts\" ORDER BY slug",
    );
    expect(visibleSlugs.rows).toEqual([
      {slug: "agent"},
      {slug: "heartbeat"},
    ]);
  });

  it("filters readonly agent pairings by agent key", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore, identityStore} = await createRuntimeStores(pool);
    await new PostgresTelepathyDeviceStore({ pool }).ensureSchema();
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    const bob = await identityStore.createIdentity({
      id: "bob-id",
      handle: "bob",
      displayName: "Bob",
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await agentStore.ensurePairing("panda", alice.id);
    await agentStore.ensurePairing("ops", bob.id);

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT identity_handle FROM \"session\".\"agent_pairings\" ORDER BY identity_handle",
    );

    expect(result.rows).toEqual([
      {
        identity_handle: "alice",
      },
    ]);
  });

  it("exposes readonly email history by agent key", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore, emailStore} = await createRuntimeStores(pool);
    await new PostgresTelepathyDeviceStore({ pool }).ensureSchema();
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });

    const endpoint = {
      host: "mail.example.com",
      usernameCredentialEnvKey: "MAIL_USER",
      passwordCredentialEnvKey: "MAIL_PASS",
    };
    await emailStore.upsertAccount({
      agentKey: "panda",
      accountKey: "work",
      fromAddress: "panda@example.com",
      imap: endpoint,
      smtp: endpoint,
    });
    await emailStore.upsertAccount({
      agentKey: "ops",
      accountKey: "work",
      fromAddress: "ops@example.com",
      imap: endpoint,
      smtp: endpoint,
    });
    await emailStore.addAllowedRecipient("panda", "work", "alice@example.com");

    const visibleMessage = await emailStore.recordMessage({
      agentKey: "panda",
      accountKey: "work",
      direction: "inbound",
      mailbox: "INBOX",
      uid: 1,
      uidValidity: "uidv",
      subject: "Visible",
      fromAddress: "alice@example.com",
      bodyText: "Hello Panda",
      authenticationResults: "mx.example; spf=fail smtp.mailfrom=bad.example; dmarc=fail",
      authSpf: "fail",
      authDmarc: "fail",
      recipients: [
        {role: "from", address: "alice@example.com"},
        {role: "to", address: "panda@example.com"},
      ],
      attachments: [
        {
          filename: "brief.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
        },
      ],
    });
    await emailStore.recordMessage({
      agentKey: "ops",
      accountKey: "work",
      direction: "inbound",
      mailbox: "INBOX",
      uid: 2,
      uidValidity: "uidv",
      subject: "Hidden",
      fromAddress: "alice@example.com",
    });

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    await ensureReadonlySessionQuerySchema({
      queryable: new PgMemReadonlySchemaQueryable(pool),
    });

    const accountsResult = await pool.query(
      "SELECT account_key, from_address FROM \"session\".\"email_accounts\" ORDER BY account_key",
    );
    expect(accountsResult.rows).toEqual([
      {
        account_key: "work",
        from_address: "panda@example.com",
      },
    ]);

    const messagesResult = await pool.query(
      "SELECT id, account_key, subject, body_text, auth_spf, auth_dmarc, auth_summary FROM \"session\".\"email_messages\" ORDER BY subject",
    );
    expect(messagesResult.rows).toEqual([
      {
        id: visibleMessage.message.id,
        account_key: "work",
        subject: "Visible",
        body_text: "=====EXTERNAL CONTENT=====\nHello Panda\n=====EXTERNAL CONTENT=====",
        auth_spf: "fail",
        auth_dmarc: "fail",
        auth_summary: "suspicious",
      },
    ]);

    const recipientsResult = await pool.query(
      "SELECT role, address FROM \"session\".\"email_message_recipients\" ORDER BY role",
    );
    expect(recipientsResult.rows).toEqual([
      {
        role: "from",
        address: "alice@example.com",
      },
      {
        role: "to",
        address: "panda@example.com",
      },
    ]);

    const attachmentsResult = await pool.query(
      "SELECT filename, mime_type, size_bytes FROM \"session\".\"email_attachments\"",
    );
    expect(attachmentsResult.rows).toEqual([
      {
        filename: "brief.txt",
        mime_type: "text/plain",
        size_bytes: 42,
      },
    ]);
  });
});
