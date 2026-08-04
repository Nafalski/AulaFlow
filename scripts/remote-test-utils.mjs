import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EXPECTED_PROJECT_REF =
  process.env.AULAFLOW_SUPABASE_PROJECT_REF ?? "fzkwacnpydoqhxipcvro";

export function loadDotenvLocal(root) {
  const path = join(root, ".env.local");
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, name, rawValue] = match;
    if (process.env[name] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[name] = value;
  }
}

export function requireDevelopmentConfirmation() {
  const confirmed =
    process.argv.includes("--confirm-development") ||
    process.env.AULAFLOW_REMOTE_VERIFY === "development";

  if (!confirmed) {
    throw new Error(
      "Confirme explicitamente o ambiente de desenvolvimento com --confirm-development.",
    );
  }
}

export function assertLinkedProject(root) {
  const path = join(root, "supabase", ".temp", "project-ref");
  let linkedProjectRef = "";
  try {
    linkedProjectRef = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error("Projeto Supabase ainda nao ligado. Execute `npx supabase link --project-ref ...`.");
  }

  if (linkedProjectRef !== EXPECTED_PROJECT_REF) {
    throw new Error(
      `Projeto ligado inesperado: ${linkedProjectRef}. Esperado: ${EXPECTED_PROJECT_REF}.`,
    );
  }

  return linkedProjectRef;
}

export function requireEnv(name, { secret = false } = {}) {
  const value = process.env[name]?.trim();
  if (!value) {
    const kind = secret ? "segredo local" : "variavel local";
    throw new Error(`${kind} em falta: ${name}`);
  }
  return value;
}

export function optionalEnv(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export function maskId(id) {
  if (!id) return "n/a";
  return `${id.slice(0, 8)}...`;
}

export function isoDatePlusDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function deterministicUuid(input) {
  let hash1 = 0x811c9dc5;
  let hash2 = 0x9e3779b9;

  for (let index = 0; index < input.length; index++) {
    const char = input.charCodeAt(index);
    hash1 ^= char;
    hash1 = Math.imul(hash1, 0x01000193) >>> 0;
    hash2 ^= char + index;
    hash2 = Math.imul(hash2, 0x85ebca6b) >>> 0;
  }

  const hex = `${hash1.toString(16).padStart(8, "0")}${hash2
    .toString(16)
    .padStart(8, "0")}${Math.imul(hash1 ^ hash2, 0xc2b2ae35)
    .toString(16)
    .padStart(8, "0")}${Math.imul(hash2 ^ 0xa5a5a5a5, 0x27d4eb2f)
    .toString(16)
    .padStart(8, "0")}`.slice(0, 32);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${
    (8 + (Number.parseInt(hex[16], 16) % 4)).toString(16)
  }${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function summarizeError(error) {
  if (!error) return "erro desconhecido";
  if (typeof error === "string") return error;
  return error.message ?? error.error_description ?? error.code ?? JSON.stringify(error);
}
