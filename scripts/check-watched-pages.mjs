// Chequeo diario de "páginas de empleos" y "búsquedas" vigiladas por los
// usuarios. Dos trabajos en un mismo script porque ambos corren sobre el
// mismo fetch diario de las mismas URLs:
//
// 1) Detección de cambios (como antes): hashea el contenido de cada página
//    vigilada y actualiza hash/lastCheckedAt/lastChangedAt del watch — la
//    sección Hoy del dashboard calcula sus pendientes en vivo a partir de
//    esos campos, no de un registro empujado aquí.
// 2) Resumen diario por correo (nuevo): para cuentas con suscripción activa,
//    arma y envía un solo correo diario por usuario con (a) un resumen de
//    sus propias métricas de postulación, (b) avisos nuevos reales que
//    detectamos en ChileTrabajos (el único portal que este servidor puede
//    leer — ver SEARCH_PORTALS en el dashboard) y (c) un link ya filtrado a
//    "últimas 24 horas" por cada búsqueda vigilada en los demás portales,
//    para que el usuario solo tenga que hacer clic. No agregamos scraping
//    nuevo para los demás portales — igual que hoy, esos siguen siendo
//    self-service (el usuario entra y filtra él mismo).
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

// Mismo cálculo que renderMetrics()/computeHoyTasks() del dashboard
// (jobtrack-dashboard-cristian.html), reimplementado acá porque este script
// corre sobre el JSONB crudo, sin browser — duplicación aceptada a propósito,
// mismo patrón que SEARCH_PORTALS ya duplicado entre el dashboard y los
// endpoints. Si cambia la lógica de una vieja tarea, hay que actualizar la
// otra a mano.
function isIncomplete(o) {
  return !!(o.incompleta || !o.link);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + "T23:59:59");
  return Math.ceil((target - new Date()) / 86400000);
}

function computeMetrics(data) {
  const opportunities = Array.isArray(data.opportunities) ? data.opportunities : [];
  const total = opportunities.length;
  const enMovimiento = opportunities.filter((o) => o.status !== "Por postular").length;
  const incompletas = opportunities.filter((o) => isIncomplete(o)).length;
  const vencidas = opportunities.filter((o) => {
    const du = daysUntil(o.fechaLimite);
    return du !== null && du < 0 && o.status !== "Descartado" && o.status !== "Oferta";
  }).length;
  const porVencer = opportunities.filter((o) => {
    const du = daysUntil(o.fechaLimite);
    return du !== null && du >= 0 && du <= 3 && o.status !== "Descartado" && o.status !== "Oferta";
  }).length;
  return { total, enMovimiento, pendientes: incompletas + vencidas + porVencer, incompletas, vencidas, porVencer };
}

// Link "de hoy" por búsqueda vigilada: el mismo link self-service que ya
// existe en "Búsquedas de empleo", pero con el parámetro de fecha que cada
// portal ya soporta públicamente para acotar a las últimas 24 horas — no es
// scraping nuevo, es la misma URL con un filtro que el propio portal ofrece.
// Portales sin un parámetro de fecha confirmado (Laborum, Trabajando.cl)
// quedan con el link tal cual, igual que hoy.
function freshUrl(watch) {
  if (!watch.url) return null;
  const sep = watch.url.includes("?") ? "&" : "?";
  if (watch.portal === "linkedin") return watch.url + sep + "f_TPR=r86400";
  if (watch.portal === "indeed") return watch.url + sep + "fromage=1";
  return watch.url;
}

