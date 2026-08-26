// Recibe el texto plano de un CV (ya extraído en el navegador, nunca el archivo)
// y usa Claude para separarlo en los campos que usa "Mi perfil". Requiere que quien
// llama sea un usuario real logueado en Supabase — si no, no llama a la IA (evita costos
// por llamadas anónimas). La API key de Anthropic vive solo acá, nunca llega al navegador.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";

const EXTRACT_TOOL = {
  name: "extract_profile",
  description: "Extrae campos de perfil profesional a partir del texto de un CV.",
  input_schema: {
    type: "object",
    properties: {
      nombre: { type: "string", description: "Nombre completo de la persona." },
      tituloProfesional: { type: "string", description: "Título/cargo profesional corto, ej. 'Gerente de Comunicaciones'." },
      resumen: { type: "string", description: "Resumen profesional de 3 a 5 oraciones, en español, tono profesional." },
      habilidades: { type: "array", items: { type: "string" }, description: "Lista de habilidades o competencias clave." },
      experiencia: {
        type: "array",
        items: { type: "string" },
        description: "Una entrada por experiencia laboral, cada una en el formato exacto 'Cargo | Empresa | Período | Descripción breve'."
      },
      formacion: {
        type: "array",
        items: { type: "string" },
        description: "Una entrada por cada título, diplomado, postgrado, magíster, doctorado, certificación o curso relevante que aparezca en el CV — busca en todo el documento, no solo bajo un encabezado literal 'Educación' (puede estar bajo 'Formación académica', 'Estudios', 'Postgrados', 'Certificaciones', o mencionado suelto en el texto). Formato 'Título | Institución | Período' — si el período no aparece, usa 'Título | Institución' y omite esa parte en vez de descartar la entrada completa. Solo se deja vacío si de verdad no hay ninguna mención a formación en todo el CV."
      },
      linkedinUrl: { type: "string", description: "URL de LinkedIn si aparece en el CV, si no, string vacío." }
    },
    required: ["nombre", "resumen", "habilidades", "experiencia", "formacion"]
  }
};

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
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

  const { cvText } = req.body || {};
  if (!cvText || typeof cvText !== "string" || cvText.trim().length < 30) {
    res.status(400).json({ error: "No se pudo leer texto suficiente del archivo." });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en el servidor." });
    return;
  }

  try {
    const truncated = cvText.slice(0, 20000);
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        temperature: 0,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: "extract_profile" },
        messages: [
          {
            role: "user",
            content: `Extrae los datos de perfil profesional de este CV. No inventes datos que no estén en el texto — si un campo no aparece, déjalo vacío o como lista vacía. Presta especial atención a "formacion": revisa todo el documento buscando estudios, títulos, diplomados, postgrados o certificaciones, aunque no estén bajo un encabezado exacto llamado "Educación" — es un error común dejarla vacía cuando sí hay datos de formación en el texto, solo en otro formato.\n\n---\n${truncated}\n---`,
          },
        ],
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
      res.status(502).json({ error: "No se pudo estructurar la respuesta de la IA." });
      return;
    }

    res.status(200).json(toolUse.input);
  } catch (e) {
    console.error("extract-cv error:", e);
    res.status(500).json({ error: "Error inesperado procesando el CV." });
  }
}
