import {randomUUID} from "node:crypto";

import {Pool, type PoolClient} from "pg";
import {describe, expect, it} from "vitest";

import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {
  StaleThreadCompactionError,
  ThreadRunClaimLostError,
} from "../../src/domain/threads/runtime/store.js";
import {stringToUserMessage} from "../../src/kernel/agent/helpers/input.js";
import {createCompactBoundaryMessage} from "../../src/kernel/transcript/compaction.js";
import type {PgPoolLike, PgQueryResult, PgQueryable} from "../../src/lib/postgres-query.js";
import {quoteIdentifier} from "../../src/lib/postgres-relations.js";

class SchemaScopedClient implements PgQueryable {
  constructor(
    private readonly client: PoolClient,
    private readonly runtimeSchema: string,
    private readonly afterQuery?: (sql: string) => Promise<void>,
  ) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    const result = await this.client.query(this.scope(sql), [...params]);
    await this.afterQuery?.(sql);
    return {rows: result.rows, rowCount: result.rowCount};
  }

  release(): void {
    this.client.release();
  }

  private scope(sql: string): string {
    return sql.replaceAll('"runtime".', `${quoteIdentifier(this.runtimeSchema)}.`);
  }
}

class SchemaScopedPool implements PgPoolLike {
  readonly queries: Array<{sql: string; params: readonly unknown[]}> = [];
  afterClientQuery?: (sql: string) => Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly runtimeSchema: string,
  ) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    this.queries.push({sql, params});
    const result = await this.pool.query(this.scopeSql(sql), [...params]);
    return {rows: result.rows, rowCount: result.rowCount};
  }

  async connect(): Promise<SchemaScopedClient> {
    return new SchemaScopedClient(
      await this.pool.connect(),
      this.runtimeSchema,
      async (sql) => this.afterClientQuery?.(sql),
    );
  }

  scopeSql(sql: string): string {
    return sql.replaceAll('"runtime".', `${quoteIdentifier(this.runtimeSchema)}.`);
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const postgresIt = databaseUrl ? it : it.skip;

function compactMetadata(compactedThroughSequence: number) {
  return {
    kind: "compact_boundary" as const,
    compactedThroughSequence,
    preservedTailUserTurns: 3,
    trigger: "manual" as const,
    tokensBefore: 1_000,
    tokensAfter: 300,
  };
}

describe("Postgres transcript checkpoints", () => {
  it("requires TEST_DATABASE_URL for the PostgreSQL contract check", () => {
    expect(databaseUrl).toMatch(/^postgres(?:ql)?:\/\//);
  });

  postgresIt("atomically replaces active checkpoints and pages complete history", async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: "panda/test-transcript-checkpoints",
      max: 2,
    });
    const schema = `transcript_checkpoint_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = quoteIdentifier(schema);
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      schemaCreated = true;
      await pool.query(`
        CREATE TABLE ${quotedSchema}.threads (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          runtime_state JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE ${quotedSchema}.messages (
          id UUID PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES ${quotedSchema}.threads(id) ON DELETE CASCADE,
          sequence BIGSERIAL NOT NULL,
          origin TEXT NOT NULL,
          source TEXT NOT NULL,
          channel_id TEXT,
          external_message_id TEXT,
          actor_id TEXT,
          identity_id TEXT,
          run_id UUID,
          run_thread_id TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          metadata JSONB,
          message JSONB NOT NULL,
          compacted_through_sequence BIGINT,
          CONSTRAINT messages_compact_checkpoint_check CHECK (
            (
              compacted_through_sequence IS NULL
              AND COALESCE(metadata ->> 'kind', '') <> 'compact_boundary'
            ) OR (
              compacted_through_sequence IS NOT NULL
              AND compacted_through_sequence >= 0
              AND compacted_through_sequence < sequence
              AND origin = 'runtime'
              AND source = 'compact'
              AND COALESCE(metadata ->> 'kind', '') = 'compact_boundary'
              AND (metadata -> 'compactedThroughSequence') IS NULL
              AND (metadata -> 'compactedUpToSequence') IS NULL
              AND COALESCE(metadata ->> 'trigger', '') IN ('manual', 'auto')
              AND CASE
                WHEN (metadata -> 'preservedTailUserTurns')::text IS NULL THEN FALSE
                WHEN (metadata -> 'preservedTailUserTurns')::text LIKE '"%' THEN FALSE
                WHEN (metadata -> 'preservedTailUserTurns')::text IN ('true', 'false', 'null') THEN FALSE
                WHEN (metadata -> 'preservedTailUserTurns')::text LIKE '{%' THEN FALSE
                WHEN (metadata -> 'preservedTailUserTurns')::text LIKE '[%' THEN FALSE
                ELSE
                  (metadata ->> 'preservedTailUserTurns')::numeric BETWEEN 0 AND 9007199254740991
                  AND (metadata -> 'preservedTailUserTurns')::text NOT LIKE '%.%'
                  AND LOWER((metadata -> 'preservedTailUserTurns')::text) NOT LIKE '%e%'
              END
            )
          )
        );
        CREATE TABLE ${quotedSchema}.connector_leases (
          source TEXT NOT NULL,
          connector_key TEXT NOT NULL,
          holder_id TEXT NOT NULL,
          leased_until TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (source, connector_key)
        );
        CREATE TABLE ${quotedSchema}.runs (
          id UUID PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES ${quotedSchema}.threads(id) ON DELETE CASCADE,
          owner_source TEXT,
          owner_key TEXT,
          owner_holder_id TEXT,
          status TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          abort_requested_at TIMESTAMPTZ
        );
        CREATE INDEX messages_thread_sequence_idx
          ON ${quotedSchema}.messages (thread_id, sequence);
        CREATE INDEX messages_compact_checkpoint_idx
          ON ${quotedSchema}.messages (thread_id, sequence DESC)
          WHERE compacted_through_sequence IS NOT NULL;
      `);
      await pool.query(`
        INSERT INTO ${quotedSchema}.threads (id, session_id)
        VALUES ('thread-live-checkpoint', 'session-live-checkpoint')
      `);
      const manualOwner = {
        source: "daemon",
        connectorKey: "checkpoint-manual",
        holderId: "checkpoint-manual-owner",
      };
      await pool.query(`
        INSERT INTO ${quotedSchema}.connector_leases (
          source, connector_key, holder_id, leased_until
        ) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
      `, [manualOwner.source, manualOwner.connectorKey, manualOwner.holderId]);

      const scopedPool = new SchemaScopedPool(pool, schema);
      const store = new PostgresThreadRuntimeStore({pool: scopedPool});
      for (let index = 1; index <= 4; index += 1) {
        await store.appendRuntimeMessage("thread-live-checkpoint", {
          source: "tui",
          message: stringToUserMessage(`message ${index}`),
        });
      }

      const first = await store.commitCompactionExclusively("thread-live-checkpoint", {
        expectedCheckpointId: null,
        message: createCompactBoundaryMessage("first summary"),
        metadata: compactMetadata(2),
      }, manualOwner);
      await store.appendRuntimeMessage("thread-live-checkpoint", {
        source: "tui",
        message: stringToUserMessage("preserved tail"),
      });
      const second = await store.commitCompactionExclusively("thread-live-checkpoint", {
        expectedCheckpointId: first.id,
        message: createCompactBoundaryMessage("second summary"),
        metadata: compactMetadata(4),
      }, manualOwner);
      await store.appendRuntimeMessage("thread-live-checkpoint", {
        source: "compact",
        message: stringToUserMessage("compaction failed"),
        metadata: {
          kind: "compact_failure_notice",
          trigger: "auto",
          reason: "test failure",
          consecutiveFailures: 1,
          cooldownUntil: null,
        },
      });
      await store.appendRuntimeMessage("thread-live-checkpoint", {
        source: "tui",
        message: stringToUserMessage("after second checkpoint"),
      });

      const active = await store.loadActiveTranscript("thread-live-checkpoint");
      expect(active.checkpointId).toBe(second.id);
      expect(active.records.map((record) => record.sequence)).toEqual([7, 6, 9]);
      expect(active.records).not.toContainEqual(expect.objectContaining({id: first.id}));

      await expect(store.commitCompactionExclusively("thread-live-checkpoint", {
        expectedCheckpointId: first.id,
        message: createCompactBoundaryMessage("stale summary"),
        metadata: compactMetadata(4),
      }, manualOwner)).rejects.toBeInstanceOf(StaleThreadCompactionError);

      const newest = await store.listTranscriptPage("thread-live-checkpoint", {limit: 4});
      const older = await store.listTranscriptPage("thread-live-checkpoint", {
        beforeSequence: newest.nextBeforeSequence,
        limit: 5,
      });
      expect(newest.records.map((record) => record.sequence)).toEqual([6, 7, 8, 9]);
      expect(older.records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(older.nextBeforeSequence).toBeUndefined();

      const forwardFirst = await store.listTranscriptPage("thread-live-checkpoint", {
        afterSequence: 3,
        limit: 2,
      });
      const forwardSecond = await store.listTranscriptPage("thread-live-checkpoint", {
        afterSequence: forwardFirst.nextAfterSequence!,
        limit: 10,
      });
      expect(forwardFirst.records.map((record) => record.sequence)).toEqual([4, 5]);
      expect(forwardFirst.nextAfterSequence).toBe(5);
      expect(forwardSecond.records.map((record) => record.sequence)).toEqual([6, 7, 8, 9]);
      expect(forwardSecond.nextAfterSequence).toBeUndefined();

      await pool.query(`
        INSERT INTO ${quotedSchema}.threads (id, session_id)
        VALUES ('thread-live-fence', 'session-live-fence')
      `);
      const fencedMessage = await store.appendRuntimeMessage("thread-live-fence", {
        source: "tui",
        message: stringToUserMessage("owned compaction"),
      });
      const fencedRunId = randomUUID();
      await pool.query(`
        INSERT INTO ${quotedSchema}.connector_leases (
          source, connector_key, holder_id, leased_until
        ) VALUES ('daemon', 'checkpoint-run', 'checkpoint-owner', NOW() + INTERVAL '1 hour')
      `);
      await pool.query(`
        INSERT INTO ${quotedSchema}.runs (
          id, thread_id, owner_source, owner_key, owner_holder_id, status
        ) VALUES ($1, 'thread-live-fence', 'daemon', 'checkpoint-run', 'checkpoint-owner', 'running')
      `, [fencedRunId]);
      const fencedCheckpoint = await store.commitCompaction("thread-live-fence", {
        expectedCheckpointId: null,
        message: createCompactBoundaryMessage("owned summary"),
        metadata: compactMetadata(fencedMessage.sequence),
        runId: fencedRunId,
      });
      await pool.query(`
        UPDATE ${quotedSchema}.connector_leases
        SET leased_until = NOW() - INTERVAL '1 second'
        WHERE source = 'daemon' AND connector_key = 'checkpoint-run'
      `);
      await expect(store.commitCompaction("thread-live-fence", {
        expectedCheckpointId: fencedCheckpoint.id,
        message: createCompactBoundaryMessage("expired owner"),
        metadata: compactMetadata(fencedMessage.sequence),
        runId: fencedRunId,
      })).rejects.toBeInstanceOf(ThreadRunClaimLostError);

      await pool.query(`
        INSERT INTO ${quotedSchema}.threads (id, session_id)
        VALUES ('thread-live-takeover', 'session-live-takeover')
      `);
      const takeoverMessage = await store.appendRuntimeMessage("thread-live-takeover", {
        source: "tui",
        message: stringToUserMessage("takeover fence"),
      });
      const takeoverRunId = randomUUID();
      await pool.query(`
        INSERT INTO ${quotedSchema}.connector_leases (
          source, connector_key, holder_id, leased_until
        ) VALUES ('daemon', 'checkpoint-takeover', 'checkpoint-old-owner', NOW() + INTERVAL '1 hour')
      `);
      await pool.query(`
        INSERT INTO ${quotedSchema}.runs (
          id, thread_id, owner_source, owner_key, owner_holder_id, status
        ) VALUES (
          $1,
          'thread-live-takeover',
          'daemon',
          'checkpoint-takeover',
          'checkpoint-old-owner',
          'running'
        )
      `, [takeoverRunId]);

      let releaseCompactionFence!: () => void;
      const compactionFenceReleased = new Promise<void>((resolve) => {
        releaseCompactionFence = resolve;
      });
      let markCompactionFenceReached!: () => void;
      const compactionFenceReached = new Promise<void>((resolve) => {
        markCompactionFenceReached = resolve;
      });
      scopedPool.afterClientQuery = async (sql) => {
        if (!sql.includes("active_run_owner AS MATERIALIZED")) {
          return;
        }
        scopedPool.afterClientQuery = undefined;
        markCompactionFenceReached();
        await compactionFenceReleased;
      };

      const takeoverCommit = store.commitCompaction("thread-live-takeover", {
        expectedCheckpointId: null,
        message: createCompactBoundaryMessage("takeover-safe summary"),
        metadata: compactMetadata(takeoverMessage.sequence),
        runId: takeoverRunId,
      });
      await compactionFenceReached;

      const takeoverClient = await pool.connect();
      try {
        let takeoverError: unknown;
        await takeoverClient.query("SET lock_timeout = '100ms'");
        takeoverError = await takeoverClient.query(`
          UPDATE ${quotedSchema}.connector_leases
          SET holder_id = 'checkpoint-new-owner',
              leased_until = NOW() + INTERVAL '1 hour'
          WHERE source = 'daemon'
            AND connector_key = 'checkpoint-takeover'
        `).then(() => undefined, (error: unknown) => error);
        releaseCompactionFence();
        const takeoverCheckpoint = await takeoverCommit;
        expect(takeoverError).toMatchObject({code: "55P03"});

        await takeoverClient.query("RESET lock_timeout");
        await takeoverClient.query(`
          UPDATE ${quotedSchema}.connector_leases
          SET holder_id = 'checkpoint-new-owner',
              leased_until = NOW() + INTERVAL '1 hour'
          WHERE source = 'daemon'
            AND connector_key = 'checkpoint-takeover'
        `);
        await expect(store.commitCompaction("thread-live-takeover", {
          expectedCheckpointId: takeoverCheckpoint.id,
          message: createCompactBoundaryMessage("stale owner summary"),
          metadata: compactMetadata(takeoverMessage.sequence),
          runId: takeoverRunId,
        })).rejects.toBeInstanceOf(ThreadRunClaimLostError);
      } finally {
        releaseCompactionFence();
        await takeoverCommit.catch(() => {});
        takeoverClient.release();
      }

      await pool.query(`
        INSERT INTO ${quotedSchema}.threads (id, session_id)
        VALUES ('thread-live-plan', 'session-live-plan')
      `);
      const inserted = await pool.query(`
        INSERT INTO ${quotedSchema}.messages (
          id,
          thread_id,
          origin,
          source,
          created_at,
          message
        )
        SELECT
          ('10000000-0000-4000-8000-' || LPAD(value::text, 12, '0'))::uuid,
          'thread-live-plan',
          'runtime',
          'assistant',
          NOW(),
          jsonb_build_object('role', 'user', 'content', 'message ' || value, 'timestamp', value)
        FROM generate_series(1, 10000) AS value
        RETURNING sequence
      `);
      const latestOrdinarySequence = Math.max(
        ...inserted.rows.map((row) => Number((row as {sequence: string}).sequence)),
      );
      const compactedThroughSequence = latestOrdinarySequence - 100;
      await pool.query(`
        INSERT INTO ${quotedSchema}.messages (
          id,
          thread_id,
          origin,
          source,
          created_at,
          metadata,
          message,
          compacted_through_sequence
        ) VALUES ($1, 'thread-live-plan', 'runtime', 'compact', NOW(), $2::jsonb, $3::jsonb, $4)
      `, [
        randomUUID(),
        JSON.stringify({
          kind: "compact_boundary",
          preservedTailUserTurns: 3,
          trigger: "manual",
          tokensBefore: 100_000,
          tokensAfter: 1_000,
        }),
        JSON.stringify(createCompactBoundaryMessage("bounded active history")),
        compactedThroughSequence,
      ]);

      const bounded = await store.loadActiveTranscript("thread-live-plan");
      expect(bounded.records).toHaveLength(101);

      const activeQuery = scopedPool.queries.findLast((query) => query.sql.includes("WITH checkpoint AS"));
      const forwardPageQuery = scopedPool.queries.findLast((query) => query.sql.includes("sequence > $2"));
      expect(activeQuery).toBeDefined();
      expect(forwardPageQuery).toBeDefined();
      const planClient = await pool.connect();
      try {
        await planClient.query("SET enable_seqscan = off");
        const explained = await planClient.query(
          `EXPLAIN (FORMAT JSON) ${scopedPool.scopeSql(activeQuery!.sql)}`,
          [...activeQuery!.params],
        );
        const planText = JSON.stringify(explained.rows[0]);
        expect(planText).toContain("messages_compact_checkpoint_idx");
        expect(planText).toContain("messages_thread_sequence_idx");

        const forwardPagePlan = await planClient.query(
          `EXPLAIN (FORMAT JSON) ${scopedPool.scopeSql(forwardPageQuery!.sql)}`,
          [...forwardPageQuery!.params],
        );
        expect(JSON.stringify(forwardPagePlan.rows[0])).toContain("messages_thread_sequence_idx");
      } finally {
        planClient.release();
      }

      await pool.query(`
        INSERT INTO ${quotedSchema}.threads (id, session_id)
        VALUES ('thread-malformed-checkpoint', 'session-malformed-checkpoint')
      `);
      await expect(pool.query(`
        INSERT INTO ${quotedSchema}.messages (
          id,
          thread_id,
          origin,
          source,
          created_at,
          metadata,
          message,
          compacted_through_sequence
        ) VALUES (
          $1,
          'thread-malformed-checkpoint',
          'runtime',
          'compact',
          NOW(),
          NULL,
          $2::jsonb,
          0
        )
      `, [
        randomUUID(),
        JSON.stringify(createCompactBoundaryMessage("invalid checkpoint")),
      ])).rejects.toMatchObject({code: "23514"});

      for (const metadata of [
        {
          ...compactMetadata(0),
          compactedThroughSequence: 0,
        },
        {
          kind: "compact_boundary",
          preservedTailUserTurns: 3,
          tokensBefore: 1_000,
          tokensAfter: 300,
        },
        {
          kind: "compact_boundary",
          trigger: "manual",
          tokensBefore: 1_000,
          tokensAfter: 300,
        },
        {
          kind: "compact_boundary",
          preservedTailUserTurns: "3",
          trigger: "manual",
          tokensBefore: 1_000,
          tokensAfter: 300,
        },
        {
          kind: "compact_boundary",
          preservedTailUserTurns: 3.5,
          trigger: "manual",
          tokensBefore: 1_000,
          tokensAfter: 300,
        },
        {
          kind: "compact_boundary",
          preservedTailUserTurns: 1e100,
          trigger: "manual",
          tokensBefore: 1_000,
          tokensAfter: 300,
        },
      ]) {
        await expect(pool.query(`
          INSERT INTO ${quotedSchema}.messages (
            id,
            thread_id,
            origin,
            source,
            created_at,
            metadata,
            message,
            compacted_through_sequence
          ) VALUES ($1, 'thread-malformed-checkpoint', 'runtime', 'compact', NOW(), $2::jsonb, $3::jsonb, 0)
        `, [
          randomUUID(),
          JSON.stringify(metadata),
          JSON.stringify(createCompactBoundaryMessage("invalid checkpoint shape")),
        ])).rejects.toMatchObject({code: "23514"});
      }
    } finally {
      try {
        if (schemaCreated) {
          await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
        }
      } finally {
        await pool.end();
      }
    }
  });
});
