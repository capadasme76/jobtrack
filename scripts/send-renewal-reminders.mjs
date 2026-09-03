// Avisos por correo de "tu acceso está por vencer" — cubre dos casos con la
// misma cadencia (2 días antes, 1 día antes, el mismo día con llamado de
// acción):
//   - status "trial": recuerda que la prueba gratis de 7 días se acaba,
//     empuja a contratar el plan.
//   - status "active": recuerda que el período de 3 meses ya pagado está por
//     terminar, empuja a renovar (mismo pago simple, sin cargo automático —
//     ver terminos.html "Renovación").
// A diferencia de las alertas de Búsquedas vigiladas (check-watched-pages.mjs,
// EMAIL_ENTITLED_STATUSES = solo active/past_due), este correo SÍ va a
// cuentas "trial" a propósito: es justamente el empujón para que paguen, no
// un beneficio de pago. Cuentas grandfathered/past_due/canceled/expired no
// tienen una fecha de vencimiento futura relevante acá y se ignoran.
//
// Corre diario vía GitHub Actions (ver .github/workflows/send-renewal-reminders.yml).
// Idempotente por día: solo dispara cuando faltan exactamente 2, 1 o 0 días
// para la fecha límite, así que una corrida diaria normal nunca duplica un
// aviso — si por algo el workflow corriera dos veces el mismo día, sí se
// duplicaría (no hay una columna "recordatorio ya enviado"); riesgo aceptado
// por simplicidad, igual que el resto de los scripts de este proyecto.

import { sendEmail } from "./send-email.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Modo prueba: si vienen los dos, se manda SOLO a esta cuenta (con su data
// real) simulando el día indicado (2, 1 o 0), sin importar la fecha real de
// vencimiento ni tocar a nadie más. Mismo patrón que TEST_DIGEST_EMAIL en
// check-watched-pages.mjs.
const TEST_REMINDER_EMAIL = process.env.TEST_REMINDER_EMAIL || null;
const TEST_REMINDER_DAY = process.env.TEST_REMINDER_DAY ? Number(process.env.TEST_REMINDER_DAY) : null;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.");
  process.exit(1);
}

const DASHBOARD_URL = "https://jobtrack.cl/jobtrack-dashboard-cristian.html";

async function fetchDueSubscriptions() {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?status=in.(trial,active)&select=user_id,status,trial_ends_at,current_period_end`;
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

// Mismo bug conocido que en check-watched-pages.mjs: admin/users?email= no
// filtra server-side, hay que paginar y comparar a mano.
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

// Mismo cálculo que check-watched-pages.mjs (duplicado a propósito, ver su
// comentario) — reducido a lo que este correo necesita mostrar.
function isIncomplete(o) {
  return !!(o.incompleta || !o.link);
}

function computeMetrics(data) {
  const opportunities = Array.isArray(data?.opportunities) ? data.opportunities : [];
  const total = opportunities.length;
  const enMovimiento = opportunities.filter((o) => o.status !== "Por postular").length;
  const pendientes = opportunities.filter(isIncomplete).length;
  const networking = Array.isArray(data?.networking) ? data.networking.length : 0;
  return { total, enMovimiento, pendientes, networking };
}

function daysUntilTs(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso) - new Date()) / 86400000);
}

const COPY = {
  trial: {
    2: { subject: "Tu prueba gratis de JobTrack vence en 2 días", headline: "Quedan 2 días de tu prueba gratis" },
    1: { subject: "Tu prueba gratis de JobTrack vence mañana", headline: "Tu prueba gratis vence mañana" },
    0: { subject: "Hoy vence tu prueba gratis de JobTrack", headline: "Hoy es el último día de tu prueba gratis" },
  },
  active: {
    2: { subject: "Tu plan de JobTrack vence en 2 días", headline: "Quedan 2 días de tu plan actual" },
    1: { subject: "Tu plan de JobTrack vence mañana", headline: "Tu plan vence mañana" },
    0: { subject: "Hoy vence tu plan de JobTrack", headline: "Hoy vence tu plan actual" },
  },
};

function reminderHtml({ kind, day, metrics }) {
  const copy = COPY[kind][day];
  const isToday = day === 0;
  const ctaLabel = kind === "trial" ? "Contratar mi plan ahora" : "Renovar mi plan ahora";
  const bodyText =
    kind === "trial"
      ? isToday
        ? "Después de hoy, tu cuenta queda pausada hasta que contrates el plan — no perderás ningún dato, pero sí el acceso al tablero."
        : "Después de esa fecha, tu cuenta queda pausada hasta que contrates el plan — tus datos se mantienen intactos."
      : isToday
        ? "Es un pago simple, no un cargo automático — si no renuevas hoy, tu cuenta queda pausada hasta que lo hagas (sin perder tus datos)."
        : "Es un pago simple, no un cargo automático — si no renuevas antes de esa fecha, tu cuenta queda pausada hasta que lo hagas.";

  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#201E1D;">
      <div style="background:#7C5CFC;padding:20px 28px;">
        <span style="color:#fff;font-size:19px;font-weight:800;">JobTrack</span>
      </div>
      <div style="padding:28px;background:#fff;">
        <h1 style="font-size:20px;margin:0 0 12px;">${escapeHtml(copy.headline)}</h1>
        <p style="font-size:14.5px;line-height:1.6;color:#3a3838;">${bodyText}</p>

        <div style="background:#F3F2F2;padding:16px 20px;margin:20px 0;">
          <p style="font-size:13px;font-weight:700;margin:0 0 10px;color:#605D5D;text-transform:uppercase;letter-spacing:.03em;">Tu progreso hasta ahora</p>
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:4px 0;font-size:14px;">Postulaciones registradas</td>
              <td style="padding:4px 0;font-size:14px;font-weight:700;text-align:right;">${metrics.total}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;font-size:14px;">En movimiento (no "por postular")</td>
              <td style="padding:4px 0;font-size:14px;font-weight:700;text-align:right;">${metrics.enMovimiento}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;font-size:14px;">Contactos en tu red</td>
              <td style="padding:4px 0;font-size:14px;font-weight:700;text-align:right;">${metrics.networking}</td>
            </tr>
          </table>
        </div>

        <div style="text-align:center;margin:24px 0;">
          <a href="${DASHBOARD_URL}" style="background:#7C5CFC;color:#fff;text-decoration:none;padding:13px 28px;font-weight:700;font-size:14.5px;display:inline-block;">${ctaLabel}</a>
        </div>

        <p style="font-size:12.5px;color:#9B9797;margin-top:28px;">JobTrack · Cualquier duda, responde este correo o escríbenos a hola@jobtrack.cl.</p>
      </div>
    </div>
  `;
}

