import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve o alias "@/*" a partir do tsconfig.json, sem plugin adicional.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.ts",
      // Os módulos partilhados do worker de email vivem junto da Edge Function,
      // e não em `src`, porque é lá que ela os importa. São TypeScript puro,
      // sem nada de Deno, exatamente para poderem ser testados aqui.
      "supabase/functions/**/*.{test,spec}.ts",
    ],
    // O domínio é escrito para Europe/Lisbon. Fixar o TZ garante que um teste
    // que passa aqui passa também no CI, que corre em UTC.
    env: { TZ: "Europe/Lisbon" },
  },
});
