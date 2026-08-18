"use client";

import { Check, CheckCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FORM_ACTION_IDLE_STATE, preserveFormValuesOnReset } from "@/lib/actions/action-state";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/lib/actions/notifications";
import type { TeacherManagementActionState } from "@/lib/actions/teacher-management";

/**
 * O repintar da rota vem DEPOIS da mutação, nunca com ela.
 *
 * A lição da 6B.2: com a revalidação dentro da Action, a resposta ficava presa
 * ao stream RSC e o botão nunca saía de "A marcar…".
 */
function useRefreshAfterRead(state: TeacherManagementActionState) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const handled = useRef<TeacherManagementActionState | null>(null);

  useEffect(() => {
    if (state.status !== "success" || handled.current === state) return;
    handled.current = state;
    startTransition(() => router.refresh());
  }, [state, router, startTransition]);
}

export function MarkNotificationReadButton({ notificationId }: { notificationId: string }) {
  const [state, formAction, pending] = useActionState(
    markNotificationReadAction,
    FORM_ACTION_IDLE_STATE,
  );
  useRefreshAfterRead(state);

  // O servidor já confirmou; mostra-se o resultado sem esperar pelo refresh.
  if (state.status === "success") {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted">
        <Check className="size-4 shrink-0" aria-hidden="true" />
        Lido
      </p>
    );
  }

  return (
    <form action={formAction} onReset={preserveFormValuesOnReset}>
      <input type="hidden" name="notificationId" value={notificationId} />
      {state.status === "error" && state.message && (
        <p role="alert" className="mb-1.5 text-sm font-medium text-state-danger">
          {state.message}
        </p>
      )}
      <Button type="submit" variant="ghost" size="sm" loading={pending} loadingLabel="A marcar">
        <Check className="size-4" aria-hidden="true" />
        Marcar como lido
      </Button>
    </form>
  );
}

export function MarkAllNotificationsReadButton() {
  const [state, formAction, pending] = useActionState(
    markAllNotificationsReadAction,
    FORM_ACTION_IDLE_STATE,
  );
  useRefreshAfterRead(state);

  return (
    <form action={formAction} onReset={preserveFormValuesOnReset}>
      {state.status === "error" && state.message && (
        <p role="alert" className="mb-1.5 text-sm font-medium text-state-danger">
          {state.message}
        </p>
      )}
      <Button
        type="submit"
        variant="outline"
        size="sm"
        loading={pending}
        loadingLabel="A marcar"
        disabled={pending || state.status === "success"}
      >
        <CheckCheck className="size-4" aria-hidden="true" />
        Marcar todos como lidos
      </Button>
    </form>
  );
}