async function sendReminder({ userId, kind, day }) {
  const [email, state] = await Promise.all([getUserEmail(userId), getUserState(userId)]);
  if (!email) {
    console.log(`  (sin correo resuelto para ${userId}, se omite)`);
    return;
  }
  const metrics = computeMetrics(state);
  const copy = COPY[kind][day];
  await sendEmail({ to: email, subject: copy.subject, html: reminderHtml({ kind, day, metrics }) });
  console.log(`  Enviado a ${email} (${kind}, día ${day})`);
}

async function main() {
  if (TEST_REMINDER_EMAIL) {
    const day = TEST_REMINDER_DAY === null ? 0 : TEST_REMINDER_DAY;
    if (![0, 1, 2].includes(day)) {
      console.error("TEST_REMINDER_DAY debe ser 0, 1 o 2.");
      process.exit(1);
    }
    console.log(`Modo prueba: enviando SOLO a ${TEST_REMINDER_EMAIL}, simulando día ${day}.`);
    const userId = await getUserIdByEmail(TEST_REMINDER_EMAIL);
    if (!userId) {
      console.error(`No se encontró ninguna cuenta con el correo ${TEST_REMINDER_EMAIL}.`);
      process.exit(1);
    }
    const subs = await fetchDueSubscriptions();
    const own = subs.find((s) => s.user_id === userId);
    const kind = own && own.status === "active" ? "active" : "trial";
    await sendReminder({ userId, kind, day });
    return;
  }

  const rows = await fetchDueSubscriptions();
  console.log(`${rows.length} cuenta(s) en trial/active a revisar.`);

  let sent = 0;
  for (const row of rows) {
    const kind = row.status === "active" ? "active" : "trial";
    const deadline = kind === "active" ? row.current_period_end : row.trial_ends_at;
    const day = daysUntilTs(deadline);
    if (day !== 2 && day !== 1 && day !== 0) continue;

    console.log(`- ${row.user_id} (${kind}) vence en ${day} día(s)`);
    try {
      await sendReminder({ userId: row.user_id, kind, day });
      sent++;
    } catch (e) {
      console.error(`  Error enviando a ${row.user_id}:`, e.message);
    }
  }
  console.log(`Listo. ${sent} correo(s) enviado(s).`);
}

main().catch((e) => {
  console.error("send-renewal-reminders error:", e);
  process.exit(1);
});
