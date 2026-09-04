// Genera una carta de presentación real con IA — reemplaza el enfoque
// anterior (reemplazo de texto tipo "[CARGO]"/"[EMPRESA]" sobre la carta base
// que el usuario escribió una vez), que producía siempre el mismo resultado
// genérico sin importar el perfil real ni la vacante. Usa el perfil completo
// (resumen, experiencia, habilidades, formación) y el texto de la vacante
// pegado en Match CV, con Claude Opus para la calidad de redacción — mismo
// patrón de autenticación y tool-calling forzado que api/extract-cv.js.
//
// A propósito no inventa logros ni cifras que no estén en el perfil: si un
// dato concreto (ej. un porcentaje o monto) fortalecería la carta pero no
// está disponible, deja un marcador entre corchetes para que el usuario lo
// complete, en vez de inventarlo.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";

const LETTER_TOOL = {
  name: "generate_cover_letter",
  description: "Genera una carta de presentación profesional en español, personalizada a la vacante y basada estrictamente en la trayectoria real del candidato.",
  input_schema: {
    type: "object",
    properties: {
      carta: {
        type: "string",
        description: "Texto completo de la carta de presentación, en español (registro profesional chileno), en primera persona, lista para copiar y pegar. Sin fecha ni datos de contacto formales — solo el cuerpo, desde el saludo hasta la despedida y el nombre del candidato. 3 a 4 párrafos.",
      },
      notaPlaceholders: {
        type: "array",
        items: { type: "string" },
        description: "0 a 2 elementos: qué información específica (ej. una cifra concreta de un logro) el usuario debería revisar o completar él mismo antes de enviarla, porque no estaba disponible en su perfil. Lista vacía si no hizo falta ningún marcador.",
      },
    },
    required: ["carta", "notaPlaceholders"],
  },
};

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

function buildPrompt({ cargo, empresa, jobDescription, profile }) {
  const experiencia = (profile.experiencia || []).slice(0, 6).join("\n");
  const formacion = (profile.formacion || []).slice(0, 4).join("\n");
  const habilidades = (profile.habilidades || []).join(", ");

  return `Escribe una carta de presentación para esta postulación.

CARGO AL QUE POSTULA: ${cargo || "(no especificado)"}
EMPRESA: ${empresa || "(no especificada)"}

${jobDescription ? `TEXTO DE LA VACANTE (usa esto para conectar la experiencia del candidato con lo que pide el aviso, sin copiarlo literalmente):\n${jobDescription.slice(0, 4000)}\n` : ""}

PERFIL REAL DEL CANDIDATO — usa solo esta información, no inventes nada que no esté acá:
Título profesional: ${profile.tituloProfesional || ""}
Resumen: ${profile.resumen || ""}
Habilidades: ${habilidades}
Experiencia laboral:
${experiencia}
Formación académica:
${formacion}

Instrucciones:
- Conecta 2 o 3 elementos concretos de la experiencia/habilidades reales del candidato con lo que pide la vacante — no generalidades vacías tipo "soy muy responsable y proactivo".
- Nunca inventes cifras, logros o datos específicos que no aparezcan en el perfil. Si un dato así (ej. "aumenté las ventas en X%") fortalecería la carta, deja un marcador entre corchetes en el texto (ej. "[agrega aquí la cifra concreta de cuánto mejoraste X]") y regístralo también en notaPlaceholders — máximo 2 marcadores en total.
- Español de Chile, registro profesional pero natural, sin clichés de plantilla ("Estimados señores, es un placer dirigirme a ustedes...").
- 3 a 4 párrafos.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const user = await verifySupabaseUser(accessToken);
  if (!user || !user.id) {
    res.status(401).json({ error: "No autorizado. Inicia sesión e intenta de nuevo." });
    return;
  }

  const { cargo, empresa, jobDescription, profile } = req.body || {};
  if (!profile || !profile.resumen) {
    res.status(400).json({ error: "Falta completar tu perfil (al menos el resumen profesional) antes de generar una carta." });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en el servidor." });
    return;
  }

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 4096,
        tools: [LETTER_TOOL],
        tool_choice: { type: "tool", name: "generate_cover_letter" },
        messages: [{ role: "user", content: buildPrompt({ cargo, empresa, jobDescription, profile }) }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("Anthropic API error:", aiRes.status, errText);
      res.status(502).json({ error: "El servicio de IA no respondió correctamente." });
      return;
    }

    const aiData = await aiRes.json();
    const toolUse = (aiData.content || []).find((b) => b.type === "tool_use");
    if (!toolUse) {
      res.status(502).json({ error: "No se pudo generar la carta." });
      return;
    }

    res.status(200).json(toolUse.input);
  } catch (e) {
    console.error("generate-cover-letter error:", e);
    res.status(500).json({ error: "Error inesperado generando la carta." });
  }
}
