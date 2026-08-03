import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getPublicEnv } from "@/lib/env";
import type { Database } from "@/types/database";

/**
 * Cliente Supabase para Server Components, Server Actions e Route Handlers.
 *
 * A sessão viaja em cookies geridos pelo `@supabase/ssr`. Não se força
 * `HttpOnly`: a biblioteca precisa de manter compatibilidade com o cliente de
 * browser. Os Server Components e Actions usam este cliente para não transportar
 * tokens em props, formulários ou estado React.
 *
 * Criar um cliente por pedido é intencional: um cliente partilhado entre
 * pedidos misturaria as sessões de utilizadores diferentes.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const env = getPublicEnv();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components não podem escrever cookies — o Next lança aqui.
            // Não é um erro: a renovação do token acontece no proxy.ts, que
            // corre antes e tem permissão para escrever a resposta e os
            // cabeçalhos privados/no-store exigidos numa renovação.
          }
        },
      },
    },
  );
}
