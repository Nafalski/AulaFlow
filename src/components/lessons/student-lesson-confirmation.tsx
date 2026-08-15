"use client";

import { CalendarCheck, CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FORM_ACTION_IDLE_STATE, preserveFormValuesOnReset } from "@/lib/actions/action-state";
import { confirmLessonParticipationAction } from "@/lib/actions/lessons";
import type { TeacherManagementActionState } from "@/lib/actions/teacher-management";
import type { ParticipantStatus } from "@/types/database";

/**
 * RSVP do aluno (Etapa 7B).
 *
 * A PALAVRA IMPORTA. Diz "Confirmar que vou", e nunca "Confirmar presença": a
 * presença é o registo factual que o professor faz DEPOIS da aula, e confundir
 * as duas coisas na interface acabaria por confundi-las na cabeça de quem lê o
 * código a seguir. O contrato técnico continua a chamar-lhe participação.
 *
 * NÃO MOSTRA NADA QUANDO A AULA NÃO PEDE CONFIRMAÇÃO. `invited` é também o
 * estado inicial de todas as outras aulas — mostrar "por responder" nessas seria
 * inventar uma pergunta que ninguém fez.
 */
export function StudentLessonConfirmation({
  lessonId,
  requiresConfirmation,
  participationStatus,
}: {
  lessonId: string;
  requiresConfirmation: boolean;
  participationStatus: ParticipantStatus;
}) {
  const [state, formAction, pending] = useActionState(
    confirmLessonParticipationAction,
    FORM_ACTION_IDLE_STATE,
  );

  useRefreshAfterConfirmation(state);

  if (!requiresConfirmation) return null;
  if (participationStatus === "declined" || participationStatus === "removed") return null;

  // O servidor já confirmou. Mostra-se o estado final aqui mesmo, sem esperar
  // que a rota volte a ser lida — a lição da 6B.2.
  const confirmed = participationStatus === "confirmed" || state.status === "success";

  if (confirmed) {
    return (
      <p className="mt-3 inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-state-success-soft px-3 py-1.5 text-sm font-semibold text-state-success">
        <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
        Participação confirmada
      </p>
    );
  }

  return (
    <form action={formAction} onReset={preserveFormValuesOnReset} className="mt-3">
      <input type="hidden" name="lessonId" value={lessonId} />

      <p className="text-sm font-semibold text-ink">Confirma que vai participar?</p>

      {state.status === "error" && state.message && (
        <p role="alert" className="mt-1.5 text-sm font-medium text-state-danger">
          {state.message}
        </p>
      )}

      <Button
        type="submit"
        size="sm"
        loading={pending}
        loadingLabel="A confirmar"
        disabled={pending}
        className="mt-2"
      >
        <CalendarCheck className="size-4" aria-hidden="true" />
        Confirmar que vou
      </Button>
    </form>
  );
}

/**
 * O repintar da rota é pedido DEPOIS de a mutação responder, nunca com ela.
 *
 * Se a Action transportasse a revalidação, a resposta ficaria presa ao stream
 * RSC e o botão nunca sairia de "A confirmar…" — foi o que a 6B.2 mediu.
 */
function useRefreshAfterConfirmation(state: TeacherManagementActionState) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const handled = useRef<TeacherManagementActionState | null>(null);

  useEffect(() => {
    if (state.status !== "success" || handled.current === state) return;
    handled.current = state;
    startTransition(() => router.refresh());
  }, [state, router, startTransition]);
}
