create table if not exists incidents (
  id integer primary key autoincrement,
  opened_at text not null,
  due_on text not null,
  title text not null,
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  status text not null check (status in ('investigating', 'watching', 'mitigated', 'resolved')),
  owner text,
  source text not null default 'manual',
  details text,
  created_at text not null default current_timestamp,
  resolved_at text
);

create table if not exists incident_events (
  id integer primary key autoincrement,
  incident_id integer not null references incidents(id) on delete cascade,
  event_type text not null,
  note text,
  created_at text not null default current_timestamp
);

create index if not exists idx_incidents_status_severity
  on incidents (status, severity, opened_at desc, id desc);

create index if not exists idx_incident_events_recent
  on incident_events (created_at desc, id desc);

insert into incidents (opened_at, due_on, title, severity, status, owner, source, details, created_at)
values
  ('2026-04-18', '2026-04-19', 'Telegram delivery lag above threshold', 'high', 'investigating', 'Panda', 'watch', 'Messages are delayed, but retries are succeeding.', '2026-04-18T09:20:00.000Z'),
  ('2026-04-19', '2026-04-22', 'Weekly report needs manual review', 'medium', 'watching', 'Jozef', 'user', 'Numbers look plausible, but the source changed its CSV headers.', '2026-04-19T11:10:00.000Z'),
  ('2026-04-20', '2026-04-20', 'App launch link smoke test failed once', 'low', 'mitigated', 'Panda', 'integration', 'Retried successfully after refreshing the app session.', '2026-04-20T15:45:00.000Z'),
  ('2026-04-21', '2026-04-21', 'Old browser session used stale CSRF token', 'medium', 'resolved', 'Patrik', 'manual', 'Opening a fresh app link fixed it.', '2026-04-21T12:00:00.000Z');

insert into incident_events (incident_id, event_type, note, created_at)
values
  (1, 'opened', 'Watch detected delivery lag.', '2026-04-18T09:20:00.000Z'),
  (1, 'triaged', 'Panda owns first pass.', '2026-04-18T09:24:00.000Z'),
  (2, 'opened', 'User asked for report verification.', '2026-04-19T11:10:00.000Z'),
  (3, 'opened', 'Integration smoke failed once.', '2026-04-20T15:45:00.000Z'),
  (3, 'triaged', 'Marked mitigated after retry.', '2026-04-20T16:02:00.000Z'),
  (4, 'resolved', 'Fresh launch link restored access.', '2026-04-21T12:15:00.000Z');
