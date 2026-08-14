"use client";

import { Ban, CheckCircle2, CircleX, Flag, Undo2, UserMinus, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/status-badge";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import type { TeacherManagementActionState } from "@/lib/actions/teacher-management";
import {
  cancelLessonAction,
  cancelLessonParticipantAction,
  completeLessonAction,
  setLessonAttendanceAction,
} from "@/lib/actions/lessons";
import {
  LESSON_ABSENCE_CREDIT_WARNING,
  LESSON_ATTENDANCE_NOT_ENDED_MESSAGE,
  LESSON_ATTENDANCE_NOT_STARTED_MESSAGE,
  LESSON_CANCEL_CONFIRMATION_MESSAGE,
  RECURRING_LESSON_CANCEL_NOTICE,
  attendanceDisplayMeta,
  canCancelLesson,
  canEditLessonAttendance,
  canMarkLessonAbsence,
  lessonCompletionAvailability,
  lessonParticipationCancellationAvailability,
} from "@/lib/domain/lesson-operations";
import { PARTICIPANT_STATUS_META } from "@/lib/domain/lesson-status";
import { BILLING_STATUS_META } from "@/lib/domain/packages";
import type {
  AttendanceStatus,
  LessonStatus,
  ParticipantStatus,
  ParticipationBillingStatus,
} from "@/types/database";

type Timestamp = string;

type Participant = {
  lessonParticipantId: string;
  studentId: string;
  fullName: string;
  status: ParticipantStatus;
  declinedAt: Timestamp | null;
  attendanceStatus: AttendanceStatus | null;
  attendanceMarkedAt: Timestamp | null;
  billingStatus: ParticipationBillingStatus;
  creditsReserved: number;
  creditsConsumed: number;
  packageName: string | null;
  packageSportName: string | null;
  isException: boolean;
};

function creditsLabel(value: number): string {
  return `${value} crédito${value === 1 ? "" : "s"}`;
}

function packageLabel(participant: Participant): string | null {
  if (!participant.packageName) return null;
  return `${participant.packageName}${
    participant.packageSportName ? ` (${participant.packageSportName})` : ""
  }`;
}

function quantityLabel(participant: Participant): string | null {
  if (participant.creditsReserved > 0) {
    return `${creditsLabel(participant.creditsReserved)} reservados`;
  }

  if (participant.creditsConsumed > 0) {
    return `${creditsLabel(participant.creditsConsumed)} utilizados`;
  }

  return null;
}


/**
 * Pede o repintar da rota DEPOIS de a mutação ter respondido.
 *
 * Enquanto a revalidação viajava dentro da resposta da Action, um stream RSC
 * abortado deixava a operação eternamente em pending — com a alteração já
 * gravada. Agora são dois tempos: a Action resolve, o botão liberta-se, e só
 * então se pede `router.refresh()`.
 *
 * `router.refresh()` funde a nova payload sem destruir estado de cliente, pelo
 * que o resultado confirmado que se mostra por baixo sobrevive à atualização.
 *
 * O `useRef` guarda o último estado já tratado: sem ele, cada repintar
 * provocado pelo refresh voltaria a disparar outro refresh, em ciclo.
 */
function useRefreshAfterAction(state: TeacherManagementActionState) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const handled = useRef<TeacherManagementActionState | null>(null);

  useEffect(() => {
    if (state.status !== "success" || handled.current === state) return;
    handled.current = state;
    startTransition(() => router.refresh());
  }, [state, router, startTransition]);
}

function AttendanceAction({
  lessonId,
  participant,
  disabled,
  attendanceStatus,
  label,
  loadingLabel,
  ariaLabel,
  variant = "outline",
  icon,
  onConfirmed,
}: {
  lessonId: string;
  participant: Participant;
  disabled: boolean;
  attendanceStatus: "present" | "absent" | null;
  label: string;
  loadingLabel: string;
  ariaLabel: string;
  variant?: "primary" | "outline" | "ghost" | "danger";
  icon: ReactNode;
  onConfirmed: (status: AttendanceStatus | null) => void;
}) {
  const [state, formAction, pending] = useActionState(
    setLessonAttendanceAction,
    FORM_ACTION_IDLE_STATE,
  );
  useRefreshAfterAction(state);

  const reported = useRef<TeacherManagementActionState | null>(null);
  useEffect(() => {
    if (state.status !== "success" || reported.current === state) return;
    reported.current = state;
    if (state.confirmed?.operation === "attendance") onConfirmed(state.confirmed.attendance);
  }, [state, onConfirmed]);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="lessonId" value={lessonId} />
      <input type="hidden" name="participantId" value={participant.lessonParticipantId} />
      <input type="hidden" name="attendanceStatus" value={attendanceStatus ?? "unconfirmed"} />
      <Button
        type="submit"
        variant={variant}
        size="sm"
        loading={pending}
        loadingLabel={loadingLabel}
        disabled={disabled}
        icon={icon}
        aria-label={ariaLabel}
      >
        {label}
      </Button>
      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}
    </form>
  );
}


