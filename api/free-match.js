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
    avisoDeclaraRequisitos: {
      type: "boolean",
      description:
        "true solo si el aviso enumera requisitos concretos (experiencia, estudios, idiomas, herramientas). false si es apenas un título, una descripción genérica de la empresa o un texto sin requisitos — en ese caso no inventes requisitos para llenar la lista.",
    },
    excluyentesFaltantes: {
      type: "integer",
      description:
        "Cuántos requisitos EXCLUYENTES del aviso la persona no cumple de verdad (no cuenta los que sí cumple pero su CV no menciona). Si el aviso no marca cuáles son excluyentes, cuenta los que cualquier reclutador trataría como condición de entrada: título requerido, años de experiencia en la función, idioma pedido como excluyente, y la función o el rubro central del cargo.",
    },
    porcentajeCalce: {
      type: "integer",
      description:
        "De 0 a 100: qué tanto la persona REALMENTE cumple lo que el aviso pide, sin importar si su CV lo dice bien o mal. Está anclado por bandas y por topes duros que no se pueden pasar — están en las instrucciones. Nunca lo subas para agradar.",
    },
    porcentajeDemostrado: {
      type: "integer",
      description:
        "De 0 a 100: cuánto de ese calce el CV DEMUESTRA por escrito, con las palabras que un lector o un filtro automático encontrarían. Siempre menor o igual que porcentajeCalce. La diferencia entre los dos es lo que la persona pierde por redacción y no por perfil.",
    },
    bandaAccion: {
      type: "string",
      enum: ["postula-hoy", "postula-ajustando", "solo-si-demuestras", "poco-probable", "otra-familia"],
      description:
        "La banda de acción que corresponde a porcentajeCalce según la escala de las instrucciones. Tiene que ser coherente con el número y con excluyentesFaltantes.",
    },
    veredicto: {
      type: "string",
      description:
        "Una oración que le dice a la persona qué hacer con este aviso, en segunda persona. En las bandas bajas hay que decirlo derecho —que le conviene guardar la energía para otro aviso— sin dramatizar y sin dejarla sin salida. Nunca insinúes que la persona no sirve: el juicio es sobre el calce con ESTE aviso.",
    },
    resumenUnaLinea: {
      type: "string",
      description:
        "Una sola oración, en segunda persona y abriendo por lo que la persona SÍ tiene, que explique dónde está parada. Nunca empieces con una negación ni con la palabra 'no'.",
    },
    requisitos: {
      type: "array",
      description:
        "SOLO los requisitos que el aviso declara de forma explícita, en el orden de importancia que le da el aviso, con los excluyentes primero. Entre 5 y 8 cuando el aviso los enumera; menos —incluso ninguno— cuando el aviso no los declara. Está prohibido inferir requisitos habituales del cargo que el aviso no menciona.",
      items: {
        type: "object",
        properties: {
          requisito: { type: "string", description: "El requisito en pocas palabras, como lo pide el aviso." },
          excluyente: {
            type: "boolean",
            description: "true si el aviso lo marca como excluyente, o si es una condición de entrada evidente del cargo.",
          },
          estado: {
            type: "string",
            enum: ["tienes", "tienes-no-dicho", "no-tienes", "aviso-vago"],
            description:
              "'tienes' = el CV lo demuestra con claridad. 'tienes-no-dicho' = por la trayectoria se deduce que la persona lo tiene, pero el CV no lo dice con las palabras que se buscarían (es un problema de redacción, no de perfil). 'no-tienes' = de verdad no está en su experiencia. 'aviso-vago' = el aviso lo pide de forma tan imprecisa que no se puede evaluar. Distinguir 'tienes-no-dicho' de 'no-tienes' es lo más valioso de todo el análisis: no las mezcles.",
          },
          detalle: {
            type: "string",
            description:
              "Una oración explicando por qué, citando lo que el CV sí dice cuando corresponda. En segunda persona, sin reprochar. Si el estado es 'tienes-no-dicho', di qué habría que escribir para que se vea.",
          },
        },
        required: ["requisito", "excluyente", "estado", "detalle"],
      },
    },
  };

  if (conPlan) {
    properties.tresCambios = {
      type: "array",
      description:
        "Los tres cambios concretos de mayor impacto para este CV y este aviso, priorizando los requisitos en estado 'tienes-no-dicho', que son los que se arreglan escribiendo.",
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

  const base = [
    "cargoDetectado",
    "avisoDeclaraRequisitos",
    "excluyentesFaltantes",
    "porcentajeCalce",
    "porcentajeDemostrado",
    "bandaAccion",
    "veredicto",
    "resumenUnaLinea",
    "requisitos",
  ];

  return {
    name: "comparar_cv_vacante",
    description: "Compara un CV con un aviso de trabajo y devuelve el resultado estructurado.",
    input_schema: {
      type: "object",
      properties,
      required: conPlan ? base.concat("tresCambios") : base,
    },
  };
}

const SYSTEM = `Eres el analista de match de JobTrack. Comparas el CV de una persona con un aviso de trabajo chileno y le dices con precisión qué pide el aviso, qué de eso ya tiene, qué le falta y qué debería hacer.

Tu sesgo por defecto tiene que ser el RIGOR, no la amabilidad. Un puntaje inflado hace que la persona postule, no le contesten y pierda semanas sin saber nunca que nos equivocamos: el daño es invisible para nosotros y cae entero en ella. Un puntaje duro, en cambio, se puede discutir mirando la lista de requisitos. Ante la duda, el número más bajo.

ESCALA ANCLADA de porcentajeCalce — las bandas no son decorativas, definen el número:
- 85 a 100 (postula-hoy): cumple todo lo excluyente y casi todo lo deseable.
- 70 a 84 (postula-ajustando): cumple todo lo excluyente; le falta algo deseable.
- 50 a 69 (solo-si-demuestras): le falta un excluyente, o lo tiene y su CV no lo dice.
- 30 a 49 (poco-probable): le faltan dos o más excluyentes.
- 0 a 29 (otra-familia): es otra familia de cargo o otra función.

TOPES DUROS, no negociables:
- Si excluyentesFaltantes es 1, porcentajeCalce no puede pasar de 55.
- Si excluyentesFaltantes es 2 o más, porcentajeCalce no puede pasar de 35.
- Si la función central del cargo es distinta a la trayectoria de la persona (por ejemplo ventas directas frente a comunicaciones corporativas), porcentajeCalce no puede pasar de 35 aunque comparta habilidades transversales como liderazgo o gestión de equipos.
- Si el aviso no declara requisitos, porcentajeCalce no puede pasar de 50: sin requisitos no hay nada que verificar, y un número alto sería una invención.

LOS DOS NÚMEROS:
- porcentajeCalce responde "¿tiene lo que piden?".
- porcentajeDemostrado responde "¿su CV lo demuestra por escrito?".
- La diferencia entre ambos es lo que la persona pierde por redacción y no por perfil. Es el dato más útil que entregamos, así que calcúlalo con cuidado: cada requisito en estado 'tienes-no-dicho' baja porcentajeDemostrado sin bajar porcentajeCalce.

Reglas que no se rompen:
- Nunca inventes experiencia, títulos ni habilidades que no estén en el texto del CV.
- NUNCA agregues un requisito que el aviso no declara explícitamente. Está prohibido completar la lista con los requisitos típicos del cargo: si el aviso no los pide, no existen para este análisis. Es el error más grave que puedes cometer acá, porque hace que la persona cambie su CV para cumplir algo que nadie pidió.
- Si el aviso no declara requisitos, marca avisoDeclaraRequisitos en false, devuelve solo lo poco que el aviso sí dice y dilo en el resumen.
- El número es un juicio sobre el calce con ESTE aviso, nunca sobre el valor de la persona. Sé estricto con el calce y respetuoso con quien está al otro lado.
- Habla en segunda persona, en español de Chile, directo y sin adornos.
- Abre siempre en positivo: nombra primero lo que la persona tiene. El problema queda implícito, nunca como reproche.
- No prometas resultados de contratación ni des a entender que conseguirá el trabajo.
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
        max_tokens: conPlan ? 2600 : 1900,
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
