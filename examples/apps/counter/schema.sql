create table if not exists counter (
  value integer not null,
  updated_at text
);

delete from counter;
insert into counter (value, updated_at) values (1, datetime('now'));
