import { describe, expect, it } from "vitest";

import { authCookieOptions } from "./cookie-options";

describe("Supabase auth cookie options", () => {
  it("requires HTTPS in production", () => {
    expect(authCookieOptions("production")).toMatchObject({
      httpOnly: false,
      sameSite: "lax",
      secure: true,
    });
  });

  it("allows the local HTTP development server", () => {
    expect(authCookieOptions("development").secure).toBe(false);
  });
});
