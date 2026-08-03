import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve o alias "@/*" a partir do tsconfig.json, sem plugin adicional.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    // O domínio é escrito para Europe/Lisbon. Fixar o TZ garante que um teste
    // que passa aqui passa também no CI, que corre em UTC.
    env: { TZ: "Europe/Lisbon" },
  },
});
