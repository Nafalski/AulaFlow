import type { NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authRedirect } from "@/lib/supabase/response";

/**
 * Terminar sessão.
 *
 * Só aceita POST. Com GET, bastaria a alguém incorporar
 * `<img src="https://aulaflow.pt/auth/sair">` num fórum para desligar a sessão
 * de quem visse a página — CSRF de baixo impacto, mas trivial de evitar.
 */
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  // 303 obriga o browser a fazer GET ao destino. Sem isto, tentaria repetir
  // o POST na página inicial.
  return authRedirect(new URL("/", request.nextUrl.origin), 303);
}
