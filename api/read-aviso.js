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

const ENTIDADES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "\u2013", mdash: "\u2014",
  hellip: "\u2026", laquo: "\u00ab", raquo: "\u00bb", ldquo: "\u201c", rdquo: "\u201d",
  aacute: "\u00e1", eacute: "\u00e9", iacute: "\u00ed", oacute: "\u00f3", uacute: "\u00fa",
  Aacute: "\u00c1", Eacute: "\u00c9", Iacute: "\u00cd", Oacute: "\u00d3", Uacute: "\u00da",
  ntilde: "\u00f1", Ntilde: "\u00d1", uuml: "\u00fc", Uuml: "\u00dc", ordf: "\u00aa", ordm: "\u00ba",
  deg: "\u00b0", euro: "\u20ac", bull: "\u2022", middot: "\u00b7", trade: "\u2122", reg: "\u00ae",
  times: "\u00d7", divide: "\u00f7", copy: "\u00a9", sect: "\u00a7", para: "\u00b6",
  lsquo: "\u2018", rsquo: "\u2019", sbquo: "\u201a", bdquo: "\u201e", prime: "\u2032",
  minus: "-", plusmn: "\u00b1", frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be",
  iquest: "\u00bf", iexcl: "\u00a1", ccedil: "\u00e7", Ccedil: "\u00c7", szlig: "\u00df",
  agrave: "\u00e0", egrave: "\u00e8", igrave: "\u00ec", ograve: "\u00f2", ugrave: "\u00f9",
  acirc: "\u00e2", ecirc: "\u00ea", icirc: "\u00ee", ocirc: "\u00f4", ucirc: "\u00fb",
  auml: "\u00e4", ouml: "\u00f6", Auml: "\u00c4", Ouml: "\u00d6", atilde: "\u00e3", otilde: "\u00f5",
};

// Decodifica entidades con nombre y numéricas (&#243; / &#xf3;). Sin esto el
// texto llega con "&ti" y "&aacute;" sueltos en medio de las palabras.
function decodificarEntidades(t) {
  return t
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const n = parseInt(dec, 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    })
    .replace(/&([a-z]+);/gi, (m, nombre) => {
      if (nombre in ENTIDADES) return ENTIDADES[nombre];
      // Entidad con nombre que no conocemos: si se deja, aparece como "&times;"
      // en medio del aviso. Se descarta solo si es corta, para no comerse un
      // texto legítimo del tipo "I&D;".
      return nombre.length <= 8 ? " " : m;
    });
}

function limpiarHtml(html) {
  let t = html
    // los CRLF de los portales dejaban decenas de líneas vacías seguidas
    .replace(/\r\n?/g, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // los saltos de línea del aviso importan: son los que separan los requisitos
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n\u2022 ")
    .replace(/<[^>]+>/g, " ");

  t = decodificarEntidades(t);

  return t
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    // Los menús del portal son listas cuyo contenido ya se descartó (iconos,
    // enlaces vacíos) y dejaban una fila de viñetas solas.
    .filter((l) => l !== "\u2022" && l !== "\u2022 " && !/^\u2022\s*$/.test(l))
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
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
