// Acción de un solo uso, no un endpoint permanente. Primer intento: crear el
// Plan real en Flow — resultó que YA EXISTÍA en producción (Flow respondió
// "This planId has already been used"), así que el problema no era el plan.
// Segundo intento (este): crear la suscripción real directamente para la
// cuenta que llama al endpoint, el mismo paso que flow-register-callback.js
// intenta y que viene fallando en silencio — así vemos el error real de
// Flow de una vez, en vez de seguir adivinando.
// Reutiliza el mismo patrón de autenticación que create-checkout.js (token
// de sesión de Supabase) más una restricción al correo del dueño del sitio.
// Se borra este archivo (y el botón temporal que lo llama en el dashboard)
// apenas se resuelva el problema real.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";
import { flowPost } from "./_flow-client.js";

const ADMIN_EMAIL = "capadasme@gmail.com";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLOW_PLAN_ID = process.env.FLOW_PLAN_ID;

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getSubscriptionRow(userId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=flow_customer_id,flow_subscription_id,trial_ends_at`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer la suscripción (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function setFlowSubscriptionId(userId, flowSubscriptionId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ flow_subscription_id: flowSubscriptionId, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`No se pudo guardar flow_subscription_id (${res.status}): ${await res.text()}`);
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
    if (!row || !row.flow_customer_id) {
      res.status(200).json({ ok: false, error: "Esta cuenta no tiene flow_customer_id — registra la tarjeta primero." });
      return;
    }

    const debugInfo = { FLOW_PLAN_ID, flow_customer_id: row.flow_customer_id, flow_subscription_id_actual: row.flow_subscription_id };

    const subscription = await flowPost("/subscription/create", {
      planId: FLOW_PLAN_ID,
      customerId: row.flow_customer_id,
      subscription_start: new Date().toISOString().slice(0, 10),
      trial_period_days: 0,
    });

    if (subscription.subscriptionId) {
      await setFlowSubscriptionId(user.id, subscription.subscriptionId);
    }

    res.status(200).json({ ok: true, subscription, debugInfo });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message || String(e), FLOW_PLAN_ID });
  }
}
