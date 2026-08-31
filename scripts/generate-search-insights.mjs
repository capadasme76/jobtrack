// Reporte semanal: cargos más buscados por la comunidad de JobTrack, según
// las búsquedas vigiladas ("Búsquedas de empleo") que cada usuario configuró.
// Solo cuenta cargos, de forma agregada — no identifica usuarios ni expone
// datos personales. Llega por correo para que se revise antes de compartir
// nada públicamente (no se publica solo).
// Corre semanalmente vía GitHub Actions — ver
// .github/workflows/generate-search-insights.yml.

import { sendEmail } from "./send-email.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Prueba temporal a 2 direcciones — volver a "capadasme@gmail.com" solo
// después de confirmar el envío de prueba.
const REPORT_TO = ["frubio16@gmail.com", "capadasme@gmail.com"];

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.");
  process.exit(1);
}

function normalizeCargo(cargo) {
  return (cargo || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function fetchAllStateRows() {
  const url = `${SUPABASE_URL}/rest/v1/jobtrack_state?select=data`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer jobtrack_state (${res.status}): ${await res.text()}`);
  return res.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toTitleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Texto listo para copiar y pegar en LinkedIn — no se publica solo, se manda
// por correo para que Cristián lo revise y lo publique cuando quiera.
function linkedinPostText(ranking, totalUsersWithSearches) {
  const top5 = ranking.slice(0, 5);
  const list = top5.map((r, i) => `${i + 1}. ${toTitleCase(r.cargo)}`).join("\n");
  return `📊 Los cargos más buscados esta semana en la comunidad JobTrack:\n\n${list}\n\nDato agregado y anónimo, entre ${totalUsersWithSearches} personas usando búsquedas vigiladas en la plataforma.\n\n¿Tu cargo está en la lista? Cuéntanos en los comentarios cómo va tu búsqueda 👇\n\n#JobTrack #BúsquedaLaboral #Empleo #Chile`;
}

function reportHtml(ranking, totalSearches, totalUsersWithSearches, linkedinText) {
  const rows = ranking
    .map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.cargo)}</td><td>${r.count}</td></tr>`)
    .join("");
  return `
    <p><strong>Texto listo para LinkedIn</strong> (cópialo y publícalo si te parece bien):</p>
    <pre style="white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:6px;font-family:inherit;">${escapeHtml(linkedinText)}</pre>
    <p>Reporte semanal de cargos más buscados — ${totalSearches} búsquedas vigiladas activas, entre ${totalUsersWithSearches} cuentas.</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>#</th><th>Cargo</th><th>Menciones</th></tr>
      ${rows}
    </table>
    <p>Dato agregado y anónimo — no identifica usuarios individuales.</p>
  `;
}

async function main() {
  const rows = await fetchAllStateRows();
  const counts = new Map();
  let totalSearches = 0;
  let usersWithSearches = 0;

  for (const row of rows) {
    const searches = Array.isArray(row.data && row.data.watchedSearches) ? row.data.watchedSearches : [];
    if (searches.length > 0) usersWithSearches++;
    for (const w of searches) {
      const key = normalizeCargo(w.cargo);
      if (!key) continue;
      totalSearches++;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const ranking = Array.from(counts.entries())
    .map(([cargo, count]) => ({ cargo, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  console.log(`Filas revisadas: ${rows.length} · Búsquedas totales: ${totalSearches} · Cuentas con búsquedas: ${usersWithSearches}`);
  ranking.forEach((r, i) => console.log(`${i + 1}. ${r.cargo} — ${r.count}`));

  if (ranking.length === 0) {
    console.log("Sin datos suficientes todavía — no se envía reporte.");
    return;
  }

  const linkedinText = linkedinPostText(ranking, usersWithSearches);
  await sendEmail({
    to: REPORT_TO,
    subject: `📊 JobTrack — cargos más buscados esta semana`,
    html: reportHtml(ranking, totalSearches, usersWithSearches, linkedinText),
  });
  console.log(`Reporte enviado a ${REPORT_TO}.`);
}

main().catch((e) => {
  console.error("Fallo al generar el reporte de búsquedas:", e);
  process.exit(1);
});
