"use client";

import { CheckCircle2, Flag, Undo2, Users } from "lucide-react";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/status-badge";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import {
  completeLessonAction,
  setLessonAttendanceAction,
} from "@/lib/actions/lessons";
import {
  canEditLessonAttendance,
  attendanceDisplayMeta,
  lessonCompletionAvailability,
  LESSON_ATTENDANCE_NOT_STARTED_MESSAGE,
} from "@/lib/domain/lesson-operations";
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

function AttendanceAction({
  lessonId,
  participant,
  disabled,
}: {
  lessonId: string;
  participant: Participant;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    setLessonAttendanceAction,
    FORM_ACTION_IDLE_STATE,
  );
  const isPresent = participant.attendanceStatus === "present";

  return (
    <form action={formAction} className="flex flex-col gap-2 sm:items-end">
      <input type="hidden" name="lessonId" value={lessonId} />
      <input type="hidden" name="participantId" value={participant.lessonParticipantId} />
      <input type="hidden" name="present" value={isPresent ? "false" : "true"} />
      <Button
        type="submit"
        variant={isPresent ? "ghost" : "outline"}
        size="sm"
        loading={pending}
        loadingLabel={isPresent ? "A retirar" : "A confirmar"}
        disabled={disabled}
        icon={
          isPresent ? (
            <Undo2 className="size-4" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-4" aria-hidden="true" />
          )
        }
        aria-label={
          isPresent
            ? `Retirar presença de ${participant.fullName}`
            : `Confirmar presença de ${participant.fullName}`
        }
      >
        {isPresent ? "Retirar presença" : "Confirmar presença"}
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
              "Os créditos reservados dos participantes presentes serão marcados como utilizados.",
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
  participants,
}: {
  lessonId: string;
  lessonStatus: LessonStatus;
  startsAt: Timestamp;
  endsAt: Timestamp;
  now: Timestamp;
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
  const completion = lessonCompletionAvailability({
    lessonStatus,
    endsAt,
    now,
    participants,
  });

  return (
    <Card variant="plain">
      <CardHeader
        title="Presença e conclusão"
        description="A conclusão marca os créditos reservados como utilizados."
      />
      <CardBody className="flex flex-col gap-4">
        {waitingForStart && (
          <Alert tone="info">{LESSON_ATTENDANCE_NOT_STARTED_MESSAGE}</Alert>
        )}
        {completion.message && (
          <Alert tone={completion.state === "completed" ? "success" : "info"}>
            {completion.message}
          </Alert>
        )}

        {participants.length === 0 ? (
          <p className="text-sm text-muted">Sem participantes registados.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {participants.map((participant) => {
              const billingMeta = BILLING_STATUS_META[participant.billingStatus];
              const attendanceMeta = attendanceDisplayMeta(participant.attendanceStatus);
              const packageName = packageLabel(participant);
              const quantity = quantityLabel(participant);

              return (
                <li
                  key={participant.lessonParticipantId}
                  className="grid min-h-11 gap-3 rounded-[var(--radius-field)] border border-line bg-surface px-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
                      <Users className="size-4 shrink-0 text-muted" aria-hidden="true" />
                      <span className="break-words">{participant.fullName}</span>
                    </span>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone={attendanceMeta.tone}>
                        Presença: {attendanceMeta.label}
                      </Badge>
                      <Badge tone={billingMeta.tone}>Crédito: {billingMeta.label}</Badge>
                      <Badge tone="neutral">
                        {participant.status === "confirmed" ? "Confirmado" : "Convidado"}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs leading-snug text-muted">
                      {quantity ?? "Sem movimento de crédito"}
                      {packageName ? ` · Pacote: ${packageName}` : ""}
                      {participant.isException ? " · Exceção autorizada" : ""}
                    </p>
                  </div>

                  {lessonStatus !== "completed" && (
                    <AttendanceAction
                      lessonId={lessonId}
                      participant={participant}
                      disabled={!attendanceEditable}
                    />
                  )}
                </li>
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
