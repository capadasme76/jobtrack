// Setup de una sola vez: crea el Plan de suscripción "JobTrack Trimestral" en
// Flow. Se corre a mano, UNA vez, localmente — nunca en producción/CI — para
// no crear el plan dos veces por accidente.
//
// Cómo correrlo (en tu terminal, con TUS keys — nunca se las pases a Claude):
//
//   FLOW_API_KEY=tu_api_key FLOW_SECRET_KEY=tu_secret_key FLOW_ENV=sandbox node scripts/setup-flow-plan.mjs
//
// Al terminar imprime el planId — ese valor (no es secreto, es solo un
// identificador) es el que va en la variable de entorno FLOW_PLAN_ID de Vercel.

import { flowPost } from "../api/_flow-client.js";

if (!process.env.FLOW_API_KEY || !process.env.FLOW_SECRET_KEY) {
  console.error("Faltan FLOW_API_KEY y/o FLOW_SECRET_KEY en el entorno de esta terminal.");
  console.error('Ejemplo: FLOW_API_KEY=xxx FLOW_SECRET_KEY=yyy FLOW_ENV=sandbox node scripts/setup-flow-plan.mjs');
  process.exit(1);
}

async function main() {
  const plan = await flowPost("/plans/create", {
    planId: "jobtrack-trimestral",
    name: "JobTrack — Plan trimestral",
    currency: "CLP",
    amount: 14000,
    interval: 3, // 3 = mensual
    interval_count: 3, // cada 3 intervalos mensuales = trimestral
    urlCallback: "https://jobtrack.cl/api/flow-payment-webhook",
  });
  console.log("Plan creado con éxito:");
  console.log(plan);
  console.log("");
  console.log(`Ahora agrega FLOW_PLAN_ID=${plan.planId} como variable de entorno en Vercel.`);
}

main().catch((e) => {
  console.error("No se pudo crear el plan:", e.message || e);
  process.exit(1);
});
