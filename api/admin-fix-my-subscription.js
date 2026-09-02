// Acción temporal, de un solo uso: corrige la suscripción de la cuenta del
// dueño del sitio, creada antes del fix de cobro inmediato (ver commit
// "Cobrar el primer período de inmediato"). Cancela la suscripción vieja
// (nunca cobró nada todavía, cancelarla no tiene costo), cobra $14.000
// ahora con la tarjeta ya registrada, y crea la suscripción nueva con el
// ciclo correcto desde hoy — mismo procedimiento que flow-register-
// callback.js ya hace automáticamente para cuentas nuevas de aquí en
// adelante. Mueve dinero real — protegido con el mismo patrón de
// autenticación de siempre (token de sesión + correo del dueño del sitio),
// y solo actúa sobre la cuenta de quien llama, nunca sobre otra. Se borra
// apenas se use.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";
import { flowPost } from "./_flow-client.js";

const ADMIN_EMAIL = "capadasme@gmail.com";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLOW_PLAN_ID = process.env.FLOW_PLAN_ID;
const PLAN_AMOUNT_CLP = 14000;
const PAID = 2;

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getSubscriptionRow(userId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=flow_customer_id,flow_subscription_id,status`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer la suscripción (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function saveSubscription(userId, fields) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`No se pudo guardar la suscripción (${res.status}): ${await res.text()}`);
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

    if (row.flow_subscription_id) {
      await flowPost("/subscription/cancel", {
        subscriptionId: row.flow_subscription_id,
        at_period_end: 0,
      });
    }

    const commerceOrder = `jobtrack-fix-${user.id}-${Date.now()}`;
    const charge = await flowPost("/customer/charge", {
      customerId: row.flow_customer_id,
      amount: PLAN_AMOUNT_CLP,
      subject: "JobTrack - primer período (plan trimestral)",
      commerceOrder,
      currency: "CLP",
    });

    if (charge.status !== PAID) {
      res.status(200).json({ ok: false, error: "El cobro no fue aprobado.", charge });
      return;
    }

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 3);

    const subscription = await flowPost("/subscription/create", {
      planId: FLOW_PLAN_ID,
      customerId: row.flow_customer_id,
      subscription_start: periodEnd.toISOString().slice(0, 10),
      trial_period_days: 0,
    });

    await saveSubscription(user.id, {
      status: "active",
      current_period_end: periodEnd.toISOString(),
      flow_subscription_id: subscription.subscriptionId,
    });

    res.status(200).json({ ok: true, charge, subscription });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message || String(e) });
  }
}
