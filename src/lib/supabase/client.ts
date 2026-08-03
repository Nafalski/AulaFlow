"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getPublicEnv } from "@/lib/env";
import type { Database } from "@/types/database";

let client: ReturnType<typeof createBrowserClient<Database>> | null = null;

/**
 * Cliente Supabase para o browser.
 *
 * Criado apenas na primeira chamada, e não ao carregar o módulo. Isso importa
 * porque `next build` avalia módulos ao pré-renderizar, e nessa altura as
 * variáveis de ambiente podem legitimamente não existir.
 *
 * A autenticação da Fase 1 é toda feita em Server Actions, pelo que este
 * cliente só será usado a partir da Fase 8 (notificações em tempo real).
 */
export function createSupabaseBrowserClient() {
  if (client) return client;

  const env = getPublicEnv();
  client = createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  return client;
}
