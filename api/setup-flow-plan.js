// Endpoint de una sola vez para crear el Plan de suscripción en Flow,
// reusando las variables de entorno que ya están configuradas en Vercel
// (FLOW_API_KEY/FLOW_SECRET_KEY/FLOW_ENV) — así nadie tiene que volver a
// escribir esas claves en ningún lado. Se llama UNA vez, visitando la URL en
// el navegador, y después este archivo se borra del proyecto (no debe quedar
// como endpoint público permanente).
//
// Si el plan ya existe (segundo intento accidental), Flow responde con un
// error de negocio "ya existe" — se detecta y se informa en vez de fallar feo.
//
// Modo diagnóstico (?diag=1): en vez de crear el plan, prueba las mismas
// FLOW_API_KEY/FLOW_SECRET_KEY contra sandbox.flow.cl y www.flow.cl con una
// llamada de solo lectura (customer/list), para saber a cuál de los dos
// ambientes pertenecen esas claves sin que el valor pase nunca por un
// comando ni un campo fuera de Vercel.

import { createHmac } from "node:crypto";
import { flowPost } from "./_flow-client.js";

const FLOW_API_KEY = process.env.FLOW_API_KEY;
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;

function sign(params) {
  const keys = Object.keys(params).sort();
  const toSign = keys.map((k) => `${k}${params[k]}`).join("");
  return createHmac("sha256", FLOW_SECRET_KEY).update(toSign).digest("hex");
}

async function testEnv(baseUrl) {
  const params = { apiKey: FLOW_API_KEY };
  params.s = sign(params);
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${baseUrl}/customer/list?${qs}`);
  const data = await res.json().catch(() => ({}));
  return { baseUrl, status: res.status, data };
}

export default async function handler(req, res) {
  if (req.query && req.query.diag) {
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      res.status(200).json({ ok: false, error: "Faltan FLOW_API_KEY / FLOW_SECRET_KEY en el entorno de Vercel." });
      return;
    }
    const [sandbox, produccion] = await Promise.all([
      testEnv("https://sandbox.flow.cl/api"),
      testEnv("https://www.flow.cl/api"),
    ]);
    res.status(200).json({ ok: true, sandbox, produccion, flowEnvVar: process.env.FLOW_ENV || "(no seteada, default sandbox)" });
    return;
  }

  try {
    const plan = await flowPost("/plans/create", {
      planId: "jobtrack-trimestral",
      name: "JobTrack — Plan trimestral",
      currency: "CLP",
      amount: 14000,
      interval: 3, // 3 = mensual
      interval_count: 3, // cada 3 intervalos mensuales = trimestral
      urlCallback: "https://jobtrack.cl/api/flow-payment-webhook",
    });
    res.status(200).json({
      ok: true,
      plan,
      nextStep: `Agrega FLOW_PLAN_ID=${plan.planId} en Vercel, luego borra este archivo (api/setup-flow-plan.js).`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
