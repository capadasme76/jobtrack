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
//
// BUG REAL ya encontrado y corregido acá (2026-09-02), en dos partes:
//
// 1) Este script no forzaba el ambiente de Flow, así que dependía de que
//    FLOW_ENV=production ya estuviera en el entorno de quien lo corría — no
//    lo estaba (no había forma de saberlo, no estaba documentado en ningún
//    lado), así que el plan quedó creado en el ambiente de PRUEBAS de Flow
//    (sandbox) en vez del real. Por eso los cobros de $14.000 nunca se
//    generaban aunque el resto del pago (registro de tarjeta, $50 CLP) sí
//    funcionaba — ese otro paso no depende de ningún plan, este sí. Este
//    Plan es siempre para el sitio real, así que ahora se fija
//    FLOW_ENV=production a la fuerza, sin depender de nada más.
//
// 2) Ese fix (y la lectura de .env.flow.local de abajo) tenían que dejar de
//    usar "import" normal para _flow-client.js: en JavaScript los imports se
//    adelantan y se evalúan ANTES que cualquier otra línea del archivo,
//    aunque estén escritos más abajo en el texto — así que asignar
//    process.env.FLOW_ENV (o los valores de .env.flow.local) arriba del
//    import no tenía ningún efecto real, _flow-client.js ya había leído
//    process.env vacío para entonces (confirmado con una prueba mínima
//    aparte, no adivinado). La solución es un import "dinámico" — el que
//    se usa más abajo — que sí espera a que el código de arriba termine
//    antes de cargar _flow-client.js.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = join(__dirname, ".env.flow.local");

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

process.env.FLOW_ENV = "production";

if (!process.env.FLOW_API_KEY || !process.env.FLOW_SECRET_KEY) {
  console.error("Faltan FLOW_API_KEY y/o FLOW_SECRET_KEY.");
  console.error("Crea scripts/.env.flow.local con esas dos líneas (ver comentario arriba del archivo).");
  process.exit(1);
}

async function main() {
  const { flowPost } = await import("../api/_flow-client.js");
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
