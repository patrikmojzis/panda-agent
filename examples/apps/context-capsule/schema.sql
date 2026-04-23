create table if not exists memory_cards (
  id integer primary key autoincrement,
  identity_id text not null,
  captured_on text not null,
  kind text not null check (kind in ('fact', 'preference', 'project', 'reminder')),
  title text not null,
  details text,
  confidence integer not null check (confidence between 1 and 5),
  tags_json text not null default '[]',
  review_on text not null,
  created_at text not null default current_timestamp,
  archived_at text
);

create index if not exists idx_memory_cards_identity_recent
  on memory_cards (identity_id, archived_at, captured_on desc, id desc);

create index if not exists idx_memory_cards_identity_review
  on memory_cards (identity_id, archived_at, review_on asc, confidence asc);

insert into memory_cards (
  identity_id,
  captured_on,
  kind,
  title,
  details,
  confidence,
  tags_json,
  review_on,
  created_at
) values
  ('demo-identity', '2026-04-17', 'preference', 'Prefers direct status updates', 'Use short, concrete progress notes when work is in flight.', 5, '["style","work"]', '2026-04-21', '2026-04-17T10:00:00.000Z'),
  ('demo-identity', '2026-04-19', 'project', 'Micro-app examples should feel capable', 'Show pagination, wake actions, filters, and identity scoping without building a fake platform.', 4, '["project","follow-up"]', '2026-04-22', '2026-04-19T14:30:00.000Z'),
  ('demo-identity', '2026-04-20', 'fact', 'Likes negative-code examples', 'Prefer examples that remove guesswork instead of adding ceremony.', 4, '["taste","style"]', '2026-05-04', '2026-04-20T08:45:00.000Z'),
  ('demo-identity', '2026-04-21', 'reminder', 'Check live app behavior', 'Browser-test the installed app before claiming it teaches the contract.', 5, '["follow-up","project"]', '2026-04-23', '2026-04-21T16:15:00.000Z');
