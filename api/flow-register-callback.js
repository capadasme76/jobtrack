// Flow llega acá por POST con solo un "token" después de que el usuario
// registra su tarjeta en la página de Flow (ver customer/register en
// create-checkout.js). Nunca se confía en el cuerpo del POST más allá de
// usar ese token como llave — el resultado real se pide de vuelta a Flow con
// una llamada propia firmada (customer/getRegisterStatus), igual que Flow
// documenta para el flujo de pagos normal.
//
// Cobro del primer período (2026-09-02): confirmado contra la spec OpenAPI
// oficial de Flow que las suscripciones se cobran al FINAL de cada período
// (next_invoice_date = subscription_start + 3 meses), no al crearlas — no
// existe ningún parámetro en /subscription/create para forzar un cobro
// inmediato. Como el dueño del producto pidió explícitamente que el cobro
// se haga al momento de pagar (para poder usar el servicio de inmediato),
// acá se cobra el primer período a mano con /customer/charge (cargo directo
// a la tarjeta ya registrada, sin esperar ningún ciclo) y la suscripción
// recurrente se crea con subscription_start 3 meses después de hoy — así
// el próximo cobro automático de Flow cae justo cuando termina el período
// que ya se cobró acá, sin cobrar dos veces por el mismo período.

import { SUPABASE_URL } from "../supabase-config.js";
import { flowGet, flowPost } from "./_flow-client.js";
import { sendEmail } from "../scripts/send-email.mjs";

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLOW_PLAN_ID = process.env.FLOW_PLAN_ID;
const PLAN_AMOUNT_CLP = 14000;
const PAID = 2; // PaymentStatus.status documentado: 1 pendiente, 2 pagada, 3 rechazada, 4 anulada.

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

async function activateSubscription(userId, currentPeriodEnd) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ status: "active", current_period_end: currentPeriodEnd, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`No se pudo activar la suscripción de ${userId} (${res.status}): ${await res.text()}`);
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

function paidWelcomeEmailHtml(periodEndText) {
  return `
    <p>¡Tu plan de JobTrack ya está activo!</p>
    <p>Confirmamos tu pago — ahora tienes acceso completo, incluyendo el resumen diario personalizado por correo con tus avisos y métricas.</p>
    <p>Tu suscripción se renueva automáticamente cada 3 meses (próximo cobro: ${periodEndText}). Puedes desactivar la renovación automática cuando quieras desde tu cuenta, sin perder el acceso que ya pagaste.</p>
    <p>Cualquier duda, responde este correo o escríbenos a hola@jobtrack.cl.</p>
    <p>Gracias por confiar en JobTrack,<br/>El equipo de JobTrack</p>
  `;
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
    // registrar tarjeta), no se cobra ni se crea una segunda — se deja como está.
    if (!row.flow_subscription_id) {
      const commerceOrder = `jobtrack-first-${row.user_id}-${Date.now()}`;
      const charge = await flowPost("/customer/charge", {
        customerId: registration.customerId,
        amount: PLAN_AMOUNT_CLP,
        subject: "JobTrack - primer período (plan trimestral)",
        commerceOrder,
        currency: "CLP",
      });

      if (charge.status !== PAID) {
        console.error("flow-register-callback: el cobro del primer período no fue aprobado", charge);
        res.redirect(302, "https://jobtrack.cl/jobtrack-dashboard-cristian.html?pago=fallido");
        return;
      }

      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 3); // mismo intervalo del Plan (trimestral).

      const subscription = await flowPost("/subscription/create", {
        planId: FLOW_PLAN_ID,
        customerId: registration.customerId,
        // Empieza cuando termina el período que se acaba de cobrar arriba a
        // mano, no hoy — si empezara hoy, Flow cobraría de nuevo por el
        // mismo período al final del ciclo (doble cobro).
        subscription_start: periodEnd.toISOString().slice(0, 10),
        trial_period_days: 0,
      });
      await setFlowSubscriptionId(row.user_id, subscription.subscriptionId);
      await activateSubscription(row.user_id, periodEnd.toISOString());

      try {
        const email = await getUserEmail(row.user_id);
        if (email) {
          await sendEmail({
            to: email,
            subject: "¡Tu plan de JobTrack ya está activo!",
            html: paidWelcomeEmailHtml(periodEnd.toLocaleDateString("es-CL")),
          });
        }
      } catch (e) {
        // Un correo que falla no debe tumbar la confirmación del pago en sí.
        console.error("flow-register-callback: no se pudo enviar el correo de bienvenida al plan pagado:", e);
      }
    }

    res.redirect(302, "https://jobtrack.cl/jobtrack-dashboard-cristian.html?pago=listo");
  } catch (e) {
    console.error("flow-register-callback error:", e);
    res.redirect(302, "https://jobtrack.cl/jobtrack-dashboard-cristian.html?pago=error");
  }
}
