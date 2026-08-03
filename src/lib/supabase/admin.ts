import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getPublicEnv, getServiceRoleKey } from "@/lib/env";
import type { Database } from "@/types/database";

/**
 * Cliente com privilégios de service_role — IGNORA O ROW LEVEL SECURITY.
 *
 * `import "server-only"` faz a compilação FALHAR se algum Client Component
 * importar este ficheiro, direta ou indiretamente. É uma barreira em tempo de
 * compilação para o erro mais caro possível: publicar uma chave de
 * administração no bundle do browser.
 *
 * Uso legítimo (a partir da Fase 8):
 *   • enviar lembretes de 24h/2h a partir de uma tarefa agendada, quando não
 *     há utilizador autenticado e portanto o RLS não tem contexto;
 *   • processar a fila de `notification_deliveries`.
 *
 * Uso ilegítimo: qualquer operação a pedido de um utilizador. Nesse caso o
 * cliente correto é `createSupabaseServerClient()`, que respeita o RLS.
 */
export function createSupabaseAdminClient() {
  const env = getPublicEnv();

  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, getServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
