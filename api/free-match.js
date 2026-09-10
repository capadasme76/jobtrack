// Comparación gratuita de un CV contra un aviso de trabajo, SIN cuenta.
// Es el destino de toda la campaña de entrada, así que tiene tres cuidados:
//   1. No guarda nada. El texto del CV se usa para esta llamada y no se persiste
//      en ninguna parte — eso es parte de la promesa que hace la página.
//   2. Limita por IP (3 al día) para que una llamada anónima a la IA no se
//      convierta en un costo abierto. Si falta la key de servicio de Supabase,
//      no bloquea: deja pasar y registra un aviso en el log.
//   3. A quien no está logueado no le pide a la IA el plan de cambios concreto
//      (sale más barato y es lo que queda del otro lado de la cuenta).
// La API key de Anthropic vive solo acá, nunca llega al navegador.

import crypto from "node:crypto";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";

const MODEL = "claude-haiku-4-5-20251001";
const LIMITE_DIARIO = 3;

const MAX_AVISO = 12000;
const MAX_CV = 25000;

function tool(conPlan) {
  const properties = {
    cargoDetectado: {
      type: "string",
      description: "El cargo que busca el aviso, tal como lo nombra el aviso. Máximo 6 palabras.",
    },
    porcentajeMatch: {
      type: "integer",
      description:
        "Qué tan cerca está este CV de lo que pide el aviso, de 0 a 100. Sé riguroso y realista: 100 solo si cumple todo lo excluyente y casi todo lo deseable. No infles el número para agradar.",
    },
    avisoDeclaraRequisitos: {
      type: "boolean",
      description:
        "true solo si el aviso enumera requisitos concretos (experiencia, estudios, idiomas, herramientas). false si es apenas un título, una descripción genérica de la empresa o un texto sin requisitos — en ese caso no inventes requisitos para llenar la lista.",
    },
    resumenUnaLinea: {
      type: "string",
      description:
        "Una sola oración, en segunda persona y en positivo, que le diga a la persona dónde está parada. Nunca empieces con una negación ni con la palabra 'no'. Ejemplo de tono: 'Tienes la experiencia que piden; lo que falta es que tu CV lo diga con las palabras del aviso.'",
    },
    requisitos: {
      type: "array",
      description:
        "SOLO los requisitos que el aviso declara de forma explícita, en el orden de importancia que le da el aviso, con los excluyentes primero. Entre 5 y 8 cuando el aviso los enumera; menos —incluso ninguno— cuando el aviso no los declara. Está prohibido inferir requisitos habituales del cargo que el aviso no menciona.",
      items: {
        type: "object",
        properties: {
          requisito: { type: "string", description: "El requisito en pocas palabras, como lo pide el aviso." },
          estado: {
            type: "string",
            enum: ["tienes", "parcial", "falta"],
            description:
              "'tienes' si el CV lo demuestra con claridad; 'parcial' si algo lo insinúa pero no está explícito o le falta respaldo; 'falta' si no aparece en ninguna parte del CV.",
          },
          detalle: {
            type: "string",
            description:
              "Una oración explicando por qué, citando lo que sí dice el CV cuando corresponda. En segunda persona, sin reprochar.",
          },
        },
        required: ["requisito", "estado", "detalle"],
      },
    },
  };

  if (conPlan) {
    properties.tresCambios = {
      type: "array",
      description: "Los tres cambios concretos de mayor impacto para este CV y este aviso.",
      items: {
        type: "object",
        properties: {
          titulo: { type: "string", description: "El cambio, en pocas palabras." },
          comoHacerlo: {
            type: "string",
            description:
              "Instrucción concreta y accionable, incluyendo cuando corresponda la frase exacta sugerida para escribir en el CV.",
          },
        },
        required: ["titulo", "comoHacerlo"],
      },
    };
  }

  return {
    name: "comparar_cv_vacante",
    description: "Compara un CV con un aviso de trabajo y devuelve el resultado estructurado.",
    input_schema: {
      type: "object",
      properties,
      required: conPlan
        ? ["cargoDetectado", "porcentajeMatch", "avisoDeclaraRequisitos", "resumenUnaLinea", "requisitos", "tresCambios"]
        : ["cargoDetectado", "porcentajeMatch", "avisoDeclaraRequisitos", "resumenUnaLinea", "requisitos"],
    },
  };
}

const SYSTEM = `Eres el analista de match de JobTrack. Comparas el CV de una persona con un aviso de trabajo chileno y le dices con precisión qué pide el aviso, qué de eso ya tiene y qué le falta.

Reglas que no se rompen:
- Nunca inventes experiencia, títulos ni habilidades que no estén en el texto del CV.
- Habla en segunda persona, en español de Chile, directo y sin adornos.
- Abre siempre en positivo: nombra primero lo que la persona tiene. El problema queda implícito, nunca como reproche.
- No prometas resultados de contratación ni des a entender que conseguirá el trabajo.
- NUNCA agregues un requisito que el aviso no declara explícitamente. Está prohibido completar la lista con los requisitos típicos del cargo: si el aviso no los pide, no existen para este análisis. Es el error más grave que puedes cometer acá, porque hace que la persona cambie su CV para cumplir algo que nadie pidió.
- Si el aviso no declara requisitos, marca avisoDeclaraRequisitos en false, devuelve solo lo poco que el aviso sí dice (aunque sean dos ítems o ninguno) y dilo en el resumen. Una lista corta y verdadera vale más que una larga y verosímil.
- Cuando el aviso declara poco, el porcentaje de coincidencia tiene que reflejar esa incertidumbre en vez de dar un número que parezca preciso.
- No uses las palabras "Excel" ni "dashboard".`;

