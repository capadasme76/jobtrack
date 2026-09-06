// Correos de reactivación para cuentas que ya quedaron BLOQUEADAS por no
// pagar/renovar — distinto de send-renewal-reminders.mjs, que avisa ANTES
// del vencimiento (2/1/0 días antes). Este script avisa DESPUÉS: cuando el
// bloqueo (paywall duro, ver is_entitled() en supabase-schema-subscriptions.sql
// y computeEntitlement() en el dashboard) ya está aplicado y la cuenta no se
// reactivó sola.
//
// Ninguna cuenta cambia de estado sola en la base de datos cuando vence (ni
// "trial" ni "active" pasan a "expired" automáticamente) — el bloqueo es
// puramente por fecha (trial_ends_at / current_period_end ya pasados). Por
// eso acá se recalcula el mismo cálculo de "¿está bloqueada?" que ya usa el
// dashboard (computeEntitlement en jobtrack-dashboard-cristian.html) en vez
// de confiar en el campo status para saber si están vencidas.
//
// Cadencia: 1 día después del bloqueo (aviso suave) y 7 días después (empuje
// más fuerte, con el ángulo de "oportunidades que se pueden estar perdiendo").
// Solo esos dos puntos por ahora — evita ser spam; se puede ajustar sumando
// más días a WINBACK_DAYS si hace falta más adelante.
//
// Corre diario vía GitHub Actions (ver .github/workflows/send-winback-emails.yml).
// Mismo aviso de idempotencia que send-renewal-reminders.mjs: no hay columna
// "ya se envió este aviso", así que una corrida diaria normal nunca duplica,
// pero dos corridas el mismo día sí lo harían. Riesgo aceptado por simplicidad,
// igual que el resto de los scripts de este proyecto.

import { sendEmail } from "./send-email.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Modo prueba: si vienen los dos, se manda SOLO a esta cuenta (con su data
// real) simulando el hito indicado (1 o 7), sin importar si está realmente
// bloqueada ni tocar a nadie más. Mismo patrón que TEST_REMINDER_EMAIL.
const TEST_WINBACK_EMAIL = process.env.TEST_WINBACK_EMAIL || null;
const TEST_WINBACK_DAY = process.env.TEST_WINBACK_DAY ? Number(process.env.TEST_WINBACK_DAY) : null;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.");
  process.exit(1);
}

const DASHBOARD_URL = "https://jobtrack.cl/jobtrack-dashboard-cristian.html";
const WINBACK_DAYS = [1, 7];
const PAST_DUE_GRACE_DAYS = 3; // debe calzar con computeEntitlement() del dashboard y is_entitled() del SQL

async function fetchCandidateSubscriptions() {
  // grandfathered nunca se bloquea, no hace falta traerla.
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?status=in.(trial,active,past_due,canceled,expired)&select=user_id,status,trial_ends_at,current_period_end`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer subscriptions (${res.status}): ${await res.text()}`);
  return res.json();
}

