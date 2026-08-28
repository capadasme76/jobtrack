// Correo de bienvenida — se dispara una sola vez desde el dashboard, la
// primera vez que una cuenta nueva llega a la pantalla principal (antes de
// que el asistente de bienvenida se muestre). Autenticado con el access_token
// propio del usuario (no service_role) solo para confirmar que quien pide el
// envío es efectivamente el dueño de esa cuenta — mismo patrón que
// check-watched-search.js.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";
import { sendEmail } from "../scripts/send-email.mjs";

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

function welcomeEmailHtml() {
  return `
    <p>¡Bienvenido/a a la comunidad JobTrack!</p>
    <p>Tu cuenta ya está lista, con 7 días de prueba gratis para que explores todo el dashboard sin apuro.</p>
    <p>Para partir con el pie derecho, te recomendamos:</p>
    <ul>
      <li>Completar tu <strong>perfil</strong> — es la base para el Match CV y las cartas de presentación.</li>
      <li>Configurar tus <strong>búsquedas de empleo</strong> — para tener links listos en todos los portales.</li>
      <li>Agregar tu primera <strong>oportunidad</strong> a la agenda de postulaciones.</li>
    </ul>
    <p>Cualquier duda, responde este correo o escríbenos a hola@jobtrack.cl.</p>
    <p>Éxito en la búsqueda,<br/>El equipo de JobTrack</p>
  `;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const user = await verifySupabaseUser(accessToken);
  if (!user || !user.id || !user.email) {
    res.status(401).json({ error: "No autorizado." });
    return;
  }

  try {
    await sendEmail({
      to: user.email,
      subject: "Bienvenido/a a JobTrack",
      html: welcomeEmailHtml(),
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("send-welcome-email error:", e);
    // No bloquea al usuario por un correo que falló — solo se registra.
    res.status(200).json({ ok: false, error: e.message || String(e) });
  }
}
