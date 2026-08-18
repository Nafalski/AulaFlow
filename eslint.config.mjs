import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // O entrypoint do worker de email corre em Deno: `Deno.serve`, `Deno.env` e
    // importações por URL não existem no ambiente que estas regras assumem. Os
    // módulos de `_shared` continuam a ser verificados — são TypeScript puro.
    "supabase/functions/notification-email-worker/**",
  ]),
]);

export default eslintConfig;
