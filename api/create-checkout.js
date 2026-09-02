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
    // El guión bajo como separador es a propósito: un user_id (UUID) usa
    // guiones normales, así que separar por "_" en el webhook no se
    // confunde con los guiones del UUID.
    const commerceOrder = `jobtrack_${user.id}_${Date.now()}`;
    const payment = await flowPost("/payment/create", {
      commerceOrder,
      subject: "JobTrack - Plan trimestral",
      currency: "CLP",
      amount: PLAN_AMOUNT_CLP,
      email: user.email,
      urlConfirmation: "https://jobtrack.cl/api/flow-payment-confirm",
      urlReturn: "https://jobtrack.cl/jobtrack-dashboard-cristian.html",
    });

    res.status(200).json({ redirectUrl: `${payment.url}?token=${payment.token}` });
  } catch (e) {
    console.error("create-checkout error:", e);
    res.status(500).json({ error: "No se pudo iniciar el pago. Intenta de nuevo." });
  }
}
