// Setup de una sola vez: crea el Plan de suscripción "JobTrack Trimestral" en
// Flow. Se corre a mano, UNA vez, localmente — nunca en producción/CI — para
// no crear el plan dos veces por accidente.
//
// Cómo correrlo — más simple que escribir un comando largo:
//   1. Crea un archivo scripts/.env.flow.local (este mismo directorio) con
//      exactamente estas dos líneas, reemplazando por tus valores reales:
//        FLOW_API_KEY=tu_api_key
//        FLOW_SECRET_KEY=tu_secret_key
//   2. Corre:  node scripts/setup-flow-plan.mjs
// Ese archivo está en .gitignore — nunca se sube al repositorio.
//
// Al terminar imprime el planId — ese valor (no es secreto, es solo un
// identificador) es el que va en la variable de entorno FLOW_PLAN_ID de Vercel.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { flowPost } from "../api/_flow-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = join(__dirname, ".env.flow.local");

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

if (!process.env.FLOW_API_KEY || !process.env.FLOW_SECRET_KEY) {
  console.error("Faltan FLOW_API_KEY y/o FLOW_SECRET_KEY.");
  console.error("Crea scripts/.env.flow.local con esas dos líneas (ver comentario arriba del archivo).");
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
