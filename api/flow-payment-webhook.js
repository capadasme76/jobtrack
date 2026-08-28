// Flow llega acá por POST con solo un "token" cada vez que se genera un cobro
// (Invoice) de la suscripción — la URL está configurada como "urlCallback" al
// crear el Plan en Flow (ver nota de setup en _flow-client.js). Igual que en
// flow-register-callback.js, el token es solo una llave: el resultado real se
// pide de vuelta a Flow con una llamada propia firmada.
//
// ⚠️ Punto no 100% confirmado por la documentación de Flow, marcado a
// propósito en vez de adivinado en silencio: la doc dice que el token de
// cualquier callback de pago se verifica con payment/getStatus (así lo
// documentan explícitamente para payment/create), pero no aclara si el
// token de un cobro recurrente de suscripción trae el mismo objeto
// PaymentStatus, y ese objeto no incluye el customerId de Flow — solo el
// email del pagador ("payer"). Por eso este handler mapea por email en vez
// de por customerId/subscriptionId. **Antes de confiar en esto en
// producción: probar un ciclo de cobro real en sandbox y confirmar que
// "payer" efectivamente llega con el email correcto** — si no, hay que
// ajustar este mapeo (ej. usando invoice/get si Flow expone el invoiceId).

import { SUPABASE_URL } from "../supabase-config.js";
import { flowGet } from "./_flow-client.js";

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Estado de PaymentStatus.status documentado: 1 pendiente, 2 pagada, 3 rechazada, 4 anulada.
const PAID = 2;
const REJECTED = 3;

async function findUserIdByEmail(email) {
  const url = `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const users = Array.isArray(data) ? data : data.users || [];
  return users[0] ? users[0].id : null;
}

async function updateSubscriptionStatus(userId, status, currentPeriodEnd) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ status, current_period_end: currentPeriodEnd, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`No se pudo actualizar la suscripción de ${userId} (${res.status}): ${await res.text()}`);
}

export default async function handler(req, res) {
  const token = (req.body && req.body.token) || "";
  if (!token) {
    res.status(400).send("Falta token.");
    return;
  }

  try {
    const payment = await flowGet("/payment/getStatus", { token });
    if (!payment.payer) {
      console.error("flow-payment-webhook: PaymentStatus sin payer, no se puede mapear al usuario", payment);
      res.status(200).send("OK"); // 200 igual, para que Flow no reintente indefinidamente algo que no vamos a poder resolver.
      return;
    }

    const userId = await findUserIdByEmail(payment.payer);
    if (!userId) {
      console.error("flow-payment-webhook: no se encontró usuario para el email", payment.payer);
      res.status(200).send("OK");
      return;
    }

    if (payment.status === PAID) {
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 3); // cada 3 meses, mismo intervalo del Plan.
      await updateSubscriptionStatus(userId, "active", periodEnd.toISOString());
    } else if (payment.status === REJECTED) {
      // past_due entra en su ventana de gracia de 3 días vía is_entitled()
      // (Fase D.1) — no se corta el acceso al tiro por un cobro fallido.
      await updateSubscriptionStatus(userId, "past_due", null);
    }
    // status pendiente/anulada: no se toca el estado actual, se espera el próximo aviso.

    res.status(200).send("OK");
  } catch (e) {
    console.error("flow-payment-webhook error:", e);
    // 500 acá sí es correcto (a diferencia de los casos de arriba) — le dice a
    // Flow que reintente, porque esto fue un error nuestro (ej. Supabase caído),
    // no un caso ya resuelto que no vale la pena reintentar.
    res.status(500).send("Error interno.");
  }
}
