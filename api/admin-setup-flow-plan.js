// Acción de un solo uso, no un endpoint permanente: crea el Plan real de
// suscripción en Flow (el que hoy solo existe en su ambiente de pruebas, no
// en producción — ver commit "Corregir bug raíz: el Plan de $14.000 se
// creaba en sandbox"). Reutiliza exactamente el mismo patrón de autenticación
// que create-checkout.js (token de sesión de Supabase, no una clave aparte)
// para no introducir un mecanismo de seguridad nuevo — solo que acá además
// se restringe al correo del dueño del sitio, porque esto no es una acción
// que cualquier usuario logueado deba poder disparar.
// Se borra este archivo (y el botón temporal que lo llama en el dashboard)
// apenas se use una vez con éxito.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";
import { flowPost } from "./_flow-client.js";

const ADMIN_EMAIL = "capadasme@gmail.com";

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
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
    const plan = await flowPost("/plans/create", {
      planId: "jobtrack-trimestral",
      name: "JobTrack — Plan trimestral",
      currency: "CLP",
      amount: 14000,
      interval: 3,
      interval_count: 3,
      urlCallback: "https://jobtrack.cl/api/flow-payment-webhook",
    });
    res.status(200).json({ ok: true, plan });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
