// Endpoint de una sola vez para crear el Plan de suscripción en Flow,
// reusando las variables de entorno que ya están configuradas en Vercel
// (FLOW_API_KEY/FLOW_SECRET_KEY/FLOW_ENV) — así nadie tiene que volver a
// escribir esas claves en ningún lado. Se llama UNA vez, visitando la URL en
// el navegador, y después este archivo se borra del proyecto (no debe quedar
// como endpoint público permanente).
//
// Si el plan ya existe (segundo intento accidental), Flow responde con un
// error de negocio "ya existe" — se detecta y se informa en vez de fallar feo.

import { flowPost } from "./_flow-client.js";

export default async function handler(req, res) {
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
