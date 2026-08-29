// Monitoreo técnico básico de JobTrack: revisa que el sitio y las funciones
// críticas del servidor sigan respondiendo, y avisa por correo apenas algo
// falle (no manda correo si todo está bien, para no generar ruido).
// Corre como script de Node plano vía GitHub Actions — ver
// .github/workflows/check-site-health.yml. No requiere claves de Supabase ni
// de Flow: solo hace peticiones HTTP normales a las URLs públicas del sitio.

import { sendEmail } from "./send-email.mjs";

const ALERT_TO = "capadasme@gmail.com";
const TIMEOUT_MS = 10000;

// Para las funciones que exigen sesión, "funciona bien" significa que
// responda 401 (rechaza por falta de autorización) — un 500 o timeout
// significa que la función se está cayendo internamente, que es lo que
// realmente queremos detectar acá.
const CHECKS = [
  { name: "Home pública", url: "https://jobtrack.cl/", method: "GET", expect: [200] },
  { name: "Login", url: "https://jobtrack.cl/login.html", method: "GET", expect: [200] },
  { name: "Dashboard", url: "https://jobtrack.cl/jobtrack-dashboard-cristian.html", method: "GET", expect: [200] },
  { name: "API: create-checkout", url: "https://jobtrack.cl/api/create-checkout", method: "POST", expect: [401] },
  { name: "API: check-watched-search", url: "https://jobtrack.cl/api/check-watched-search", method: "POST", expect: [401, 400] },
  { name: "API: extract-cv", url: "https://jobtrack.cl/api/extract-cv", method: "POST", expect: [401, 400] },
];

async function runCheck(check) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(check.url, { method: check.method, signal: controller.signal });
    if (!check.expect.includes(res.status)) {
      return { ...check, ok: false, detail: `HTTP ${res.status} (se esperaba ${check.expect.join(" o ")})` };
    }
    return { ...check, ok: true };
  } catch (e) {
    return { ...check, ok: false, detail: e.name === "AbortError" ? `Sin respuesta en ${TIMEOUT_MS / 1000}s` : (e.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

function alertHtml(failures) {
  const items = failures.map((f) => `<li><strong>${f.name}</strong> (${f.url}) — ${f.detail}</li>`).join("");
  return `<p>El chequeo automático de JobTrack encontró ${failures.length} problema(s):</p><ul>${items}</ul><p>Revisa los Logs de Vercel para más detalle.</p>`;
}

async function main() {
  const results = await Promise.all(CHECKS.map(runCheck));
  const failures = results.filter((r) => !r.ok);

  results.forEach((r) => {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name} — ${r.url}${r.ok ? "" : " — " + r.detail}`);
  });

  if (failures.length > 0) {
    try {
      await sendEmail({
        to: ALERT_TO,
        subject: `⚠️ JobTrack: ${failures.length} problema(s) técnico(s) detectado(s)`,
        html: alertHtml(failures),
      });
      console.log(`Alerta enviada a ${ALERT_TO}.`);
    } catch (e) {
      console.error("No se pudo enviar la alerta por correo:", e.message || e);
      process.exit(1);
    }
    process.exit(1);
  }
  console.log("Todo OK.");
}

main().catch((e) => {
  console.error("Fallo el chequeo de salud:", e);
  process.exit(1);
});
