import { NextResponse } from "next/server";

/**
 * Respostas que criam, renovam ou removem cookies de autenticação não podem ser
 * guardadas por uma CDN ou proxy partilhado.
 */
export function authRedirect(url: URL, status: 303 | 307 = 307) {
  const response = NextResponse.redirect(url, { status });
  response.headers.set(
    "Cache-Control",
    "private, no-cache, no-store, must-revalidate, max-age=0",
  );
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
}