function hashIp(ip) {
  const salt = process.env.FREE_MATCH_SALT || "jobtrack-free-match";
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "desconocida";
}

// Devuelve { permitido, restantes }. Nunca lanza: si el límite no se puede
// verificar, deja pasar — es preferible un costo acotado a una página caída.
async function chequearLimite(ip) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.warn("free-match: sin SUPABASE_SERVICE_ROLE_KEY, el limite por IP esta desactivado");
    return { permitido: true, restantes: null };
  }
  const ipHash = hashIp(ip);
  const dia = new Date().toISOString().slice(0, 10);
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json",
  };
  try {
    const url = `${SUPABASE_URL}/rest/v1/rpc/registrar_uso_free_match`;
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_ip_hash: ipHash, p_dia: dia, p_limite: LIMITE_DIARIO }),
    });
    if (!r.ok) {
      console.warn("free-match: no se pudo verificar el limite", r.status, await r.text());
      return { permitido: true, restantes: null };
    }
    const usos = Number(await r.json());
    if (!Number.isFinite(usos)) return { permitido: true, restantes: null };
    return { permitido: usos <= LIMITE_DIARIO, restantes: Math.max(0, LIMITE_DIARIO - usos) };
  } catch (e) {
    console.warn("free-match: error verificando el limite", e);
    return { permitido: true, restantes: null };
  }
}

async function usuarioLogueado(req) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? u : null;
  } catch {
    return null;
  }
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

  const { avisoText, cvText } = req.body || {};
  // Pegar el link en vez del texto es el error más común. Si llega una URL, el
  // modelo no tiene nada que comparar y se inventa los requisitos típicos del
  // cargo — se ve razonable y es falso. Se corta acá, además del chequeo del
  // navegador, para que ninguna llamada a la IA salga con una URL por aviso.
  if (typeof avisoText === "string" && /^https?:\/\/\S+$/i.test(avisoText.trim())) {
    res.status(400).json({
      error:
        "Eso es el link del aviso, no el aviso. Todavía no podemos leerlo desde un link: abre el aviso en el portal, copia el texto completo con los requisitos y pégalo en el cuadro.",
    });
    return;
  }

  // Un aviso real con requisitos rara vez baja de 500 caracteres. Con un título
  // suelto el modelo no tiene nada que comparar y termina inventando los
  // requisitos típicos del cargo — se ve razonable y es falso. Preferimos no
  // responder antes que responder de adivinanza.
  if (!avisoText || typeof avisoText !== "string" || avisoText.trim().length < 250) {
    res.status(400).json({
      error:
        "Ese aviso está muy corto — parece solo el título. Necesitamos el texto completo, con la descripción y los requisitos, que es la parte que se compara. Vuelve al portal, copia todo el aviso y pégalo de nuevo.",
    });
    return;
  }
  if (!cvText || typeof cvText !== "string" || cvText.trim().length < 200) {
    res.status(400).json({ error: "No se pudo leer texto suficiente de tu CV. Prueba pegándolo como texto." });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en el servidor." });
    return;
  }

  const user = await usuarioLogueado(req);

  if (!user) {
    const { permitido, restantes } = await chequearLimite(clientIp(req));
    if (!permitido) {
      res.status(429).json({
        error: "limite",
        mensaje:
          "Ya usaste las tres comparaciones gratis de hoy. Con una cuenta las tienes sin límite, y además se guardan junto a cada postulación.",
      });
      return;
    }
    res.setHeader("X-Free-Match-Restantes", String(restantes ?? ""));
  }

  const conPlan = Boolean(user);

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: conPlan ? 2000 : 1400,
        temperature: 0,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: [tool(conPlan)],
        tool_choice: { type: "tool", name: "comparar_cv_vacante" },
        messages: [
          {
            role: "user",
            content: `Compara este CV con este aviso.\n\n<aviso>\n${avisoText.slice(0, MAX_AVISO)}\n</aviso>\n\n<cv>\n${cvText.slice(0, MAX_CV)}\n</cv>`,
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("free-match: Anthropic API error", aiRes.status, errText);
      res.status(502).json({ error: "El servicio de IA no respondió correctamente. Inténtalo de nuevo en un minuto." });
      return;
    }

    const aiData = await aiRes.json();
    const toolUse = (aiData.content || []).find((b) => b.type === "tool_use");
    if (!toolUse) {
      res.status(502).json({ error: "No se pudo estructurar la respuesta. Inténtalo de nuevo." });
      return;
    }

    const out = { ...toolUse.input, conPlan };
    if (!conPlan) delete out.tresCambios;
    res.status(200).json(out);
  } catch (e) {
    console.error("free-match error:", e);
    res.status(500).json({ error: "Error inesperado comparando el CV." });
  }
}
