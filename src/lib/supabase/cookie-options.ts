/**
 * O cliente de browser do Supabase precisa de ler a sessão, por isso estes
 * cookies não podem ser HttpOnly. Em produção, porém, só devem viajar por
 * HTTPS. O desenvolvimento local continua funcional em HTTP.
 */
export function authCookieOptions(nodeEnv = process.env.NODE_ENV) {
  return {
    path: "/",
    sameSite: "lax" as const,
    httpOnly: false,
    secure: nodeEnv === "production",
  };
}
