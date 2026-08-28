// Flow llega acá por POST con solo un "token" después de que el usuario
// registra su tarjeta en la página de Flow (ver customer/register en
// create-checkout.js). Nunca se confía en el cuerpo del POST más allá de
// usar ese token como llave — el resultado real se pide de vuelta a Flow con
// una llamada propia firmada (customer/getRegisterStatus), igual que Flow
// documenta para el flujo de pagos normal.

import { SUPABASE_URL } from "../supabase-config.js";
import { flowGet, flowPost } from "./_flow-client.js";

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLOW_PLAN_ID = process.env.FLOW_PLAN_ID;

async function getSubscriptionByCustomerId(customerId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?flow_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id,trial_ends_at,flow_subscription_id`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`No se pudo buscar la suscripción (${res.status}): ${await res.text()}`);
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
  const token = (req.method === "POST" ? req.body && req.body.token : req.query.token) || "";
  if (!token) {
    res.status(400).send("Falta token.");
    return;
  }

  try {
    const registration = await flowGet("/customer/getRegisterStatus", { token });
    // status documentado: 1 = tarjeta registrada con éxito.
    if (registration.status !== 1) {
      res.redirect(302, "https://jobtrack.cl/jobtrack-dashboard-cristian.html?pago=fallido");
      return;
    }

    const row = await getSubscriptionByCustomerId(registration.customerId);
    if (!row) {
      // No debería pasar (create-checkout.js siempre guarda flow_customer_id
      // antes de mandar al usuario a registrar la tarjeta) — fail-open: no
      // dejamos a alguien varado en una pantalla de error por un problema
      // nuestro de sincronía, Flow ya tiene la tarjeta registrada igual.
      console.error("flow-register-callback: no se encontró suscripción para customerId", registration.customerId);
      res.redirect(302, "https://jobtrack.cl/jobtrack-dashboard-cristian.html");
      return;
    }

    // Si ya existe una suscripción de Flow para este usuario (ej. volvió a
    // registrar tarjeta), no se crea una segunda — se deja como está.
    if (!row.flow_subscription_id) {
      const subscription = await flowPost("/subscription/create", {
        planId: FLOW_PLAN_ID,
        customerId: registration.customerId,
        // Alinea el primer cobro real de Flow con el fin de nuestro propio
        // trial de 7 días (trigger de Supabase, Fase D.1) — trial_period_days
        // se deja en 0 a propósito, ver nota en _flow-client.js.
        subscription_start: (row.trial_ends_at || new Date().toISOString()).slice(0, 10),
        trial_period_days: 0,
      });
      await setFlowSubscriptionId(row.user_id, subscription.subscriptionId);
    }

    res.redirect(302, "https://jobtrack.cl/jobtrack-dashboard-cristian.html?pago=listo");
  } catch (e) {
    console.error("flow-register-callback error:", e);
    res.redirect(302, "https://jobtrack.cl/jobtrack-dashboard-cristian.html?pago=error");
  }
}
