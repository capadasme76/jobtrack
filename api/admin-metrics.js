// Métricas agregadas de inscritos/suscripciones para el dashboard interno
// (admin.html). Protegido por ADMIN_METRICS_KEY (query param ?key=) — sin
// eso, cualquiera podría ver cuántos usuarios tiene el sitio.
//
// Ojo: subscriptions.created_at para cuentas "grandfathered" es la fecha del
// backfill único (ver supabase-schema-subscriptions.sql Sección 3), no la
// fecha real en que esa persona se registró — así que "altas por día" antes
// de esa fecha de backfill no es confiable. Para cuentas nuevas (incluida la
// campaña de Google Ads) sí refleja la fecha real de alta.

import { SUPABASE_URL } from "../supabase-config.js";

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_METRICS_KEY = process.env.ADMIN_METRICS_KEY;

function dayKey(iso) {
  return iso.slice(0, 10); // YYYY-MM-DD, en UTC — suficiente para un gráfico de tendencia
}

// Cuentas de prueba de Cristián/testing interno — nunca cuentan como
// "inscritos" reales. Patrones, no solo la lista exacta, porque nuevas
// pruebas siguen el mismo esquema de nombres (capadasme+jt*@gmail.com,
// jobtrack.*claude@gmail.com) y así no hace falta acordarse de agregar cada
// correo nuevo a mano.
const TEST_EMAIL_PATTERNS = [/^capadasme\+jt[a-z0-9]*@gmail\.com$/i, /^jobtrack\..*claude@gmail\.com$/i];

function isTestEmail(email) {
  if (!email) return false;
  return TEST_EMAIL_PATTERNS.some((re) => re.test(email));
}

// admin/users?email= no filtra server-side (bug conocido de Supabase — ver
// el fix real en flow-payment-confirm.js), así que hay que paginar todo y
// matchear a mano.
async function fetchAllUserEmails() {
  const emailById = new Map();
  let page = 1;
  for (;;) {
    const url = `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`;
    const resp = await fetch(url, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    if (!resp.ok) throw new Error(`admin/users respondió ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const users = data.users || [];
    for (const u of users) emailById.set(u.id, u.email || "");
    if (users.length < 200) break;
    page++;
  }
  return emailById;
}

export default async function handler(req, res) {
  if (!ADMIN_METRICS_KEY || req.query.key !== ADMIN_METRICS_KEY) {
    res.status(401).json({ error: "No autorizado." });
    return;
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/subscriptions?select=user_id,status,created_at,trial_ends_at,current_period_end`;
    const [resp, emailById] = await Promise.all([
      fetch(url, { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }),
      fetchAllUserEmails(),
    ]);
    if (!resp.ok) {
      throw new Error(`Supabase respondió ${resp.status}: ${await resp.text()}`);
    }
    const allRows = await resp.json();
    const excludedTestEmails = new Set();
    const rows = allRows.filter((row) => {
      const email = emailById.get(row.user_id);
      if (isTestEmail(email)) {
        excludedTestEmails.add(email);
        return false;
      }
      return true;
    });

    const now = new Date();
    const startOfDay = (daysAgo) => {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - daysAgo);
      return d;
    };
    const today0 = startOfDay(0);
    const day7 = startOfDay(7);
    const day30 = startOfDay(30);

    const byStatus = { trial: 0, active: 0, past_due: 0, canceled: 0, expired: 0, grandfathered: 0 };
    let signupsToday = 0;
    let signups7d = 0;
    let signups30d = 0;
    let trialsEndingSoon = 0;
    const dailyCounts = new Map();

    for (const row of rows) {
      if (row.status in byStatus) byStatus[row.status]++;

      const created = new Date(row.created_at);
      if (created >= today0) signupsToday++;
      if (created >= day7) signups7d++;
      if (created >= day30) signups30d++;
      if (created >= day30) {
        const k = dayKey(row.created_at);
        dailyCounts.set(k, (dailyCounts.get(k) || 0) + 1);
      }

      if (row.status === "trial" && row.trial_ends_at) {
        const endsAt = new Date(row.trial_ends_at);
        const hoursLeft = (endsAt - now) / 3600000;
        if (hoursLeft > 0 && hoursLeft <= 72) trialsEndingSoon++;
      }
    }

    const dailySignups = [];
    for (let i = 29; i >= 0; i--) {
      const d = startOfDay(i);
      const k = dayKey(d.toISOString());
      dailySignups.push({ date: k, count: dailyCounts.get(k) || 0 });
    }

    res.status(200).json({
      generatedAt: now.toISOString(),
      totalSignups: rows.length,
      excludedTestAccounts: excludedTestEmails.size,
      excludedTestEmails: [...excludedTestEmails].sort(),
      signupsToday,
      signups7d,
      signups30d,
      byStatus,
      trialsEndingSoon,
      estimatedRevenueActive: byStatus.active * 14000,
      dailySignups,
    });
  } catch (e) {
    console.error("admin-metrics error:", e);
    res.status(500).json({ error: "Error interno." });
  }
}
