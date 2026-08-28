// Inicia el flujo de pago: crea (o reutiliza) el Customer en Flow y devuelve
// la URL donde el usuario registra su tarjeta en la página de Flow — nuestro
// servidor nunca ve ni toca datos de tarjeta, solo redirige.
// Autenticado igual que check-watched-search.js: con el access_token propio
// del usuario, no la service_role key, para verificar identidad — pero
// escribe en "subscriptions" con la service_role key (fetch directo a la
// REST API de Supabase, mismo patrón que scripts/check-watched-pages.mjs;
// este proyecto no tiene dependencias npm, no se usa el SDK @supabase/supabase-js).

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

// La política RLS de "subscriptions" (Fase D.1) a propósito no da insert/update
// a "authenticated", solo lectura — el customerId de Flow se guarda acá,
// server-side con la service_role key, nunca desde el cliente.
async function getSubscriptionRow(userId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=flow_customer_id`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer la suscripción (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function setFlowCustomerId(userId, customerId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ flow_customer_id: customerId, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`No se pudo guardar flow_customer_id (${res.status}): ${await res.text()}`);
}

function findBadChar(s) {
  if (!s) return null;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 255) return { index: i, code: s.charCodeAt(i), char: s[i] };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");

  if (req.query && req.query.diag === "1") {
    res.status(200).json({
      serviceRoleKey: { length: SERVICE_ROLE_KEY ? SERVICE_ROLE_KEY.length : 0, badChar: findBadChar(SERVICE_ROLE_KEY) },
      anonKey: { length: SUPABASE_ANON_KEY ? SUPABASE_ANON_KEY.length : 0, badChar: findBadChar(SUPABASE_ANON_KEY) },
      accessToken: { length: accessToken.length, badChar: findBadChar(accessToken) },
      supabaseUrl: SUPABASE_URL,
    });
    return;
  }
  const user = await verifySupabaseUser(accessToken);
  if (!user || !user.id) {
    res.status(401).json({ error: "No autorizado. Inicia sesión e intenta de nuevo." });
    return;
  }

  if (!process.env.FLOW_PLAN_ID) {
    res.status(500).json({ error: "Falta configurar FLOW_PLAN_ID en el servidor." });
    return;
  }

  try {
    const existing = await getSubscriptionRow(user.id);
    let customerId = existing && existing.flow_customer_id;

    if (!customerId) {
      const customer = await flowPost("/customer/create", {
        name: (user.email || "").split("@")[0],
        email: user.email,
        externalId: user.id,
      });
      customerId = customer.customerId;
      await setFlowCustomerId(user.id, customerId);
    }

    const register = await flowPost("/customer/register", {
      customerId,
      url_return: "https://jobtrack.cl/api/flow-register-callback",
    });

    res.status(200).json({ redirectUrl: `${register.url}?token=${register.token}` });
  } catch (e) {
    console.error("create-checkout error:", e);
    // DEBUG temporal: se expone el detalle del error en la respuesta para
    // diagnosticar más rápido sin depender de revisar los Logs de Vercel a
    // mano — se revierte apenas se resuelva el problema real.
    res.status(500).json({ error: "No se pudo iniciar el registro de pago. Intenta de nuevo.", debug: String(e && e.stack || e) });
  }
}
