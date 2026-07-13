create extension if not exists pgcrypto;

create table if not exists public.web_game_sessions (
  id uuid primary key,
  participant_id uuid not null,
  initial_difficulty text not null check (initial_difficulty in ('Easy', 'Medium', 'Hard')),
  rounds_planned integer not null default 5 check (rounds_planned between 1 and 20),
  consent_version text not null default '2026-07-13',
  client_version text not null,
  source_dataset text not null default 'web_pacman' check (source_dataset = 'web_pacman'),
  created_at timestamptz not null default now()
);

create table if not exists public.web_round_logs (
  id uuid primary key,
  session_id uuid not null references public.web_game_sessions(id) on delete cascade,
  participant_id uuid not null,
  level integer not null check (level between 1 and 5),
  difficulty text not null check (difficulty in ('Easy', 'Medium', 'Hard')),
  difficulty_factor numeric not null check (difficulty_factor between 0 and 2),
  outcome text not null check (outcome in ('completed', 'failed', 'abandoned')),
  reaction_time numeric not null check (reaction_time between 0 and 3600),
  completion_time numeric not null check (completion_time between 0.01 and 7200),
  score integer not null check (score between 0 and 1000000),
  retries integer not null check (retries between 0 and 20),
  accuracy numeric not null check (accuracy between 0 and 100),
  errors integer not null check (errors between 0 and 100),
  actions_taken integer not null check (actions_taken between 0 and 100000),
  elapsed_time_ratio numeric not null check (elapsed_time_ratio between 0 and 100),
  progress_rate numeric not null check (progress_rate between 0 and 1),
  score_rate numeric not null check (score_rate between 0 and 100000),
  action_rate numeric not null check (action_rate between 0 and 1000),
  idle_ratio numeric not null check (idle_ratio between 0 and 1),
  direction_change_rate numeric not null check (direction_change_rate between 0 and 1),
  target_adjustment integer not null check (target_adjustment in (-1, 0, 1)),
  player_feedback text not null check (player_feedback in ('too_difficult', 'balanced', 'too_easy', 'skipped')),
  label_source text not null check (label_source in ('player_feedback', 'implicit_real_outcome')),
  label_confidence numeric not null check (label_confidence between 0 and 1),
  validation_status text not null default 'pending_validation' check (validation_status in ('pending_validation', 'valid', 'rejected')),
  source_dataset text not null default 'web_pacman' check (source_dataset = 'web_pacman'),
  client_version text not null,
  created_at timestamptz not null default now()
);

create index if not exists web_round_logs_session_idx on public.web_round_logs(session_id);
create index if not exists web_round_logs_participant_idx on public.web_round_logs(participant_id);
create index if not exists web_round_logs_created_idx on public.web_round_logs(created_at desc);
create index if not exists web_round_logs_validation_idx on public.web_round_logs(validation_status, created_at desc);

alter table public.web_game_sessions enable row level security;
alter table public.web_round_logs enable row level security;

revoke all on public.web_game_sessions from anon, authenticated;
revoke all on public.web_round_logs from anon, authenticated;
grant insert on public.web_game_sessions to anon, authenticated;
grant insert on public.web_round_logs to anon, authenticated;

drop policy if exists "public may submit valid sessions" on public.web_game_sessions;
create policy "public may submit valid sessions"
on public.web_game_sessions for insert
to anon, authenticated
with check (
  source_dataset = 'web_pacman'
  and rounds_planned between 1 and 20
  and length(client_version) between 1 and 40
);

drop policy if exists "public may submit valid round logs" on public.web_round_logs;
create policy "public may submit valid round logs"
on public.web_round_logs for insert
to anon, authenticated
with check (
  source_dataset = 'web_pacman'
  and validation_status = 'pending_validation'
  and label_source <> 'model_prediction'
  and length(client_version) between 1 and 40
);
