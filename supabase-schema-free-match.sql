-- Límite de uso de la comparación gratuita de /revisa-tu-cv.
-- No guarda nada del CV ni del aviso: solo un hash de la IP y cuántas veces
-- se usó ese día, para que una llamada anónima a la IA no se vuelva un costo abierto.
-- Ejecutar una vez en el SQL Editor de Supabase.

create table if not exists public.free_match_usage (
  ip_hash    text        not null,
  dia        date        not null,
  usos       integer     not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ip_hash, dia)
);

-- Nadie puede leer ni escribir esta tabla desde el navegador.
-- Solo la función de abajo, llamada con la key de servicio desde /api/free-match.
alter table public.free_match_usage enable row level security;

-- Suma un uso y devuelve el total del día. Se ejecuta con permisos del dueño
-- de la función (security definer), así que no necesita políticas RLS abiertas.
create or replace function public.registrar_uso_free_match(
  p_ip_hash text,
  p_dia     date,
  p_limite  integer default 3
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usos integer;
begin
  insert into public.free_match_usage (ip_hash, dia, usos, updated_at)
  values (p_ip_hash, p_dia, 1, now())
  on conflict (ip_hash, dia)
  do update set usos = public.free_match_usage.usos + 1, updated_at = now()
  returning usos into v_usos;

  return v_usos;
end;
$$;

revoke all on function public.registrar_uso_free_match(text, date, integer) from anon, authenticated;

-- Limpieza: los registros de más de 30 días no sirven para nada.
-- Se puede correr a mano de vez en cuando o dejarlo en un cron de Supabase.
-- delete from public.free_match_usage where dia < current_date - 30;
