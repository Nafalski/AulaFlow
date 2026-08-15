import { CalendarDays, Clock, Link2, MapPin } from "lucide-react";
import type { Metadata } from "next";

import { StudentLessonConfirmation } from "@/components/lessons/student-lesson-confirmation";
import { Card, SectionTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import {
  formatDuration,
  formatRelativeDay,
  formatTimeRange,
  formatWeekdayDate,
} from "@/lib/datetime";
import { recurringLessonLabel } from "@/lib/domain/lesson-scheduling";
import { LESSON_STATUS_META } from "@/lib/domain/lesson-status";
import { BILLING_STATUS_META } from "@/lib/domain/packages";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { firstName } from "@/lib/utils";

export const metadata: Metadata = { title: "Próximas aulas" };
export const dynamic = "force-dynamic";

const UPCOMING_LIMIT = 8;
// Teto de segurança da lista de pendentes; ninguém tem 50 aulas por responder.
const AWAITING_LIMIT = 50;

export default async function StudentHomePage() {
  const user = await requireRole("student");

  // `studentId` só existe depois de a conta ser ligada à ficha criada pelo
  // professor. Sem essa ligação não há aulas para mostrar — e o aluno precisa
  // de saber porquê, senão conclui que a aplicação está avariada.
  const isLinked = user.studentId !== null;

  // A projeção já filtra por `current_student_id()`: nunca traz a aula de
  // outro aluno, e não tem colegas, turma, IDs de pacote nem custo em créditos.
  // Duas leituras, e não uma com limite maior.
  //
  // A lista curta é o que o aluno vê primeiro. Mas uma aula que PEDE resposta
  // não pode ficar inalcançável só por ser a nona: o RSVP tem prazo, e a pessoa
  // não devia ter de adivinhar onde encontrá-lo.
  //
  // A segunda secção mostra as que pedem confirmação e ficaram de fora da
  // primeira — incluindo as JÁ confirmadas. Filtrar só as pendentes fazia a
  // aula desaparecer no instante em que era confirmada, e quem carregou no
  // botão ficava sem ver o resultado.
  const { lessons, confirmationBeyondUpcoming } = isLinked
    ? await (async () => {
        const supabase = await createSupabaseServerClient();
        const columns =
          "id, title, starts_at, ends_at, duration_minutes, status, participation_status, requires_confirmation, billing_status, package_name, sport_name, teacher_name, location_name, location_resource_name, is_recurring, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count";
        const now = new Date().toISOString();

        const upcomingQuery = supabase
          .from("student_lesson_records")
          .select(columns)
          .gte("starts_at", now)
          .in("status", ["scheduled", "confirmed"])
          .neq("participation_status", "declined")
          .neq("participation_status", "removed")
          .order("starts_at")
          .limit(UPCOMING_LIMIT);

        const awaitingQuery = supabase
          .from("student_lesson_records")
          .select(columns)
          .gte("starts_at", now)
          .in("status", ["scheduled", "confirmed"])
          .eq("requires_confirmation", true)
          .neq("participation_status", "declined")
          .neq("participation_status", "removed")
          .order("starts_at")
          .limit(AWAITING_LIMIT);

        const [upcoming, awaiting] = await Promise.all([upcomingQuery, awaitingQuery]);

        if (upcoming.error || awaiting.error) {
          console.error(
            "[AulaFlow] Falha ao carregar as próximas aulas do aluno.",
            upcoming.error ?? awaiting.error,
          );
          throw new Error("Não foi possível carregar as suas aulas.");
        }

        const shown = new Set((upcoming.data ?? []).map((lesson) => lesson.id));
        return {
          lessons: upcoming.data ?? [],
          confirmationBeyondUpcoming: (awaiting.data ?? []).filter(
            (lesson) => !shown.has(lesson.id),
          ),
        };
      })()
    : { lessons: [], confirmationBeyondUpcoming: [] };

  return (
    <div className="flex flex-col gap-6">
      <section>
        <p className="text-sm text-muted">{formatWeekdayDate(new Date())}</p>
        <p className="mt-0.5 text-2xl font-extrabold tracking-tight text-ink">
          Olá, {firstName(user.profile.full_name)}
        </p>
      </section>

      {!isLinked && (
        <Card className="p-5">
          <div className="mb-3 flex size-11 items-center justify-center rounded-[var(--radius-field)] bg-sun-soft">
            <Link2 className="size-5.5 text-sun-deep" aria-hidden="true" />
          </div>
          <h2 className="text-base font-bold text-ink">A sua conta ainda não está ligada</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Para ver as suas aulas, o seu professor precisa de o registar com este mesmo email:{" "}
            <strong className="font-semibold text-ink">{user.email}</strong>. Assim que o fizer,
            as aulas aparecem aqui automaticamente.
          </p>
        </Card>
      )}

      <section>
        <SectionTitle>Próximas aulas</SectionTitle>
        {lessons.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="Ainda não tem aulas marcadas"
            description="Quando o seu professor marcar uma aula consigo, ela aparece aqui."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {lessons.map((lesson) => {
              const statusMeta = LESSON_STATUS_META[lesson.status];
              const billingMeta = BILLING_STATUS_META[lesson.billing_status];
              const place = [lesson.location_name, lesson.location_resource_name]
                .filter(Boolean)
                .join(" · ");
              const recurrenceLabel = recurringLessonLabel({
                isRecurring: lesson.is_recurring,
                frequency: lesson.recurrence_frequency,
                occurrenceIndex: lesson.recurrence_occurrence_index,
                occurrenceCount: lesson.recurrence_occurrence_count,
              });

              return (
                <li
                  key={lesson.id}
                  className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card"
                >
                  {/* Etiquetas em linha própria: um título longo ao lado de um
                      badge não cabe em 390px. */}
                  <div className="flex flex-col gap-2">
                    <p className="font-bold break-words text-ink">{lesson.title}</p>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                      <Badge tone="neutral">{lesson.sport_name}</Badge>
                      <Badge tone={billingMeta.tone}>{billingMeta.label}</Badge>
                      {recurrenceLabel && <Badge tone="neutral">{recurrenceLabel}</Badge>}
                    </div>
                  </div>

                  <p className="mt-3 flex items-start gap-1.5 text-sm text-muted">
                    <Clock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0">
                      {formatRelativeDay(lesson.starts_at)} ·{" "}
                      {formatTimeRange(lesson.starts_at, lesson.ends_at)} ·{" "}
                      {formatDuration(lesson.duration_minutes)}
                    </span>
                  </p>

                  {place && (
                    <p className="mt-1 flex items-start gap-1.5 text-sm text-muted">
                      <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 break-words">{place}</span>
                    </p>
                  )}

                  <p className="mt-1 text-sm text-muted">Com {lesson.teacher_name}</p>
                  {lesson.package_name && (
                    <p className="mt-1 text-sm text-muted">Pacote: {lesson.package_name}</p>
                  )}

                  <StudentLessonConfirmation
                    lessonId={lesson.id}
                    requiresConfirmation={lesson.requires_confirmation}
                    participationStatus={lesson.participation_status}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {confirmationBeyondUpcoming.length > 0 && (
        <section>
          <SectionTitle>Aulas que pedem confirmação</SectionTitle>
          <ul className="flex flex-col gap-3">
            {confirmationBeyondUpcoming.map((lesson) => (
              <li
                key={lesson.id}
                className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card"
              >
                <p className="font-bold break-words text-ink">{lesson.title}</p>
                <p className="mt-2 flex items-start gap-1.5 text-sm text-muted">
                  <Clock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">
                    {formatWeekdayDate(lesson.starts_at)} ·{" "}
                    {formatTimeRange(lesson.starts_at, lesson.ends_at)}
                  </span>
                </p>
                <StudentLessonConfirmation
                  lessonId={lesson.id}
                  requiresConfirmation={lesson.requires_confirmation}
                  participationStatus={lesson.participation_status}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-muted">
        Confirmar a participação é dizer ao professor que conta consigo. A presença é registada
        por ele depois da aula, e aparece no calendário e nos pacotes.
      </p>
    </div>
  );
}
