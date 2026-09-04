// Chequeo manual y en vivo de un link de postulación, disparado por el botón
// "Revisar antes de postular" de cada tarjeta de la Agenda — pedido real de
// una tester de UX (varios links de Match CV llevaban a avisos ya cerrados,
// sin ningún aviso previo). No hay estado que guardar ni comparar contra un
// hash anterior (a diferencia de check-watched-search.js) — es solo "¿esta
// página, ahora mismo, parece un aviso cerrado?".
//
// Limitación real, no ocultable: LinkedIn prohíbe la verificación automática
// por sus términos, e Indeed/Computrabajo bloquean los fetch que hacen
// nuestros servidores (confirmado en producción — ver notas de
// scripts/check-watched-pages.mjs). Para esos dominios se devuelve "unknown"
// directamente, sin intentar el fetch, en vez de fingir una respuesta.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";

const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = "JobTrackWatcher/1.0 (+https://jobtrack.cl; checks a link the user asked about)";

// Dominios donde ya sabemos, por experiencia real con este mismo proyecto,
// que la verificación automática no funciona — se listan explícitos para no
// reintentar algo que ya está confirmado que falla.
const BLOCKED_DOMAINS = ["linkedin.com", "indeed.com", "computrabajo.cl", "computrabajo.com"];

// Frases típicas (es/en) de aviso cerrado o página inexistente — no es
// exhaustivo, cada portal redacta distinto, pero cubre los casos más comunes.
const EXPIRED_PATTERNS = [
  /ya no (est[aá] |se encuentra )?disponible/i,
  /esta (oferta|vacante|publicaci[oó]n) (ya )?(ha expirado|est[aá] cerrada|fue cerrada|no est[aá] disponible)/i,
  /aviso (cerrado|expirado|no encontrado)/i,
  /vacante (cerrada|no encontrada|no disponible)/i,
  /(la )?p[aá]gina no (fue )?encontrada/i,
  /no encontramos (la p[aá]gina|el aviso|esta oferta)/i,
  /this (job|position|posting) (is )?no longer (available|accepting applications)/i,
  /job not found/i,
  /position (has been )?filled/i,
];

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

function isBlockedDomain(url) {
  const lower = url.toLowerCase();
  return BLOCKED_DOMAINS.some((d) => lower.includes(d));
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

  const { link } = req.body || {};
  let url;
  try {
    url = new URL(link);
    if (!/^https?:$/.test(url.protocol)) throw new Error("protocolo inválido");
  } catch (e) {
    res.status(400).json({ error: "Ese link no parece una URL válida." });
    return;
  }

  if (isBlockedDomain(url.href)) {
    res.status(200).json({ status: "unknown", reason: "Este portal bloquea la revisión automática — revísalo tú mismo antes de postular." });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const pageRes = await fetch(url.href, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);

    if (pageRes.status === 404 || pageRes.status === 410) {
      res.status(200).json({ status: "expired", reason: "El portal respondió que la página ya no existe (HTTP " + pageRes.status + ")." });
      return;
    }
    if (!pageRes.ok) {
      res.status(200).json({ status: "unknown", reason: "El portal respondió con un error (HTTP " + pageRes.status + ") — no pudimos confirmar el estado." });
      return;
    }

    const html = await pageRes.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const isExpired = EXPIRED_PATTERNS.some((re) => re.test(text));

    res.status(200).json({
      status: isExpired ? "expired" : "active",
      reason: isExpired ? "La página parece indicar que el aviso ya no está disponible." : "La página respondió con normalidad, sin señales de que el aviso esté cerrado.",
    });
  } catch (e) {
    clearTimeout(timer);
    res.status(200).json({ status: "unknown", reason: "No se pudo cargar la página (tiempo agotado o el sitio la bloqueó) — no pudimos confirmar el estado." });
  }
}
