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
const REPORT_TO = ["capadasme@gmail.com", "pamesanchezv@gmail.com"];

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

// Plantilla con la identidad visual de JobTrack (violeta #7C5CFC, layout
// limpio) — se aplica sola cada semana, no requiere trabajo manual de diseño.
function reportHtml(ranking, totalSearches, totalUsersWithSearches, linkedinText) {
  const maxCount = ranking.length ? ranking[0].count : 1;
  const rows = ranking
    .map((r, i) => {
      const pct = Math.max(8, Math.round((r.count / maxCount) * 100));
      return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #EAE9E9;font-family:Helvetica,Arial,sans-serif;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="28" style="font-family:Helvetica,Arial,sans-serif;font-weight:700;color:#7C5CFC;font-size:14px;">${i + 1}</td>
              <td style="font-family:Helvetica,Arial,sans-serif;font-size:14.5px;color:#201E1D;">
                ${escapeHtml(toTitleCase(r.cargo))}
                <div style="background:#EAE9E9;height:6px;border-radius:3px;margin-top:5px;max-width:340px;">
                  <div style="background:#7C5CFC;height:6px;border-radius:3px;width:${pct}%;"></div>
                </div>
              </td>
              <td width="40" align="right" style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#605D5D;">${r.count}</td>
            </tr>
          </table>
        </td>
      </tr>`;
    })
    .join("");

  return `
  <meta charset="utf-8">
  <div style="background:#F3F2F2;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #D7D3D3;">
      <tr><td style="padding:24px 28px;border-bottom:3px solid #7C5CFC;">
        <span style="font-family:Helvetica,Arial,sans-serif;font-weight:800;font-size:19px;color:#201E1D;">JobTrack<span style="color:#7C5CFC;">.</span></span>
      </td></tr>
      <tr><td style="padding:28px;">
        <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:20px;margin:0 0 4px;color:#201E1D;">📊 Cargos más buscados esta semana</h1>
        <p style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#605D5D;margin:0 0 22px;">${totalSearches} búsquedas vigiladas activas, entre ${totalUsersWithSearches} cuentas.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        <p style="font-family:Helvetica,Arial,sans-serif;font-size:11.5px;color:#9B9797;margin:20px 0 0;">Dato agregado y anónimo — no identifica usuarios individuales.</p>
      </td></tr>
      <tr><td style="padding:0 28px 28px;">
        <div style="background:#F0EBFF;border:1px solid #7C5CFC;padding:16px;">
          <p style="font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:13px;color:#3D2A99;margin:0 0 10px;">Texto listo para LinkedIn</p>
          <pre style="white-space:pre-wrap;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#201E1D;margin:0;line-height:1.5;">${escapeHtml(linkedinText)}</pre>
        </div>
      </td></tr>
      <tr><td style="padding:16px 28px;background:#F3F2F2;">
        <p style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#9B9797;margin:0;">JobTrack — jobtrack.cl</p>
      </td></tr>
    </table>
  </div>
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
