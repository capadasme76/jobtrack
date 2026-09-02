// Cancela la renovación automática de la suscripción del usuario que llama
// (self-service, no es una acción de administrador). Usa /subscription/cancel
// de Flow con at_period_end=1 — la suscripción NO se corta al tiro, Flow
// simplemente no genera el próximo cobro; el usuario sigue teniendo acceso
// hasta current_period_end (ya guardado desde el último pago real), que es
// justamente lo que is_entitled()/computeEntitlement() ya esperan de un
// status "canceled". No hace falta esperar un webhook de Flow para reflejar
// esto: la respuesta de /subscription/cancel ya confirma que quedó registrado.
// Autenticado igual que create-checkout.js: con el access_token propio del
// usuario, nunca con la service_role key para verificar identidad.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";
import { flowPost } from "./_flow-client.js";

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
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=status,flow_subscription_id`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer la suscripción (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function markCanceled(userId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ status: "canceled", updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`No se pudo actualizar la suscripción (${res.status}): ${await res.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Método no permitido." });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const user = await verifySupabaseUser(accessToken);
  if (!user || !user.id) {
    res.status(401).json({ ok: false, error: "No autorizado. Inicia sesión e intenta de nuevo." });
    return;
  }

  try {
    const row = await getSubscriptionRow(user.id);
    if (!row || !row.flow_subscription_id) {
      res.status(400).json({ ok: false, error: "No encontramos una suscripción activa en esta cuenta." });
      return;
    }
    if (row.status === "canceled") {
      res.status(200).json({ ok: true, alreadyCanceled: true });
      return;
    }

    await flowPost("/subscription/cancel", {
      subscriptionId: row.flow_subscription_id,
      at_period_end: 1,
    });

    await markCanceled(user.id);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("cancel-subscription error:", e);
    res.status(500).json({ ok: false, error: "No se pudo cancelar. Intenta de nuevo o escríbenos a hola@jobtrack.cl." });
  }
}
