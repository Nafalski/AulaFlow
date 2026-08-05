"use client";

import { Eye, EyeOff } from "lucide-react";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { setClubCalendarSharingAction } from "@/lib/actions/workspaces";

/**
 * Consentimento da PRÓPRIA partilha.
 *
 * O formulário envia o clube e o estado pretendido — nunca um membro-alvo.
 * Quem gere o clube vê o mesmo botão para si e não vê botão nenhum para os
 * colegas, porque a operação de alterar a partilha de terceiros não existe.
 */
export function ClubCalendarSharingForm({
  organizationId,
  enabled,
}: {
  organizationId: string;
  enabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    setClubCalendarSharingAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />

      <div className="flex flex-col gap-1">
        <p className="font-bold text-ink">Partilhar a minha disponibilidade com este clube</p>
        <p className="text-sm text-muted">
          {enabled
            ? "Os membros deste clube veem os seus períodos livres — apenas disponível ou indisponível. Nunca veem motivos, categorias, alunos, pacotes nem notas."
            : "Está desativada. Os colegas veem o seu nome com o estado “Disponibilidade não partilhada” e nenhum período."}
        </p>
      </div>

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}

      <Button
        type="submit"
        variant={enabled ? "outline" : "primary"}
        size="sm"
        loading={pending}
        loadingLabel={enabled ? "A desativar" : "A ativar"}
        icon={
          enabled ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )
        }
        className="self-start"
      >
        {enabled ? "Desativar partilha" : "Ativar partilha"}
      </Button>
    </form>
  );
}
