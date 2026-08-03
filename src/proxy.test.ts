import { describe, expect, it } from "vitest";
import { NextResponse } from "next/server";

import { authRedirect } from "./lib/supabase/response";
import { redirectWithSession } from "./proxy";

describe("redirectWithSession", () => {
  it("preserva cookies renovados e cabeçalhos que impedem cache partilhada", () => {
    const sessionResponse = NextResponse.next();
    sessionResponse.cookies.set("sb-access-token", "renovado", {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
    sessionResponse.headers.set(
      "Cache-Control",
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    sessionResponse.headers.set("Expires", "0");
    sessionResponse.headers.set("Pragma", "no-cache");

    const response = redirectWithSession(
      new URL("https://aulaflow.test/inicio"),
      sessionResponse,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://aulaflow.test/inicio");
    expect(response.cookies.get("sb-access-token")).toMatchObject({
      value: "renovado",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });
});

describe("authRedirect", () => {
  it("marca callbacks e saídas como respostas privadas e não armazenáveis", () => {
    const response = authRedirect(new URL("https://aulaflow.test/inicio"), 303);

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });
});
