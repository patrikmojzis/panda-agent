create table if not exists cycle_logs (
  id integer primary key autoincrement,
  identity_id text not null,
  logged_on text not null,
  flow text not null,
  mood text,
  energy integer,
  symptoms_json text not null default '[]',
  notes text,
  created_at text not null default current_timestamp
);

create index if not exists idx_cycle_logs_identity_logged_on
  on cycle_logs (identity_id, logged_on desc, id desc);

insert into cycle_logs (identity_id, logged_on, flow, mood, energy, symptoms_json, notes, created_at)
values
  ('angelina', '2026-04-18', 'medium', 'calm', 4, '["cramps"]', 'Felt surprisingly steady.', '2026-04-18T08:15:00.000Z'),
  ('angelina', '2026-04-19', 'heavy', 'tender', 2, '["cramps","backache"]', 'Needed more rest and tea.', '2026-04-19T09:40:00.000Z'),
  ('angelina', '2026-04-20', 'light', 'flat', 3, '["bloating"]', 'Energy came back a bit.', '2026-04-20T07:55:00.000Z'),
  ('demo', '2026-04-16', 'spotting', 'wired', 3, '["headache"]', 'Demo identity row.', '2026-04-16T18:10:00.000Z');
