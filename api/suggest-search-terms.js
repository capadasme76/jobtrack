// Propone una lista de cargos/palabras clave relacionados al perfil del usuario
// para guiar su exploración en los portales — la búsqueda deja de depender de que
// el usuario piense todos los sinónimos/variantes de cargo por su cuenta. Requiere
// un usuario real logueado en Supabase, igual que extract-cv.js.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../supabase-config.js";

const SUGGEST_TOOL = {
  name: "suggest_terms",
  description: "Propone cargos y palabras clave de búsqueda relacionados a un perfil profesional, para buscar en portales de empleo chilenos.",
  input_schema: {
    type: "object",
    properties: {
      terms: {
        type: "array",
        items: { type: "string" },
        description: "Entre 5 y 8 cargos/títulos de búsqueda en español, orientados al mercado laboral chileno: el título principal del perfil, sinónimos comunes (ej. Gerente/Jefe/Director del mismo área), variantes de seniority cercanas, y 1-2 roles adyacentes según las habilidades. Sin duplicados, cada uno listo para escribirse en un buscador de empleos tal cual.",
      },
    },
    required: ["terms"],
  },
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

  const { tituloProfesional, resumen, habilidades } = req.body || {};
  const tituloOk = typeof tituloProfesional === "string" && tituloProfesional.trim().length > 0;
  if (!tituloOk) {
    res.status(400).json({ error: "Completa al menos el título profesional en \"Mi perfil\" antes de pedir sugerencias." });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en el servidor." });
    return;
  }

  try {
    const habilidadesText = Array.isArray(habilidades) && habilidades.length ? habilidades.slice(0, 15).join(", ") : "(sin habilidades registradas)";
    const resumenText = typeof resumen === "string" && resumen.trim() ? resumen.trim().slice(0, 1500) : "(sin resumen registrado)";

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        temperature: 0.3,
        tools: [SUGGEST_TOOL],
        tool_choice: { type: "tool", name: "suggest_terms" },
        messages: [
          {
            role: "user",
            content: `Perfil profesional:\nTítulo: ${tituloProfesional.trim()}\nResumen: ${resumenText}\nHabilidades: ${habilidadesText}\n\nPropón cargos/palabras clave de búsqueda para este perfil en el mercado laboral chileno.`,
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
    if (!toolUse || !Array.isArray(toolUse.input.terms)) {
      res.status(502).json({ error: "No se pudo generar sugerencias." });
      return;
    }

    const terms = toolUse.input.terms
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter((t) => t.length > 0)
      .slice(0, 8);

    res.status(200).json({ terms });
  } catch (e) {
    console.error("suggest-search-terms error:", e);
    res.status(500).json({ error: "Error inesperado generando sugerencias." });
  }
}
