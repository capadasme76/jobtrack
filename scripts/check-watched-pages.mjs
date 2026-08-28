// Chequeo diario de "páginas de empleos" vigiladas por los usuarios.
// No extrae ni estructura vacantes: solo detecta si el contenido de una página
// pública que el propio usuario eligió vigilar cambió desde el último chequeo,
// y actualiza hash/lastCheckedAt/lastChangedAt del watch — la sección Hoy del
// dashboard calcula sus pendientes en vivo a partir de esos campos, no de un
// registro empujado aquí.
//
// Corre como script de Node plano (sin dependencias) vía GitHub Actions —
// ver .github/workflows/check-watched-pages.yml. Usa la service role key de
// Supabase para leer/escribir jobtrack_state directo por su API REST.

import { createHash } from "node:crypto";
import { sendEmail } from "./send-email.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.");
  process.exit(1);
}

// Diagnóstico: confirma qué key quedó cargada sin exponerla — decodifica solo
// el claim "role" del JWT (public por diseño, no es información sensible).
try {
  const payload = JSON.parse(Buffer.from(SERVICE_ROLE_KEY.split(".")[1], "base64").toString("utf8"));
  console.log(`Key cargada con role: "${payload.role}" (debería decir "service_role")`);
} catch (e) {
  console.log("No se pudo decodificar el JWT de la key cargada — ¿es realmente una key de Supabase?");
}

const FETCH_TIMEOUT_MS = 15000;
const DELAY_BETWEEN_FETCHES_MS = 500;
const USER_AGENT = "JobTrackWatcher/1.0 (+https://jobtrack.cl; watches pages users opted into)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fechas, horas y días de la semana sueltos en una página (ej. un banner "hoy es
// miércoles 19 de agosto") cambian todos los días sin que haya ninguna vacante
// nueva — se descartan antes de hashear para no generar avisos falsos.
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

// ChileTrabajos repite menú, categorías, pie de página y anuncios idénticos
// en TODAS sus páginas de resultados, sin importar la búsqueda — hashear la
// página completa hacía que un cambio de ese contenido compartido (ej. un
// anuncio nuevo) apareciera como "cambio" en todas las búsquedas vigiladas a
// la vez, aunque ninguna vacante nueva hubiera aparecido (confirmado: casi
// el 100% de las búsquedas se marcaban "cambiadas" en cada corrida). Se aísla
// solo el bloque de resultados, delimitado por comentarios que el propio HTML
// de Chiletrabajos usa para marcar el loop de vacantes, antes de normalizar.
function extractChileTrabajosResults(html) {
  const start = html.indexOf("AQUI VA LOOP");
  const end = html.indexOf("<!-- publicidad -->", start);
  if (start === -1 || end === -1) return html; // estructura cambió: fallback seguro a la página completa
  return html.slice(start, end);
}

async function fetchAllStateRows() {
  const url = `${SUPABASE_URL}/rest/v1/jobtrack_state?select=user_id,data`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`No se pudo leer jobtrack_state (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function writeStateRow(userId, data) {
  const url = `${SUPABASE_URL}/rest/v1/jobtrack_state?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    throw new Error(`No se pudo guardar jobtrack_state para ${userId} (${res.status}): ${await res.text()}`);
  }
}

// Las alertas por email son una función de pago (ver plan Fase D) — incluso
// para cuentas grandfathered, que siguen gratis para el dashboard tal como
// está hoy, pero no heredan gratis cada función nueva de pago. El aviso
// dentro de la app (en "Hoy") sigue siendo gratis para todos, esto es
// adicional solo para quien paga.
const EMAIL_ENTITLED_STATUSES = new Set(["active", "past_due"]);

async function getSubscriptionStatus(userId) {
  const url = `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=status`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ? rows[0].status : null;
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

// Label/cargo/empresa vienen de texto que el propio usuario escribió en su
// perfil o agenda — se escapan igual antes de meterlos en el HTML del correo,
// para que un "<" o "&" typeado no rompa el formato del mensaje.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function changeAlertHtml(changedItems) {
  const items = changedItems
    .map((item) => `<li><strong>${escapeHtml(item.label)}</strong> — <a href="${escapeHtml(item.url)}">ver la página</a></li>`)
    .join("");
  return `<p>Detectamos cambios en lo que estás vigilando en JobTrack:</p><ul>${items}</ul><p>Entra a <a href="https://jobtrack.cl/jobtrack-dashboard-cristian.html">tu cuenta</a> para revisarlo — lo vas a encontrar también en la sección "Hoy".</p>`;
}

