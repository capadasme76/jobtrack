// Flow llega acá por POST con solo un "token" cuando se confirma (o
// rechaza) el pago simple creado en create-checkout.js — la URL va como
// urlConfirmation en /payment/create. El token es solo una llave: el
// resultado real se pide de vuelta a Flow con payment/getStatus, nunca se
// confía en el cuerpo del POST.
//
// A diferencia del webhook viejo de suscripciones (que emparejaba la cuenta
// por el email del pagador, lo que causó un bug real — ver commit
// "Corregir bug crítico: el webhook de pago activaba la cuenta equivocada"),
// acá el user_id viene embebido en commerceOrder (lo pusimos nosotros mismos
// en create-checkout.js), así que no hace falta ningún emparejamiento
// ambiguo.

import { SUPABASE_URL } from "../supabase-config.js";
import { flowGet } from "./_flow-client.js";
import { sendEmail } from "../scripts/send-email.mjs";

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAID = 2; // PaymentStatus.status documentado: 1 pendiente, 2 pagada, 3 rechazada, 4 anulada.

function extractUserId(commerceOrder) {
  const match = /^jobtrack_(.+)_(\d+)$/.exec(commerceOrder || "");
  return match ? match[1] : null;
}

async function getCurrentStatus(userId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=status`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ? rows[0].status : null;
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
    <p>Tu plan vence el ${periodEndText}. Como es un pago simple (no un cargo automático recurrente), te vamos a avisar por correo antes de esa fecha para que renueves cuando quieras — no se te cobra nada sin que tú lo decidas cada vez.</p>
    <p>Cualquier duda, responde este correo o escríbenos a hola@jobtrack.cl.</p>
    <p>Gracias por confiar en JobTrack,<br/>El equipo de JobTrack</p>
  `;
}

export default async function handler(req, res) {
  const token = (req.body && req.body.token) || "";
  if (!token) {
    res.status(400).send("Falta token.");
    return;
  }

  try {
    const payment = await flowGet("/payment/getStatus", { token });
    const userId = extractUserId(payment.commerceOrder);
    if (!userId) {
      console.error("flow-payment-confirm: commerceOrder no reconocido", payment.commerceOrder);
      res.status(200).send("OK"); // 200 igual, para que Flow no reintente algo que no vamos a poder resolver.
      return;
    }

    if (payment.status === PAID) {
      const previousStatus = await getCurrentStatus(userId);
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 3);
      await activateSubscription(userId, periodEnd.toISOString());

      // Solo la primera vez que la cuenta pasa a "active" — no en cada
      // renovación (pago repetido cada 3 meses también pasa por acá).
      if (previousStatus !== "active") {
        try {
          const email = await getUserEmail(userId);
          if (email) {
            await sendEmail({
              to: email,
              subject: "¡Tu plan de JobTrack ya está activo!",
              html: paidWelcomeEmailHtml(periodEnd.toLocaleDateString("es-CL")),
            });
          }
        } catch (e) {
          console.error("flow-payment-confirm: no se pudo enviar el correo de bienvenida:", e);
        }
      }
    }
    // status pendiente/rechazada/anulada: no se toca nada, el usuario ve el
    // resultado al volver a la página (urlReturn) y puede reintentar.

    res.status(200).send("OK");
  } catch (e) {
    console.error("flow-payment-confirm error:", e);
    // 500 sí es correcto acá (a diferencia de arriba) — le dice a Flow que
    // reintente, porque esto fue un error nuestro, no un caso resuelto.
    res.status(500).send("Error interno.");
  }
}
