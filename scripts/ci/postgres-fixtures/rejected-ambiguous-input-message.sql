INSERT INTO runtime.messages (
  id, thread_id, origin, source, channel_id, external_message_id, actor_id,
  identity_id, created_at, metadata, message
)
SELECT
  '00000000-0000-4000-8000-000000000012',
  thread_id, origin, source, channel_id, external_message_id, actor_id,
  identity_id, created_at, metadata, message
FROM runtime.messages
WHERE id = '00000000-0000-4000-8000-000000000011';