async function getUserEmail(userId) {
  const url = `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user.email || null;
}

// Mismo bug conocido de siempre: admin/users?email= no filtra server-side.
async function getUserIdByEmail(email) {
  const target = email.trim().toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 10; page++) {
    const url = `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`;
    const res = await fetch(url, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const users = Array.isArray(body) ? body : Array.isArray(body.users) ? body.users : [];
    const match = users.find((u) => (u.email || "").toLowerCase() === target);
    if (match) return match.id;
    if (users.length < perPage) return null;
  }
  return null;
}

async function getUserState(userId) {
  const url = `${SUPABASE_URL}/rest/v1/jobtrack_state?user_id=eq.${encodeURIComponent(userId)}&select=data`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ? rows[0].data : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isIncomplete(o) {
  return !!(o.incompleta || !o.link);
}

function computeMetrics(data) {
  const opportunities = Array.isArray(data?.opportunities) ? data.opportunities : [];
  const total = opportunities.length;
  const enMovimiento = opportunities.filter((o) => o.status !== "Por postular").length;
  const pendientes = opportunities.filter(isIncomplete).length;
  const networking = Array.isArray(data?.networking) ? data.networking.length : 0;
  const watchedSearches = Array.isArray(data?.watchedSearches) ? data.watchedSearches.length : 0;
  return { total, enMovimiento, pendientes, networking, watchedSearches };
}

// Réplica de computeEntitlement() en jobtrack-dashboard-cristian.html: en vez
// de "¿tiene acceso?", acá se pregunta "¿desde cuándo está bloqueada?" (o
// null si no está bloqueada / nunca se bloquea).
function blockedSince(sub, now) {
  switch (sub.status) {
    case "trial":
      return sub.trial_ends_at && new Date(sub.trial_ends_at) <= now ? new Date(sub.trial_ends_at) : null;
    case "active":
    case "canceled":
      return sub.current_period_end && new Date(sub.current_period_end) <= now ? new Date(sub.current_period_end) : null;
    case "past_due": {
      if (!sub.current_period_end) return null;
      const graceEnd = new Date(sub.current_period_end);
      graceEnd.setDate(graceEnd.getDate() + PAST_DUE_GRACE_DAYS);
      return graceEnd <= now ? graceEnd : null;
    }
    case "expired":
      return sub.current_period_end ? new Date(sub.current_period_end) : now; // ya bloqueada por definición
    default:
      return null;
  }
}

function daysSince(date, now) {
  return Math.floor((now - date) / 86400000);
}

const COPY = {
  trial: {
    1: {
      subject: "Tu cuenta de JobTrack quedó pausada",
      headline: "Tu prueba gratis terminó y tu cuenta quedó pausada",
      lead: "No perdiste nada de lo que armaste — tu pipeline, tus contactos y tu perfil siguen guardados. Solo falta reactivar el plan para volver a verlos.",
    },
    7: {
      subject: "Te esperamos de vuelta en JobTrack",
      headline: "Sigues sin retomar tu búsqueda",
      lead: "Cada semana aparecen nuevas oportunidades para perfiles ejecutivos — mientras tu cuenta está pausada, no estás haciendo seguimiento de nada de eso. Te esperamos de vuelta.",
    },
  },
  paid: {
    1: {
      subject: "Tu plan de JobTrack venció y tu cuenta quedó pausada",
      headline: "Tu plan venció y tu cuenta quedó pausada",
      lead: "No perdiste nada de lo que armaste — tu pipeline, tus contactos y tu perfil siguen guardados. Solo falta renovar para volver a verlos.",
    },
    7: {
      subject: "Te esperamos de vuelta en JobTrack",
      headline: "Sigues sin retomar tu búsqueda",
      lead: "Cada semana aparecen nuevas oportunidades para perfiles ejecutivos — mientras tu cuenta está pausada, no estás haciendo seguimiento de nada de eso. Te esperamos de vuelta.",
    },
  },
};

function winbackHtml({ kind, milestone, metrics }) {
  const copy = COPY[kind][milestone];
  const ctaLabel = kind === "trial" ? "Reactivar mi cuenta" : "Renovar mi plan";

  const statsRows = [
    ["Postulaciones que armaste", metrics.total],
    ["En movimiento (no \"por postular\")", metrics.enMovimiento],
    ["Contactos en tu red", metrics.networking],
  ];
  if (metrics.watchedSearches > 0) {
    statsRows.push(["Búsquedas de empleo configuradas", metrics.watchedSearches]);
  }

  const rowsHtml = statsRows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:4px 0;font-size:14px;">${escapeHtml(label)}</td>
          <td style="padding:4px 0;font-size:14px;font-weight:700;text-align:right;">${value}</td>
        </tr>`
    )
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#201E1D;">
      <div style="background:#7C5CFC;padding:20px 28px;">
        <span style="color:#fff;font-size:19px;font-weight:800;">JobTrack</span>
      </div>
      <div style="padding:28px;background:#fff;">
        <h1 style="font-size:20px;margin:0 0 12px;">${escapeHtml(copy.headline)}</h1>
        <p style="font-size:14.5px;line-height:1.6;color:#3a3838;">${escapeHtml(copy.lead)}</p>

        <div style="background:#F3F2F2;padding:16px 20px;margin:20px 0;">
          <p style="font-size:13px;font-weight:700;margin:0 0 10px;color:#605D5D;text-transform:uppercase;letter-spacing:.03em;">Lo que ya construiste</p>
          <table style="width:100%;border-collapse:collapse;">${rowsHtml}</table>
        </div>

        <div style="text-align:center;margin:24px 0;">
          <a href="${DASHBOARD_URL}" style="background:#7C5CFC;color:#fff;text-decoration:none;padding:13px 28px;font-weight:700;font-size:14.5px;display:inline-block;">${ctaLabel}</a>
        </div>

        <p style="font-size:12.5px;color:#9B9797;margin-top:28px;">JobTrack · Cualquier duda, responde este correo o escríbenos a hola@jobtrack.cl.</p>
      </div>
    </div>
  `;
}

async function sendWinback({ userId, kind, milestone }) {
  const [email, state] = await Promise.all([getUserEmail(userId), getUserState(userId)]);
  if (!email) {
    console.log(`  (sin correo resuelto para ${userId}, se omite)`);
    return;
  }
  const metrics = computeMetrics(state);
  const copy = COPY[kind][milestone];
  await sendEmail({ to: email, subject: copy.subject, html: winbackHtml({ kind, milestone, metrics }) });
  console.log(`  Enviado a ${email} (${kind}, +${milestone} día(s) bloqueada)`);
}

async function main() {
  if (TEST_WINBACK_EMAIL) {
    const milestone = TEST_WINBACK_DAY === null ? 1 : TEST_WINBACK_DAY;
    if (!WINBACK_DAYS.includes(milestone)) {
      console.error(`TEST_WINBACK_DAY debe ser uno de: ${WINBACK_DAYS.join(", ")}.`);
      process.exit(1);
    }
    console.log(`Modo prueba: enviando SOLO a ${TEST_WINBACK_EMAIL}, simulando +${milestone} día(s) bloqueada.`);
    const userId = await getUserIdByEmail(TEST_WINBACK_EMAIL);
    if (!userId) {
      console.error(`No se encontró ninguna cuenta con el correo ${TEST_WINBACK_EMAIL}.`);
      process.exit(1);
    }
    const subs = await fetchCandidateSubscriptions();
    const own = subs.find((s) => s.user_id === userId);
    const kind = own && own.status !== "trial" ? "paid" : "trial";
    await sendWinback({ userId, kind, milestone });
    return;
  }

  const now = new Date();
  const rows = await fetchCandidateSubscriptions();
  console.log(`${rows.length} cuenta(s) no-grandfathered a revisar.`);

  let sent = 0;
  for (const row of rows) {
    const since = blockedSince(row, now);
    if (!since) continue; // aún no bloqueada (dentro de trial/período pagado/gracia)

    const days = daysSince(since, now);
    if (!WINBACK_DAYS.includes(days)) continue;

    const kind = row.status === "trial" ? "trial" : "paid";
    console.log(`- ${row.user_id} (${row.status}) bloqueada hace ${days} día(s)`);
    try {
      await sendWinback({ userId: row.user_id, kind, milestone: days });
      sent++;
    } catch (e) {
      console.error(`  Error enviando a ${row.user_id}:`, e.message);
    }
  }
  console.log(`Listo. ${sent} correo(s) de reactivación enviado(s).`);
}

main().catch((e) => {
  console.error("send-winback-emails error:", e);
  process.exit(1);
});
