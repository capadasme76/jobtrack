// Inicia el flujo de pago: crea una orden de pago simple, de una sola vez,
// en Flow (/payment/create) y devuelve la URL donde el usuario paga —
// nuestro servidor nunca ve ni toca datos de tarjeta, solo redirige.
//
// Cambio de arquitectura (2026-09-02): antes esto registraba la tarjeta
// para cobro automático recurrente (/customer/register + /subscription/
// create), pero ese registro específico venía siendo rechazado de forma
// consistente por más de un banco chileno (Santander, Falabella) en su
// paso de autorización de "cargo automático" — un pago simple y puntual no
// pasa por ese mismo paso, así que es la vía confiable. La renovación deja
// de ser automática: cada 3 meses hay que volver a pagar (se recuerda por
// correo antes de que venza, ver plan pendiente). commerceOrder lleva el
// user_id embebido para que api/flow-payment-confirm.js sepa a quién
// activar sin depender de emparejar por correo (esa forma ya causó un bug
// real antes, ver commit "Corregir bug crítico").
//
// Autenticado igual que check-watched-search.js: con el access_token propio
// del usuario, no la service_role key, solo para verificar identidad.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";
import { flowPost } from "./_flow-client.js";

const PLAN_AMOUNT_CLP = 14000;

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const user = await verifySupabaseUser(accessToken);
  if (!user || !user.id || !user.email) {
    res.status(401).json({ error: "No autorizado. Inicia sesión e intenta de nuevo." });
    return;
  }

  try {
    // Flow rechaza commerceOrder de más de 45 caracteres (código 1622) — un
    // bug real que hizo fallar el 100% de los intentos de pago desde el
    // cambio de arquitectura del 2 de septiembre: "jobtrack_" + UUID (36) +
    // "_" + Date.now() (13 dígitos) daba 59 caracteres. Se acorta a 43: sin
    // el prefijo "jobtrack_" (no hace falta, el user_id ya identifica la
    // cuenta sin ambigüedad) y con la marca de tiempo en segundos y base36
    // en vez de milisegundos decimales. El guión bajo como separador sigue
    // siendo seguro: un UUID nunca contiene "_", así que el webhook puede
    // separar por el último "_" sin confundirse.
    const commerceOrder = `${user.id}_${Math.floor(Date.now() / 1000).toString(36)}`;
    const payment = await flowPost("/payment/create", {
      commerceOrder,
      subject: "JobTrack - Plan trimestral",
      currency: "CLP",
      amount: PLAN_AMOUNT_CLP,
      email: user.email,
      urlConfirmation: "https://jobtrack.cl/api/flow-payment-confirm",
      // No apunta directo al archivo estático del dashboard: Flow devuelve
      // al navegador con un POST, y un archivo estático en Vercel responde
      // "405 Method Not Allowed" a eso (confirmado en producción). Este
      // endpoint intermedio solo reenvía (302) al dashboard real.
      urlReturn: "https://jobtrack.cl/api/flow-payment-return",
    });

    res.status(200).json({ redirectUrl: `${payment.url}?token=${payment.token}` });
  } catch (e) {
    console.error("create-checkout error:", e);
    // Detalle real incluido a propósito (temporal, mientras depuramos el
    // primer intento real de este flujo en producción) — sin esto, el único
    // registro del error queda en los logs del servidor, inaccesibles desde
    // el navegador de quien reporta el problema.
    res.status(500).json({ error: e.message || "Error desconocido." });
  }
}