// Plantilla con la identidad visual de JobTrack (violeta #7C5CFC), mismo
// estilo que ya se usa en el reporte semanal de la comunidad
// (scripts/generate-search-insights.mjs) — se aplica sola cada día, sin
// trabajo manual de diseño.
function digestHtml({ metrics, newListings, changedItems, cargoGroups }) {
  const statChip = (n, l) => `
    <td align="center" style="padding:14px 6px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-weight:800;font-size:22px;color:#201E1D;">${n}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11.5px;color:#605D5D;">${l}</div>
    </td>`;
  const statsHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F2F2;border-radius:6px;">
      <tr>
        ${statChip(metrics.total, "Postulaciones")}
        ${statChip(metrics.enMovimiento, "En movimiento")}
        ${statChip(metrics.pendientes, "Pendientes")}
      </tr>
    </table>`;

  const listingsHtml = newListings.length === 0 ? "" : `
    <tr><td style="padding:0 28px 8px;">
      <p style="font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:14px;color:#201E1D;margin:22px 0 10px;">📬 Avisos nuevos en ChileTrabajos</p>
      ${newListings.map((l) => `
        <div style="border:1px solid #EAE9E9;border-radius:6px;padding:12px 14px;margin-bottom:8px;">
          <div style="font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:13.5px;color:#201E1D;">${escapeHtml(l.title)}</div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:12.5px;color:#605D5D;margin:2px 0 8px;">${escapeHtml(l.company)}${l.city ? " · " + escapeHtml(l.city) : ""} · según tu búsqueda "${escapeHtml(l.cargo)}"</div>
          <a href="${escapeHtml(l.url)}" style="font-family:Helvetica,Arial,sans-serif;font-size:12.5px;color:#7C5CFC;font-weight:700;">Ver aviso →</a>
        </div>`).join("")}
    </td></tr>`;

  const changedHtml = changedItems.length === 0 ? "" : `
    <tr><td style="padding:0 28px 8px;">
      <p style="font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:14px;color:#201E1D;margin:22px 0 10px;">🔎 Cambios detectados</p>
      ${changedItems.map((item) => `<p style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#201E1D;margin:0 0 8px;"><strong>${escapeHtml(item.label)}</strong> — <a href="${escapeHtml(item.url)}" style="color:#7C5CFC;">ver la página →</a></p>`).join("")}
    </td></tr>`;

  const cargoHtml = cargoGroups.length === 0 ? "" : `
    <tr><td style="padding:0 28px 8px;">
      <p style="font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:14px;color:#201E1D;margin:22px 0 10px;">🔗 Tus búsquedas de hoy</p>
      ${cargoGroups.map((g) => `
        <div style="margin-bottom:14px;">
          <div style="font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:13px;color:#201E1D;margin-bottom:6px;">${escapeHtml(g.cargo)}</div>
          <div>${g.links.map((l) => `<a href="${escapeHtml(l.url)}" style="display:inline-block;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#3D2A99;background:#F0EBFF;border:1px solid #D8CCFF;border-radius:14px;padding:5px 11px;margin:0 6px 6px 0;text-decoration:none;">${escapeHtml(l.label)} — hoy →</a>`).join("")}</div>
        </div>`).join("")}
    </td></tr>`;

  return `
  <meta charset="utf-8">
  <div style="background:#F3F2F2;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #D7D3D3;">
      <tr><td style="padding:24px 28px;border-bottom:3px solid #7C5CFC;">
        <span style="font-family:Helvetica,Arial,sans-serif;font-weight:800;font-size:19px;color:#201E1D;">JobTrack<span style="color:#7C5CFC;">.</span></span>
      </td></tr>
      <tr><td style="padding:24px 28px 8px;">
        <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:19px;margin:0 0 16px;color:#201E1D;">Tu resumen de hoy</h1>
        ${statsHtml}
      </td></tr>
      ${listingsHtml}
      ${changedHtml}
      ${cargoHtml}
      <tr><td style="padding:8px 28px 24px;">
        <a href="https://jobtrack.cl/jobtrack-dashboard-cristian.html" style="display:inline-block;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#fff;background:#7C5CFC;border-radius:6px;padding:11px 18px;text-decoration:none;font-weight:700;">Abrir mi JobTrack →</a>
      </td></tr>
      <tr><td style="padding:16px 28px;background:#F3F2F2;">
        <p style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#9B9797;margin:0;">JobTrack — jobtrack.cl · Recibes esto porque tienes una suscripción activa. Puedes desactivar estos avisos desde tu cuenta.</p>
      </td></tr>
    </table>
  </div>
  `;
}

async function sendDailyDigest(userId, data, changedItems, newListings) {
  const opportunities = Array.isArray(data.opportunities) ? data.opportunities : [];
  const watchedSearches = Array.isArray(data.watchedSearches) ? data.watchedSearches : [];
  if (opportunities.length === 0 && watchedSearches.length === 0) return; // nada que contarle

  try {
    const status = await getSubscriptionStatus(userId);
    if (!EMAIL_ENTITLED_STATUSES.has(status)) return;
    const email = await getUserEmail(userId);
    if (!email) return;

    const metrics = computeMetrics(data);

    const byCargo = new Map();
    watchedSearches.forEach((w) => {
      if (!w.cargo || !w.url) return;
      const url = freshUrl(w);
      if (!url) return;
      if (!byCargo.has(w.cargo)) byCargo.set(w.cargo, []);
      byCargo.get(w.cargo).push({ label: w.portalLabel || "Ver búsqueda", url });
    });
    const cargoGroups = Array.from(byCargo.entries()).map(([cargo, links]) => ({ cargo, links }));

    await sendEmail({
      to: email,
      subject: newListings.length > 0
        ? `📬 ${newListings.length} aviso(s) nuevo(s) + tu resumen de hoy — JobTrack`
        : `Tu resumen de hoy — JobTrack`,
      html: digestHtml({ metrics, newListings, changedItems, cargoGroups }),
    });
    console.log(`  Correo enviado a ${email} (${newListings.length} aviso(s) nuevo(s), ${changedItems.length} cambio(s))`);
  } catch (e) {
    // Un correo que falla no debe tumbar el chequeo del resto de las cuentas.
    console.log(`  ERROR enviando correo para ${userId} — ${e.message || e}`);
  }
}

// Cada aviso en una página de resultados de ChileTrabajos sigue siempre el
// mismo patrón de marcado (confirmado contra HTML real, no adivinado):
//   <h2 class="title overflow-hidden"><a href="URL">TÍTULO</a></h2>
//   <h3 class="meta">EMPRESA, <a href="...">CIUDAD</a></h3>
// Si ChileTrabajos cambia su plantilla esto simplemente deja de encontrar
// avisos (devuelve lista vacía) — no rompe el chequeo de cambios existente,
// que sigue funcionando por hash en paralelo.
const CT_LISTING_RE = /<h2 class="title overflow-hidden">\s*<a href="([^"]+)"[^>]*>([^<]*)<\/a>\s*<\/h2>\s*<h3 class="meta">\s*([^<]*?)<a[^>]*>([^<]*)<\/a>/gs;

const HTML_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", "#8230": "…",
};

function decodeEntities(s) {
  return String(s).replace(/&(#?\w+);/g, (m, code) => (code in HTML_ENTITIES ? HTML_ENTITIES[code] : m));
}

function extractChileTrabajosListings(resultsHtml) {
  const out = [];
  const re = new RegExp(CT_LISTING_RE);
  let m;
  while ((m = re.exec(resultsHtml))) {
    const [, url, titleRaw, companyRaw, cityRaw] = m;
    out.push({
      url: url.trim(),
      title: decodeEntities(titleRaw).trim(),
      company: decodeEntities(companyRaw).trim().replace(/,\s*$/, ""),
      city: decodeEntities(cityRaw).trim(),
    });
  }
  return out;
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
    const isChileTrabajos = url.toLowerCase().includes("chiletrabajos.cl");
    const relevant = isChileTrabajos ? extractChileTrabajosResults(html) : html;
    return {
      ok: true,
      hash: hashText(normalizeHtml(relevant)),
      listings: isChileTrabajos ? extractChileTrabajosListings(relevant) : null,
    };
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
    return { checked: 0, changed: 0, skipped: 0, errors: 0, mutated: false, changedItems: [], newListings: [] };
  }

  let checked = 0, changed = 0, skipped = 0, errors = 0, mutated = false;
  const changedItems = [];
  const newListings = [];

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
      if (Array.isArray(result.listings)) {
        watch.knownListingUrls = result.listings.map((l) => l.url).slice(0, 40);
      }
      continue;
    }

    if (result.hash !== watch.hash) {
      changed++;
      watch.hash = result.hash;
      watch.lastChangedAt = now;
      console.log(`  CAMBIO (búsqueda) ${watch.url}`);
      changedItems.push({ label: `Búsqueda "${watch.cargo || ""}"${watch.portalLabel ? " en " + watch.portalLabel : ""}`, url: watch.url });
    }

    // Avisos nuevos reales (solo ChileTrabajos, el único portal que este
    // servidor puede leer) — independiente del hash de arriba, que compara
    // la página completa y puede cambiar por cosas que no son un aviso nuevo
    // (orden, un botón, un contador). Acá comparamos directamente qué URLs
    // de aviso son nuevas desde el último chequeo.
    if (Array.isArray(result.listings)) {
      const known = new Set(Array.isArray(watch.knownListingUrls) ? watch.knownListingUrls : []);
      const fresh = result.listings.filter((l) => !known.has(l.url));
      if (fresh.length > 0) {
        console.log(`  ${fresh.length} aviso(s) nuevo(s) en ChileTrabajos para "${watch.cargo || ""}"`);
        fresh.forEach((l) => newListings.push({ ...l, cargo: watch.cargo || "" }));
      }
      watch.knownListingUrls = result.listings.map((l) => l.url).slice(0, 40);
    }
  }

  return { checked, changed, skipped, errors, mutated, changedItems, newListings };
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
    await sendDailyDigest(row.user_id, row.data, result.changedItems, result.newListings);
  }

  console.log(
    `Listo. Chequeadas: ${totals.checked} · Cambios detectados: ${totals.changed} · Omitidas: ${totals.skipped} · Errores: ${totals.errors}`
  );
}

main().catch((e) => {
  console.error("Fallo el chequeo de páginas vigiladas:", e);
  process.exit(1);
});
