-- Fase D.1 — Suscripciones de pago (Flow.cl) + prueba gratis de 7 días.
-- Correr en el SQL Editor del proyecto Supabase, EN ORDEN, de a una sección.
-- No corras la Sección 3 (backfill) hasta confirmar que las Secciones 1 y 2
-- ya quedaron activas — si la corres antes, cuentas creadas justo en el medio
-- pueden quedar sin fila de suscripción (ver Fase D.1 del plan para el detalle).

-- ============================================================
-- Sección 1 — Tabla de suscripciones
-- ============================================================
-- Vive separada de jobtrack_state a propósito: el dashboard sobrescribe todo
-- el JSONB de jobtrack_state en cada guardado, así que si el estado de pago
-- viviera ahí, un webhook de Flow actualizándolo podría ser pisado segundos
-- después por el próximo guardado del usuario. Acá, solo el trigger de la
-- Sección 2 y el webhook (con la service_role key, aún no implementado)
-- pueden escribir — el usuario solo puede leer su propia fila.

create table public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'trial', -- trial | active | past_due | canceled | expired | grandfathered
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  flow_subscription_id text,
  flow_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

create policy "users read their own subscription"
  on public.subscriptions
  for select
  using (auth.uid() = user_id);

-- A propósito no hay política de insert/update/delete para "authenticated":
-- Supabase ya le da privilegios de tabla por defecto a ese rol, así que es la
-- AUSENCIA de política (no un grant que falte) lo que bloquea que un usuario
-- se autoasigne status='active' escribiendo directo por la REST API. Si en
-- el futuro alguien "arregla" esto agregando una política de insert/update
-- para authenticated, se rompe la protección — ojo con eso.

-- ============================================================
-- Sección 2 — Alta automática de cuentas nuevas
-- ============================================================
-- Crea la fila de suscripción en cuanto se crea la cuenta en auth.users (no
-- depende de que el dashboard alcance a correr loadState() primero). Empieza
-- el conteo de 7 días desde el registro, no desde la confirmación de correo
-- ni el primer login (ver "Decisiones de producto" del plan si se quiere
-- cambiar esto más adelante).

create function public.handle_new_user_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscriptions (user_id, status, trial_ends_at)
  values (new.id, 'trial', now() + interval '7 days');
  return new;
end;
$$;

create trigger on_auth_user_created_subscription
  after insert on auth.users
  for each row execute function public.handle_new_user_subscription();

-- ============================================================
-- Sección 3 — Backfill de cuentas existentes (correr UNA VEZ, después de
-- confirmar que las Secciones 1 y 2 ya están activas en producción)
-- ============================================================
-- Todo lo que ya existe en auth.users a este momento queda gratis para
-- siempre. "on conflict do nothing" es solo por seguridad — no debería haber
-- conflicto real si el trigger de la Sección 2 ya estaba activo antes.

insert into public.subscriptions (user_id, status)
select id, 'grandfathered' from auth.users
on conflict (user_id) do nothing;

-- ============================================================
-- Sección 4 — Paywall "duro" sobre jobtrack_state
-- ============================================================
-- Refuerza (no reemplaza) la política existente de jobtrack_state: además de
-- ser el dueño de la fila, hay que estar "entitled" (prueba vigente,
-- suscripción activa/en gracia, o cuenta grandfathered). Cierra el hueco de
-- que alguien sin acceso pagado siga leyendo/escribiendo sus datos llamando
-- directo a la REST API de Supabase aunque la pantalla de pago lo bloquee en
-- la interfaz. fail-open: una cuenta sin fila en subscriptions (no debería
-- pasar tras la Sección 2, pero por si acaso) queda permitida, no bloqueada.

create function public.is_entitled(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (
      select
        case status
          when 'grandfathered' then true
          when 'trial' then trial_ends_at > now()
          when 'active' then current_period_end > now()
          when 'past_due' then current_period_end > now() - interval '3 days'
          when 'canceled' then current_period_end > now()
          when 'expired' then false
          else true
        end
      from public.subscriptions
      where user_id = uid
    ),
    true -- sin fila = fail-open, ver nota arriba
  );
$$;

drop policy "users manage their own state" on public.jobtrack_state;

create policy "users manage their own state"
  on public.jobtrack_state
  for all
  using (auth.uid() = user_id and public.is_entitled(auth.uid()))
  with check (auth.uid() = user_id and public.is_entitled(auth.uid()));
