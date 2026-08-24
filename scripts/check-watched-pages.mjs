// Chequeo diario de "páginas de empleos" vigiladas por los usuarios.
// No extrae ni estructura vacantes: solo detecta si el contenido de una página
// pública que el propio usuario eligió vigilar cambió desde el último chequeo,
// y si cambió, deja un dispatch tipo "verificar tú" en su sección Hoy.
//
// Corre como script de Node plano (sin dependencias) vía GitHub Actions —
// ver .github/workflows/check-watched-pages.yml. Usa la service role key de
// Supabase para leer/escribir jobtrack_state directo por su API REST.

import { createHash } from "node:crypto";

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

function normalizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
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
    return { ok: true, hash: hashText(normalizeHtml(html)) };
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
  if (watchedPages.length === 0 && watchedSearches.length === 0) {
    return { checked: 0, changed: 0, skipped: 0, errors: 0, mutated: false };
  }

  if (!Array.isArray(data.dispatches)) data.dispatches = [];
  const opportunities = Array.isArray(data.opportunities) ? data.opportunities : [];

  let checked = 0, changed = 0, skipped = 0, errors = 0, mutated = false;

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
      const opp = opportunities.find((o) => o.id === watch.opportunityId);
      const empresa = opp ? opp.empresa : "una empresa que vigilas";
      data.dispatches.push({
        id: `wd${Date.now()}-${watch.opportunityId}`,
        type: "verify",
        dateline: "Cambio detectado hoy",
        headline: `Posible novedad en la página de empleos de ${empresa}`,
        empresa,
        sector: opp ? opp.sector : "Sin sector",
        meta: "Detectamos un cambio en la página que vigilas — revisa si hay una vacante nueva antes de asumir que es algo relevante.",
        link: watch.url,
      });
      console.log(`  CAMBIO ${watch.url} (${empresa})`);
    }
  }

  for (const watch of watchedSearches) {
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
      watch.hash = result.hash;
      continue;
    }

    if (result.hash !== watch.hash) {
      changed++;
      watch.hash = result.hash;
      watch.lastChangedAt = now;
      const label = watch.label || "una búsqueda que vigilas";
      data.dispatches.push({
        id: `ws${Date.now()}-${watch.id}`,
        type: "verify",
        dateline: "Cambio detectado hoy",
        headline: `Posible novedad en tu búsqueda "${label}"`,
        empresa: label,
        sector: "Sin sector",
        meta: "Detectamos un cambio en los resultados de esta búsqueda — revisa si hay una vacante nueva antes de asumir que es algo relevante.",
        link: watch.url,
      });
      console.log(`  CAMBIO (búsqueda) ${watch.url} (${label})`);
    }
  }

  return { checked, changed, skipped, errors, mutated };
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
  }

  console.log(
    `Listo. Chequeadas: ${totals.checked} · Cambios detectados: ${totals.changed} · Omitidas: ${totals.skipped} · Errores: ${totals.errors}`
  );
}

main().catch((e) => {
  console.error("Fallo el chequeo de páginas vigiladas:", e);
  process.exit(1);
});
