// Cliente compartido para la API REST de Flow.cl (pagos, Fase D.3/D.3.1).
// No es un endpoint propio (el "_" al inicio evita que Vercel lo trate como
// una ruta) — lo importan create-checkout.js y flow-payment-confirm.js.
//
// Documentación fuente: https://www.flow.cl/docs/api.html (spec OpenAPI
// descargada y revisada el 2026-08-27 y 2026-09-02, no adivinada).
//
// Env vars requeridas (nunca hardcodeadas, mismo patrón que ANTHROPIC_API_KEY):
//   FLOW_API_KEY, FLOW_SECRET_KEY — desde "Mi cuenta" en Flow (sandbox o producción).
//   FLOW_ENV — "sandbox" (default) o "production".

import { createHmac } from "node:crypto";

const FLOW_API_KEY = process.env.FLOW_API_KEY;
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;
const FLOW_BASE_URL = process.env.FLOW_ENV === "production" ? "https://www.flow.cl/api" : "https://sandbox.flow.cl/api";

// Firma: se ordenan los parámetros (menos "s") alfabéticamente por nombre de
// clave, se concatenan como "clave1valor1clave2valor2...", y se firma ese
// string con HMAC-SHA256 usando el secretKey. Documentado tal cual en la
// sección "¿Cómo firmar con su SecretKey?" de la doc de Flow.
function sign(params) {
  const keys = Object.keys(params).sort();
  const toSign = keys.map((k) => `${k}${params[k]}`).join("");
  return createHmac("sha256", FLOW_SECRET_KEY).update(toSign).digest("hex");
}

function withSignature(params) {
  const signed = { ...params, apiKey: FLOW_API_KEY };
  signed.s = sign(signed);
  return signed;
}

export async function flowGet(path, params) {
  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) throw new Error("Faltan FLOW_API_KEY / FLOW_SECRET_KEY en el entorno.");
  const signed = withSignature(params);
  const qs = new URLSearchParams(signed).toString();
  const res = await fetch(`${FLOW_BASE_URL}${path}?${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`Flow ${path} respondió ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export async function flowPost(path, params) {
  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) throw new Error("Faltan FLOW_API_KEY / FLOW_SECRET_KEY en el entorno.");
  const signed = withSignature(params);
  const body = new URLSearchParams(signed).toString();
  const res = await fetch(`${FLOW_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Flow ${path} respondió ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