async function notifyChanges(userId, changedItems) {
  if (changedItems.length === 0) return;
  try {
    const status = await getSubscriptionStatus(userId);
    if (!EMAIL_ENTITLED_STATUSES.has(status)) return;
    const email = await getUserEmail(userId);
    if (!email) return;
    await sendEmail({
      to: email,
      subject: changedItems.length === 1 ? `Cambio detectado: ${changedItems[0].label}` : `${changedItems.length} cambios detectados en tus búsquedas`,
      html: changeAlertHtml(changedItems),
    });
    console.log(`  Correo enviado a ${email} (${changedItems.length} cambio(s))`);
  } catch (e) {
    // Un correo que falla no debe tumbar el chequeo del resto de las cuentas.
    console.log(`  ERROR enviando correo para ${userId} — ${e.message || e}`);
  }
}

async function checkOnePage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const html = await res.text();
    const relevant = url.toLowerCase().includes("chiletrabajos.cl") ? extractChileTrabajosResults(html) : html;
    return { ok: true, hash: hashText(normalizeHtml(relevant)) };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function processRow(row) {
  const data = row.data || {};
  const watchedPages = Array.isArray(data.watchedPages) ? data.watchedPages : [];
  const watchedSearches = Array.isArray(data.watchedSearches) ? data.watchedSearches : [];
  const opportunities = Array.isArray(data.opportunities) ? data.opportunities : [];
  if (watchedPages.length === 0 && watchedSearches.length === 0) {
    return { checked: 0, changed: 0, skipped: 0, errors: 0, mutated: false, changedItems: [] };
  }

  let checked = 0, changed = 0, skipped = 0, errors = 0, mutated = false;
  const changedItems = [];

  for (const watch of watchedPages) {
    if (!watch.url) { skipped++; continue; }
    if (watch.url.toLowerCase().includes("linkedin.com")) { skipped++; continue; }

    await sleep(DELAY_BETWEEN_FETCHES_MS);
    const result = await checkOnePage(watch.url);
    const now = new Date().toISOString();

    if (!result.ok) {
      console.log(`  ERROR ${watch.url} — ${result.reason}`);
      errors++;
      continue;
    }
    checked++;
    watch.lastCheckedAt = now;
    mutated = true;

    if (watch.hash === null || watch.hash === undefined) {
      // Primer chequeo de esta URL: solo se guarda el hash de referencia, sin dispatch.
      watch.hash = result.hash;
      continue;
    }

    if (result.hash !== watch.hash) {
      changed++;
      watch.hash = result.hash;
      watch.lastChangedAt = now;
      console.log(`  CAMBIO ${watch.url}`);
      const opp = opportunities.find((o) => o.id === watch.opportunityId);
      changedItems.push({ label: opp ? `Página de empleos — ${opp.empresa}` : "Página de empleos vigilada", url: watch.url });
    }
  }

  for (const watch of watchedSearches) {
    if (!watch.url) { skipped++; continue; }
    if (watch.monitored === false) { skipped++; continue; }
    if (watch.url.toLowerCase().includes("linkedin.com")) { skipped++; continue; }

    await sleep(DELAY_BETWEEN_FETCHES_MS);
    const result = await checkOnePage(watch.url);
    const now = new Date().toISOString();

    if (!result.ok) {
      console.log(`  ERROR ${watch.url} — ${result.reason}`);
      errors++;
      continue;
    }
    checked++;
    watch.lastCheckedAt = now;
    mutated = true;

    if (watch.hash === null || watch.hash === undefined) {
      // Solo se guarda el hash de referencia — la fila ya visible en "Búsquedas
      // de empleo" es suficiente confirmación de que quedó activa, no hace falta
      // duplicarlo con una tarjeta en "Hoy" que además nunca es accionable.
      watch.hash = result.hash;
      continue;
    }

    if (result.hash !== watch.hash) {
      changed++;
      watch.hash = result.hash;
      watch.lastChangedAt = now;
      console.log(`  CAMBIO (búsqueda) ${watch.url}`);
      changedItems.push({ label: `Búsqueda "${watch.cargo || ""}"${watch.portalLabel ? " en " + watch.portalLabel : ""}`, url: watch.url });
    }
  }

  return { checked, changed, skipped, errors, mutated, changedItems };
}

async function main() {
  const rows = await fetchAllStateRows();
  console.log(`Filas en jobtrack_state: ${rows.length}`);

  let totals = { checked: 0, changed: 0, skipped: 0, errors: 0 };

  for (const row of rows) {
    const result = await processRow(row);
    totals.checked += result.checked;
    totals.changed += result.changed;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
    if (result.mutated) {
      await writeStateRow(row.user_id, row.data);
    }
    await notifyChanges(row.user_id, result.changedItems);
  }

  console.log(
    `Listo. Chequeadas: ${totals.checked} · Cambios detectados: ${totals.changed} · Omitidas: ${totals.skipped} · Errores: ${totals.errors}`
  );
}

main().catch((e) => {
  console.error("Fallo el chequeo de páginas vigiladas:", e);
  process.exit(1);
});
