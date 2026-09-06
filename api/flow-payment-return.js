// Flow devuelve al usuario a "urlReturn" mediante un POST del navegador (no
// un GET normal) — confirmado en producción: apuntar urlReturn directo a
// jobtrack-dashboard-cristian.html (un archivo estático) daba "HTTP ERROR
// 405" porque Vercel no deja hacer POST sobre un archivo estático. Este
// endpoint solo existe para recibir ese POST y reenviar (302, que el
// navegador sigue como GET) al dashboard real — el pago en sí ya se
// confirmó por separado, server-to-server, en flow-payment-confirm.js; esto
// es solo la experiencia visual de "a dónde vuelve el navegador".

export default function handler(req, res) {
  res.redirect(302, "https://jobtrack.cl/jobtrack-dashboard-cristian.html?pago=listo");
}
