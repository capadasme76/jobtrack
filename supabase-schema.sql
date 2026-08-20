-- Correr esto en el SQL Editor del proyecto Supabase (una sola vez).
-- Guarda el estado completo de JobTrack (pipeline, contactos, reuniones, perfil)
-- como un JSONB por usuario, protegido por Row Level Security.

create table public.jobtrack_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.jobtrack_state enable row level security;

create policy "users manage their own state"
  on public.jobtrack_state
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
