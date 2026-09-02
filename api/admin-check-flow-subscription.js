// Acción temporal, de solo lectura: consulta a Flow el estado real de la
// suscripción de la cuenta que llama (GET /subscription/get) — no mueve
// dinero ni cambia nada, solo muestra next_invoice_date/period_start/
// period_end/status tal como Flow los tiene, para confirmar cuándo va a
// intentar el próximo cobro real en vez de asumirlo. Mismo patrón de
// autenticación que create-checkout.js (token de sesión de Supabase) más
// restricción al correo del dueño del sitio. Se borra apenas se use.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";
import { flowGet } from "./_flow-client.js";

const ADMIN_EMAIL = "capadasme@gmail.com";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getSubscriptionRow(userId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=flow_subscription_id,status,current_period_end`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer la suscripción (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

export default async function handler(req, res) {
  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const user = await verifySupabaseUser(accessToken);
  if (!user || user.email !== ADMIN_EMAIL) {
    res.status(403).json({ ok: false, error: "No autorizado." });
    return;
  }

  try {
    const row = await getSubscriptionRow(user.id);
    if (!row || !row.flow_subscription_id) {
      res.status(200).json({ ok: false, error: "Esta cuenta no tiene flow_subscription_id todavía." });
      return;
    }
    const subscription = await flowGet("/subscription/get", { subscriptionId: row.flow_subscription_id });
    res.status(200).json({ ok: true, ourRow: row, flowSubscription: subscription });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message || String(e) });
  }
}
