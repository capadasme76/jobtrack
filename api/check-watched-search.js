// Chequeo manual de una búsqueda vigilada, disparado por el propio usuario desde
// el botón "Comprobar ahora" — sin esto había que esperar al cron diario para ver
// si algo cambió. Usa el access_token del usuario (no la service_role key): lee y
// escribe su propia fila de jobtrack_state respetando RLS, igual que hace el
// cliente normalmente, solo que el fetch de la página externa pasa por el servidor
// para evitar CORS.

import { createHash } from "node:crypto";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";

const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = "JobTrackWatcher/1.0 (+https://jobtrack.cl; watches pages users opted into)";

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

// Ver scripts/check-watched-pages.mjs: fechas/horas/días sueltos cambian solos
// en muchas páginas sin que haya vacante nueva — se descartan antes de hashear.
const DATE_NOISE_RE = /\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}:\d{2}(:\d{2})?|\b(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b/gi;

function normalizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(DATE_NOISE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function fetchState(userId, accessToken) {
  const url = `${SUPABASE_URL}/rest/v1/jobtrack_state?user_id=eq.${encodeURIComponent(userId)}&select=data`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) throw new Error(`No se pudo leer tu estado guardado (${res.status}).`);
  const rows = await res.json();
  return rows[0] ? rows[0].data : null;
}

async function writeState(userId, accessToken, data) {
  const url = `${SUPABASE_URL}/rest/v1/jobtrack_state?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`No se pudo guardar el resultado (${res.status}).`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const user = await verifySupabaseUser(accessToken);
  if (!user || !user.id) {
    res.status(401).json({ error: "No autorizado. Inicia sesión e intenta de nuevo." });
    return;
  }

  const { searchId } = req.body || {};
  if (!searchId || typeof searchId !== "string") {
    res.status(400).json({ error: "Falta indicar qué búsqueda comprobar." });
    return;
  }

  try {
    const data = await fetchState(user.id, accessToken);
    if (!data || !Array.isArray(data.watchedSearches)) {
      res.status(404).json({ error: "No encontré esa búsqueda vigilada." });
      return;
    }
    const watch = data.watchedSearches.find((w) => w.id === searchId);
    if (!watch || !watch.url) {
      res.status(404).json({ error: "No encontré esa búsqueda vigilada." });
      return;
    }
    if (watch.monitored === false || watch.url.toLowerCase().includes("linkedin.com")) {
      res.status(400).json({ error: "Este portal no se puede vigilar automáticamente — usa \"Ver\" para revisarlo tú mismo." });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let html;
    try {
      const pageRes = await fetch(watch.url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
      if (!pageRes.ok) {
        res.status(502).json({ error: `El portal respondió con un error (HTTP ${pageRes.status}). Intenta más tarde.` });
        return;
      }
      html = await pageRes.text();
    } catch (e) {
      res.status(502).json({ error: "No se pudo cargar la página de la búsqueda. Intenta más tarde." });
      return;
    } finally {
      clearTimeout(timer);
    }

    const newHash = hashText(normalizeHtml(html));
    const now = new Date().toISOString();
    const isFirstCheck = watch.hash === null || watch.hash === undefined;
    const changed = !isFirstCheck && newHash !== watch.hash;

    watch.lastCheckedAt = now;
    watch.hash = newHash;
    if (!Array.isArray(data.dispatches)) data.dispatches = [];
    const cargo = watch.cargo || watch.label || "una búsqueda que vigilas";
    const portalSuffix = watch.portalLabel ? ` en ${watch.portalLabel}` : "";
    if (changed) {
      watch.lastChangedAt = now;
      data.dispatches = data.dispatches.filter((d) => !(d.type === "verify" && d.sourceWatchId === watch.id));
      data.dispatches.push({
        id: `ws${Date.now()}-${watch.id}`,
        type: "verify",
        sourceWatchId: watch.id,
        dateline: "Cambio detectado hoy",
        headline: `Posible novedad en tu búsqueda de "${cargo}"${portalSuffix}`,
        empresa: cargo,
        sector: "Sin sector",
        meta: "Detectamos un cambio en los resultados de esta búsqueda — revisa si hay una vacante nueva antes de asumir que es algo relevante.",
        link: watch.url,
      });
    }
    // isFirstCheck sin cambio: solo se guarda el hash de referencia — la fila ya
    // visible en "Búsquedas de empleo" confirma que quedó activa, no hace falta
    // duplicarlo con una tarjeta en "Hoy" que además nunca es accionable.

    await writeState(user.id, accessToken, data);
    res.status(200).json({ checked: true, changed, isFirstCheck, lastCheckedAt: now });
  } catch (e) {
    console.error("check-watched-search error:", e);
    res.status(500).json({ error: "Error inesperado comprobando la búsqueda." });
  }
}
