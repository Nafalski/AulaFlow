import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getPublicEnv } from "@/lib/env";
import { authCookieOptions } from "@/lib/supabase/cookie-options";
import type { Database } from "@/types/database";

/**
 * Renovação da sessão no `proxy.ts`.
 *
 * Os tokens de acesso do Supabase expiram ao fim de uma hora. Server
 * Components não podem escrever cookies, pelo que não conseguem guardar um
 * token renovado — sem este passo, um utilizador seria expulso de hora a hora.
 *
 * A dança de escrever nos cookies do PEDIDO e depois recriar a RESPOSTA não é
 * decorativa: o pedido tem de levar os cookies novos para o Server Component
 * que corre a seguir, e a resposta tem de os levar para o browser. Sem os dois
 * lados, ou o servidor ou o browser fica com o token antigo.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const env = getPublicEnv();

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions: authCookieOptions(),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [name, value] of Object.entries(headers)) {
            response.headers.set(name, value);
          }
        },
      },
    },
  );

  // getUser() valida o token junto do servidor de autenticação.
  // getSession() apenas descodifica o cookie e acredita nele — o que é
  // suficiente para mostrar um nome, mas nunca para decidir um acesso.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, user, supabase };
}