/**
 * Uma linha de participante, com o desfecho confirmado a cobrir a janela entre
 * a resposta da mutação e a chegada dos props frescos.
 *
 * O valor mostrado é sempre o que o SERVIDOR confirmou — nunca um palpite
 * otimista. Antes da resposta o botão está em pending; depois dela mostra-se o
 * que ficou gravado. Quando o refresh traz props novos, eles coincidem.
 */
function ParticipantAttendanceControls({
  lessonId,
  participant,
  attendanceEditable,
  absenceEditable,
  onConfirmed,
}: {
  lessonId: string;
  participant: Participant;
  attendanceEditable: boolean;
  absenceEditable: boolean;
  onConfirmed: (status: AttendanceStatus | null) => void;
}) {
  const status = participant.attendanceStatus;
  const shown = participant;
  const setConfirmed = onConfirmed;

  return (
    <div className="flex flex-wrap gap-2 lg:justify-end">
      <AttendanceAction
        lessonId={lessonId}
        participant={shown}
        attendanceStatus="present"
        label="Presente"
        loadingLabel="A marcar"
        disabled={!attendanceEditable}
        icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
        ariaLabel={`Marcar ${participant.fullName} como presente`}
        variant={status === "present" ? "primary" : "outline"}
        onConfirmed={setConfirmed}
      />
      <AttendanceAction
        lessonId={lessonId}
        participant={shown}
        attendanceStatus="absent"
        label="Falta"
        loadingLabel="A marcar"
        disabled={!absenceEditable}
        icon={<Ban className="size-4" aria-hidden="true" />}
        ariaLabel={`Marcar ${participant.fullName} como falta`}
        variant={status === "absent" ? "danger" : "outline"}
        onConfirmed={setConfirmed}
      />
      {status !== null && (
        <AttendanceAction
          lessonId={lessonId}
          participant={shown}
          attendanceStatus={null}
          label="Não confirmado"
          loadingLabel="A limpar"
          disabled={!attendanceEditable}
          icon={<Undo2 className="size-4" aria-hidden="true" />}
          ariaLabel={`Voltar a deixar ${participant.fullName} sem confirmação`}
          variant="ghost"
          onConfirmed={setConfirmed}
        />
      )}
    </div>
  );
}


/**
 * Uma linha de participante.
 *
 * Detém o desfecho CONFIRMADO pelo servidor, para cobrir a janela entre a
 * resposta da mutação e a chegada dos props frescos do `router.refresh()`.
 * A etiqueta e os botões leem o mesmo valor, por isso nunca se contradizem.
 *
 * Nada aqui é otimista: antes da resposta o botão está em pending; só depois
 * de a base de dados confirmar é que este estado muda.
 */
