import type { NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authRedirect } from "@/lib/supabase/response";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Destino dos links enviados por email — confirmação de conta e recuperação
 * de palavra-passe.
 *
 * Trata as duas formas que o Supabase pode usar, consoante a configuração do
 * projeto e o modelo de email:
 *
 *   • `?code=`                 fluxo PKCE (predefinição dos clientes SSR)
 *   • `?token_hash=&type=`     modelo de email antigo, ainda comum
 *
 * Aceitar ambas evita a situação em que o registo funciona mas o link do email
 * cai numa página de erro — que é exatamente o momento em que se perde um
 * utilizador novo.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const requested = searchParams.get("proximo");

  // Só caminhos internos: um `proximo` absoluto tornaria este endpoint um
  // redirecionador aberto, útil para phishing a partir de um domínio legítimo.
  const next = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/inicio";

  const supabase = await createSupabaseServerClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return authRedirect(new URL(next, origin));
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return authRedirect(new URL(next, origin));
  }

  const failure = new URL("/entrar", origin);
  failure.searchParams.set("erro", "link_invalido");
  return authRedirect(failure);
}
