import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Quantos avisos o próprio utilizador ainda não leu (Etapa 8A).
 *
 * Uma RPC que devolve um inteiro, e não a caixa inteira: isto corre em todas as
 * páginas autenticadas, e trazer 50 linhas para as contar seria pagar caro por
 * um número. A RPC filtra por `auth.uid()` — ninguém conta as de mais ninguém.
 *
 * Uma falha aqui não pode partir a navegação: sem o número, o sino aparece sem
 * contador e a pessoa continua a poder abrir os avisos.
 */
export async function unreadNotificationCount(): Promise<number> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("unread_notification_count");

    if (error) {
      console.error("[AulaFlow] Falha ao contar os avisos por ler.", error);
      return 0;
    }

    return typeof data === "number" ? data : 0;
  } catch (error) {
    console.error("[AulaFlow] Erro inesperado ao contar os avisos por ler.", error);
    return 0;
  }
}
