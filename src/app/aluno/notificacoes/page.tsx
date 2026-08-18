import { BellRing, CalendarClock, MapPin } from "lucide-react";
import type { Metadata } from "next";

import {
  MarkAllNotificationsReadButton,
  MarkNotificationReadButton,
} from "@/components/notifications/notification-list";
import { SectionTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import { formatDateTime, formatRelativeDay } from "@/lib/datetime";
import { unreadNotificationCount } from "@/lib/notifications/unread-count";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Avisos" };
export const dynamic = "force-dynamic";

const INBOX_LIMIT = 50;

/**
 * A caixa de avisos do aluno (Etapa 8A).
 *
 * O que aparece aqui é HISTÓRICO. Cada linha foi escrita no momento em que o
 * evento aconteceu, com o horário desse momento — uma aula reagendada não
 * reescreve o aviso antigo, acrescenta um novo. É isso que torna a caixa útil
 * para perceber o que mudou, e não apenas onde as coisas estão agora.
 *
 * A projeção `user_notification_records` já filtra por `auth.uid()`: nunca traz
 * o aviso de outra pessoa, nem destinatário, organização ou payload em bruto.
 */
export default async function StudentNotificationsPage() {
  await requireRole("student", "/aluno/notificacoes");
  const supabase = await createSupabaseServerClient();

  // O TOTAL POR LER VEM DA MESMA FONTE QUE O SINO.
  //
  // Derivá-lo dos 50 itens carregados dava números falsos nos dois sentidos:
  // com 137 por ler, a página dizia "50 por ler"; e se as 50 mais recentes já
  // estivessem lidas, a página dizia que não havia nada por ler — escondendo o
  // botão que era a única forma de limpar o contador do sino.
  //
  // `count: "exact"` vem na mesma resposta da lista: dá para saber que há mais
  // do que 50 sem carregar a caixa inteira, e sem uma segunda ida ao servidor.
  const [{ data, error, count }, unreadCount] = await Promise.all([
    supabase
      .from("user_notification_records")
      .select(
        "id, type, title, body, lesson_id, read_at, created_at, lesson_starts_at, location_name",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .limit(INBOX_LIMIT),
    unreadNotificationCount(),
  ]);

  if (error) {
    console.error("[AulaFlow] Falha ao carregar os avisos do aluno.", error);
    throw new Error("Não foi possível carregar os seus avisos.");
  }

  const notifications = data ?? [];
  const totalNotifications = count ?? notifications.length;
  const hasMoreThanShown = totalNotifications > notifications.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Avisos</h1>
        <p className="text-sm text-muted">
          Alterações às suas aulas, pela ordem em que aconteceram.
        </p>
      </div>

      {unreadCount > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone="brand">
            {unreadCount === 1 ? "1 por ler" : `${unreadCount} por ler`}
          </Badge>
          {/* Aparece com base no total da CONTA, e não no que coube na lista:
              um aviso por ler mais antigo do que os 50 mostrados continua a
              precisar de forma de ser limpo. */}
          <MarkAllNotificationsReadButton />
        </div>
      )}

      <section>
        <SectionTitle>Histórico</SectionTitle>
        {hasMoreThanShown && (
          <p className="mb-3 text-sm text-muted">
            A mostrar os {INBOX_LIMIT} avisos mais recentes.
          </p>
        )}
        {notifications.length === 0 ? (
          <EmptyState
            icon={BellRing}
            title="Ainda não tem avisos"
            description="Quando o seu professor marcar, mudar ou cancelar uma aula, o aviso aparece aqui."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {notifications.map((notification) => {
              const isUnread = notification.read_at === null;

              return (
                <li
                  key={notification.id}
                  data-unread={isUnread ? "true" : "false"}
                  className={`rounded-[var(--radius-card)] border bg-surface p-4 shadow-card ${
                    isUnread ? "border-brand/40" : "border-line"
                  }`}
                >
                  {/* Etiquetas em linha própria: um título ao lado de um badge
                      não cabe em 390px. */}
                  <div className="flex flex-col gap-2">
                    <p className="font-bold break-words text-ink">{notification.title}</p>
                    {/* Não confiar só na cor: quem não a distingue precisa da
                        palavra. */}
                    {isUnread && <Badge tone="brand">Por ler</Badge>}
                  </div>

                  <p className="mt-2 text-sm leading-relaxed break-words text-ink-soft">
                    {notification.body}
                  </p>

                  {notification.lesson_starts_at && (
                    <p className="mt-2 flex items-start gap-1.5 text-sm text-muted">
                      <CalendarClock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0">
                        {formatDateTime(notification.lesson_starts_at)}
                      </span>
                    </p>
                  )}

                  {notification.location_name && (
                    <p className="mt-1 flex items-start gap-1.5 text-sm text-muted">
                      <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 break-words">{notification.location_name}</span>
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted">
                      {formatRelativeDay(notification.created_at)}
                    </p>
                    {isUnread && <MarkNotificationReadButton notificationId={notification.id} />}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
