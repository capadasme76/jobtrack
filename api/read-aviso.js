// Lee un aviso de trabajo desde su link y devuelve el texto, para que la persona
// pueda pegar la URL en /revisa-tu-cv en vez de tener que copiar el aviso a mano
// (pegar el link es lo primero que hace todo el mundo).
//
// Dos cuidados que importan:
//   1. NO es un proxy de uso general. Solo abre los portales de empleo de la
//      lista de abajo — así este endpoint no se puede usar para leer sitios
//      internos, servicios en localhost ni metadatos del proveedor.
//   2. Si el texto que se extrae es muy corto, no se devuelve nada útil: se le
//      pide a la persona que pegue el texto. Un aviso a medias hace que el
//      análisis invente, que es justo lo que estamos evitando.
//
// No guarda nada: lee, devuelve el texto y termina.

const FETCH_TIMEOUT_MS = 12000;
const MAX_BYTES = 2_000_000;
const MAX_CHARS = 16000;
const MIN_CHARS_UTILES = 400;

// Portales que sí se dejan leer desde un servidor. Se compara el dominio exacto
// o un subdominio suyo — nunca por "contiene", que dejaría pasar dominios falsos
// del tipo chiletrabajos.cl.sitio-malicioso.com.
const PORTALES = [
  "chiletrabajos.cl",
  "laborum.cl",
  "trabajando.com",
  "trabajando.cl",
  "indeed.com",
  "computrabajo.cl",
  "bne.cl",
  "empleospublicos.cl",
  "getonbrd.com",
  "getonbrd.cl",
  "pegasconsentido.cl",
  "michaelpage.cl",
  "hays.cl",
  "randstad.cl",
  "adecco.cl",
];

// Sitios que sabemos que bloquean la lectura automática: conviene decirlo con
// nombre y motivo en vez de dar un error genérico.
const BLOQUEAN = [
  { dominio: "linkedin.com", nombre: "LinkedIn" },
  { dominio: "glassdoor.com", nombre: "Glassdoor" },
  { dominio: "glassdoor.cl", nombre: "Glassdoor" },
];

function dominioCoincide(hostname, dominio) {
  return hostname === dominio || hostname.endsWith(`.${dominio}`);
}

function limpiarHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // los saltos de línea del aviso importan para que se lean los requisitos
    .replace(/<\/(p|div|li|h[1-6]|tr|section|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }
  if (req.headers["x-jt-source"] !== "revisa-tu-cv") {
    res.status(400).json({ error: "Solicitud inválida." });
    return;
  }

  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Falta el link del aviso." });
    return;
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    res.status(400).json({ error: "Ese link no se entiende. Cópialo de nuevo desde la barra del navegador." });
    return;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    res.status(400).json({ error: "Ese link no se entiende. Cópialo de nuevo desde la barra del navegador." });
    return;
  }
  if (parsed.username || parsed.password) {
    res.status(400).json({ error: "Ese link no se puede abrir." });
    return;
  }

  const host = parsed.hostname.toLowerCase();

  const bloqueado = BLOQUEAN.find((b) => dominioCoincide(host, b.dominio));
  if (bloqueado) {
    res.status(422).json({
      error: "bloqueado",
      mensaje: `${bloqueado.nombre} no permite que otros sitios lean sus avisos, así que este no lo podemos abrir por ti. Abre el aviso, selecciona el texto completo —con los requisitos— y pégalo en el cuadro.`,
    });
    return;
  }

  if (!PORTALES.some((d) => dominioCoincide(host, d))) {
    res.status(422).json({
      error: "no-soportado",
      mensaje:
        "Todavía no sabemos leer avisos de ese sitio. Abre el aviso, selecciona el texto completo —con los requisitos— y pégalo en el cuadro: funciona igual de bien.",
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const pageRes = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "JobTrackReader/1.0 (+https://jobtrack.cl; lee un aviso que el usuario pidió leer)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "es-CL,es;q=0.9",
      },
    });

    if (!pageRes.ok) {
      res.status(422).json({
        error: "no-se-pudo",
        mensaje: `El portal respondió con un error (${pageRes.status}) y no pudimos leer el aviso. Copia el texto del aviso y pégalo en el cuadro.`,
      });
      return;
    }

    const largo = Number(pageRes.headers.get("content-length") || 0);
    if (largo && largo > MAX_BYTES) {
      res.status(422).json({
        error: "muy-grande",
        mensaje: "Esa página es demasiado pesada para leerla. Copia el texto del aviso y pégalo en el cuadro.",
      });
      return;
    }

    const html = (await pageRes.text()).slice(0, MAX_BYTES);
    const texto = limpiarHtml(html).slice(0, MAX_CHARS);

    if (texto.length < MIN_CHARS_UTILES) {
      res.status(422).json({
        error: "poco-texto",
        mensaje:
          "Abrimos el link pero no encontramos el texto del aviso — algunos portales lo cargan de una forma que no podemos leer desde afuera. Copia el texto del aviso y pégalo en el cuadro.",
      });
      return;
    }

    res.status(200).json({ texto, portal: host });
  } catch (e) {
    if (e && e.name === "AbortError") {
      res.status(422).json({
        error: "lento",
        mensaje: "El portal tardó demasiado en responder. Copia el texto del aviso y pégalo en el cuadro.",
      });
      return;
    }
    console.error("read-aviso error:", e);
    res.status(422).json({
      error: "no-se-pudo",
      mensaje: "No pudimos abrir ese link. Copia el texto del aviso y pégalo en el cuadro.",
    });
  } finally {
    clearTimeout(timer);
  }
}
