create table if not exists public.web_session_feedback (
  id uuid primary key,
  session_id uuid not null unique references public.web_game_sessions(id) on delete cascade,
  participant_id uuid not null,
  message text not null check (char_length(trim(message)) between 1 and 1000),
  client_version text not null,
  source_dataset text not null default 'web_pacman' check (source_dataset = 'web_pacman'),
  created_at timestamptz not null default now()
);

create index if not exists web_session_feedback_created_idx
on public.web_session_feedback(created_at desc);

alter table public.web_session_feedback enable row level security;

revoke all on public.web_session_feedback from anon, authenticated;
grant insert on public.web_session_feedback to anon, authenticated;

drop policy if exists "public may submit session feedback" on public.web_session_feedback;
create policy "public may submit session feedback"
on public.web_session_feedback for insert
to anon, authenticated
with check (
  source_dataset = 'web_pacman'
  and char_length(trim(message)) between 1 and 1000
  and length(client_version) between 1 and 40
);