function ParticipantRow({
  lessonId,
  lessonStatus,
  participant,
  attendanceEditable,
  absenceEditable,
  isGroupLesson,
  cancellationAvailability,
  participantActive,
}: {
  lessonId: string;
  lessonStatus: LessonStatus;
  participant: Participant;
  attendanceEditable: boolean;
  absenceEditable: boolean;
  isGroupLesson: boolean;
  cancellationAvailability: { canCancel: boolean; message?: string | null };
  participantActive: boolean;
}) {
  const [confirmed, setConfirmed] = useState<AttendanceStatus | null | undefined>(undefined);
  const shownParticipant: Participant =
    confirmed === undefined ? participant : { ...participant, attendanceStatus: confirmed };

  const billingMeta = BILLING_STATUS_META[shownParticipant.billingStatus];
  const attendanceMeta = attendanceDisplayMeta(shownParticipant.attendanceStatus);
  const participantMeta = PARTICIPANT_STATUS_META[shownParticipant.status];
  const packageName = packageLabel(shownParticipant);
  const quantity = quantityLabel(shownParticipant);

  return (
                <li
                  className="grid min-h-11 gap-3 rounded-[var(--radius-field)] border border-line bg-surface px-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
                      <Users className="size-4 shrink-0 text-muted" aria-hidden="true" />
                      <span className="break-words">{shownParticipant.fullName}</span>
                    </span>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone={attendanceMeta.tone}>
                        Presença: {attendanceMeta.label}
                      </Badge>
                      <Badge tone={billingMeta.tone}>Crédito: {billingMeta.label}</Badge>
                      <Badge tone={participantMeta.tone}>{participantMeta.label}</Badge>
                    </div>
                    <p className="mt-2 text-xs leading-snug text-muted">
                      {quantity ?? "Sem movimento de crédito"}
                      {packageName ? ` · Pacote: ${packageName}` : ""}
                      {shownParticipant.isException ? " · Exceção autorizada" : ""}
                    </p>
                    {shownParticipant.attendanceStatus === "absent" &&
                      lessonStatus !== "completed" && (
                        <p className="mt-2 text-xs leading-snug text-state-warning">
                          {LESSON_ABSENCE_CREDIT_WARNING}
                        </p>
                      )}
                    {shownParticipant.status === "declined" && (
                      <p className="mt-2 text-xs leading-snug text-muted">
                        Participação cancelada nesta etapa. Não pode ser reativada aqui.
                      </p>
                    )}
                  </div>

                  {canCancelLesson(lessonStatus) && (
                    <div className="flex flex-col gap-2 lg:items-end">
                      {participantActive && (
                        <ParticipantAttendanceControls
                          lessonId={lessonId}
                          participant={shownParticipant}
                          attendanceEditable={attendanceEditable}
                          absenceEditable={absenceEditable}
                          onConfirmed={setConfirmed}
                        />
                      )}
                      {isGroupLesson && participantActive && (
                        <>
                          <CancelParticipantForm
                            lessonId={lessonId}
                            participant={shownParticipant}
                            disabled={!cancellationAvailability.canCancel}
                          />
                          {!cancellationAvailability.canCancel && (
                            <p className="max-w-60 text-right text-xs leading-snug text-muted">
                              {cancellationAvailability.message}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
  );
}

function CancelLessonForm({
  lessonId,
  disabled,
  isRecurring,
}: {
  lessonId: string;
  disabled: boolean;
  isRecurring: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    cancelLessonAction,
    FORM_ACTION_IDLE_STATE,
  );
  useRefreshAfterAction(state);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        const message = isRecurring
          ? `${LESSON_CANCEL_CONFIRMATION_MESSAGE}\n\n${RECURRING_LESSON_CANCEL_NOTICE}`
          : LESSON_CANCEL_CONFIRMATION_MESSAGE;
        if (!window.confirm(message)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="lessonId" value={lessonId} />
      <Button
        type="submit"
        variant="danger"
        loading={pending}
        loadingLabel="A cancelar"
        disabled={disabled}
        icon={<CircleX className="size-4" aria-hidden="true" />}
      >
        Cancelar aula
      </Button>
      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}
    </form>
  );
}

function CancelParticipantForm({
  lessonId,
  participant,
  disabled,
}: {
  lessonId: string;
  participant: Participant;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    cancelLessonParticipantAction,
    FORM_ACTION_IDLE_STATE,
  );
  useRefreshAfterAction(state);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        if (
          !window.confirm(
            [
              `Cancelar a participação de ${participant.fullName}?`,
              "",
              "O crédito reservado será devolvido e a participação não poderá ser reativada nesta etapa.",
            ].join("\n"),
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="lessonId" value={lessonId} />
      <input type="hidden" name="participantId" value={participant.lessonParticipantId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        loading={pending}
        loadingLabel="A cancelar"
        disabled={disabled}
        icon={<UserMinus className="size-4" aria-hidden="true" />}
        aria-label={`Cancelar participação de ${participant.fullName}`}
      >
        Cancelar participação
      </Button>
      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}
    </form>
  );
}

function CompleteLessonForm({
  lessonId,
  disabled,
}: {
  lessonId: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    completeLessonAction,
    FORM_ACTION_IDLE_STATE,
  );
  useRefreshAfterAction(state);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        if (
          !window.confirm(
            [
              "Concluir esta aula?",
              "",
              "Os créditos reservados dos participantes presentes ou em falta serão marcados como utilizados.",
              "Esta ação não pode ser desfeita nesta etapa.",
            ].join("\n"),
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="lessonId" value={lessonId} />
      <Button
        type="submit"
        loading={pending}
        loadingLabel="A concluir"
        disabled={disabled}
        icon={<Flag className="size-4" aria-hidden="true" />}
      >
        Concluir aula
      </Button>
      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}
    </form>
  );
}

export function LessonAttendancePanel({
  lessonId,
  lessonStatus,
  startsAt,
  endsAt,
  now,
  isGroupLesson,
  isRecurring,
  participants,
}: {
  lessonId: string;
  lessonStatus: LessonStatus;
  startsAt: Timestamp;
  endsAt: Timestamp;
  now: Timestamp;
  isGroupLesson: boolean;
  isRecurring: boolean;
  participants: Participant[];
}) {
  const attendanceEditable = canEditLessonAttendance({
    lessonStatus,
    startsAt,
    now,
  });
  const waitingForStart =
    (lessonStatus === "scheduled" || lessonStatus === "confirmed") &&
    new Date(now).getTime() < new Date(startsAt).getTime();
  const waitingForEnd =
    (lessonStatus === "scheduled" || lessonStatus === "confirmed") &&
    new Date(now).getTime() < new Date(endsAt).getTime();
  const absenceEditable = canMarkLessonAbsence({ lessonStatus, endsAt, now });
  const activeParticipantCount = participants.filter(
    (participant) => participant.status !== "removed" && participant.status !== "declined",
  ).length;
  const completion = lessonCompletionAvailability({
    lessonStatus,
    endsAt,
    now,
    participants,
  });

  return (
    <Card variant="plain">
      <CardHeader
        title="Presença, cancelamento e conclusão"
        description="Cancelamentos devolvem reservas. Presenças e faltas consomem ao concluir."
      />
      <CardBody className="flex flex-col gap-4">
        {waitingForStart && (
          <Alert tone="info">{LESSON_ATTENDANCE_NOT_STARTED_MESSAGE}</Alert>
        )}
        {waitingForEnd && !waitingForStart && (
          <Alert tone="info">{LESSON_ATTENDANCE_NOT_ENDED_MESSAGE}</Alert>
        )}
        {completion.message && (
          <Alert tone={completion.state === "completed" ? "success" : "info"}>
            {completion.message}
          </Alert>
        )}
        {canCancelLesson(lessonStatus) && (
          <div className="flex flex-col gap-2 border-b border-line pb-4">
            {isRecurring && (
              <Alert tone="info">{RECURRING_LESSON_CANCEL_NOTICE}</Alert>
            )}
            <CancelLessonForm
              lessonId={lessonId}
              disabled={participants.some((participant) => participant.attendanceStatus !== null)}
              isRecurring={isRecurring}
            />
            {participants.some((participant) => participant.attendanceStatus !== null) && (
              <p className="text-xs leading-snug text-muted">
                Remova os registos de presença/falta antes de cancelar esta aula.
              </p>
            )}
          </div>
        )}

        {participants.length === 0 ? (
          <p className="text-sm text-muted">Sem participantes registados.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {participants.map((participant) => {
              // As etiquetas passaram a ser derivadas dentro de `ParticipantRow`,
              // que é quem conhece o desfecho confirmado pelo servidor.
              const participantActive =
                participant.status !== "removed" && participant.status !== "declined";
              const cancellationAvailability = lessonParticipationCancellationAvailability({
                lessonStatus,
                startsAt,
                now,
                isGroupLesson,
                activeParticipantCount,
                participantStatus: participant.status,
              });

              return (
                <ParticipantRow
                  key={participant.lessonParticipantId}
                  lessonId={lessonId}
                  lessonStatus={lessonStatus}
                  participant={participant}
                  attendanceEditable={attendanceEditable}
                  absenceEditable={absenceEditable}
                  isGroupLesson={isGroupLesson}
                  cancellationAvailability={cancellationAvailability}
                  participantActive={participantActive}
                />
              );
            })}
          </ul>
        )}

        {lessonStatus !== "completed" && (
          <div className="border-t border-line pt-4">
            <CompleteLessonForm lessonId={lessonId} disabled={!completion.canComplete} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}
