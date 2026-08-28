// Script de diagnóstico temporal — NO es parte del checker real. Se usa una
// vez para averiguar por qué casi todas las búsquedas de ChileTrabajos
// aparecen como "cambiadas" en casi cada corrida del cron, comparando dos
// fetches seguidos de la misma URL desde el mismo runner de GitHub Actions y
// mostrando en qué bloque de texto normalizado empiezan a diferir.

const URL = "https://www.chiletrabajos.cl/encuentra-un-empleo?action=search&order_by=&ord=&within=25&2=Gerente%20de%20Marketing";
const USER_AGENT = "JobTrackWatcher/1.0 (+https://jobtrack.cl; watches pages users opted into)";

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

async function fetchRaw() {
  const res = await fetch(URL, { headers: { "User-Agent": USER_AGENT } });
  return res.text();
}

function diffFirstMismatch(a, b) {
  const chunkSize = 200;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += chunkSize) {
    const ca = a.slice(i, i + chunkSize);
    const cb = b.slice(i, i + chunkSize);
    if (ca !== cb) {
      return { index: i, a: ca, b: cb };
    }
  }
  return null;
}

(async () => {
  console.log("Fetch 1...");
  const raw1 = await fetchRaw();
  console.log("length raw1:", raw1.length);
  await new Promise((r) => setTimeout(r, 3000));
  console.log("Fetch 2...");
  const raw2 = await fetchRaw();
  console.log("length raw2:", raw2.length);
  console.log("raw identical:", raw1 === raw2);

  const norm1 = normalizeHtml(raw1);
  const norm2 = normalizeHtml(raw2);
  console.log("normalized length 1:", norm1.length, "2:", norm2.length);
  console.log("normalized identical:", norm1 === norm2);

  if (raw1 !== raw2) {
    const d = diffFirstMismatch(raw1, raw2);
    console.log("--- primer bloque distinto (RAW) ---");
    console.log("index:", d.index);
    console.log("A:", d.a);
    console.log("B:", d.b);
  }
  if (norm1 !== norm2) {
    const d = diffFirstMismatch(norm1, norm2);
    console.log("--- primer bloque distinto (NORMALIZADO) ---");
    console.log("index:", d.index);
    console.log("A:", d.a);
    console.log("B:", d.b);
  }
})();
