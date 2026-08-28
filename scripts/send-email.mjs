// Envío de correos transaccionales de JobTrack vía la API HTTP de Resend
// (fetch directo, sin agregar dependencia — mismo patrón que el resto de los
// scripts, que hablan REST directo contra Supabase). Requiere la env var
// RESEND_API_KEY (secret de GitHub Actions, igual que SUPABASE_SERVICE_ROLE_KEY).
// El dominio remitente (jobtrack.cl) debe estar verificado en la cuenta de
// Resend (SPF/DKIM) o los correos no se van a entregar aunque la llamada a
// la API responda OK.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = "JobTrack <hola@jobtrack.cl>";

export async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    throw new Error("Falta RESEND_API_KEY en el entorno.");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend respondió ${res.status}: ${errText}`);
  }
  return res.json();
}
