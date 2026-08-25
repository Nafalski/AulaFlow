import { afterEach, describe, expect, it, vi } from "vitest";

const PUBLIC_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon-key-with-safe-test-length",
};

async function loadEnv(nodeEnv: string, siteUrl?: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PUBLIC_ENV.NEXT_PUBLIC_SUPABASE_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", PUBLIC_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", siteUrl ?? "");

  return import("./env");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("environment configuration", () => {
  it("uses localhost only as an explicit non-production fallback", async () => {
    const { getSiteUrl } = await loadEnv("development");

    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("requires NEXT_PUBLIC_SITE_URL in production", async () => {
    const { getPublicEnv } = await loadEnv("production");

    expect(() => getPublicEnv()).toThrowError(/NEXT_PUBLIC_SITE_URL/);
  });

  it("accepts an explicit production site URL", async () => {
    const { getSiteUrl } = await loadEnv("production", "https://aulaflow.example/");

    expect(getSiteUrl()).toBe("https://aulaflow.example");
  });
});
