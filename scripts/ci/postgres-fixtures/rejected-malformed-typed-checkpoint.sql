ALTER TABLE runtime.messages
ADD COLUMN compacted_through_sequence BIGINT;

UPDATE runtime.messages
SET compacted_through_sequence = 1,
    metadata = metadata - 'kind' - 'compactedUpToSequence'
WHERE id = '00000000-0000-4000-8000-000000000013';

INSERT INTO runtime.thread_runtime_migrations (migration_key)
VALUES ('typed_compaction_checkpoints_2026_08_24');
