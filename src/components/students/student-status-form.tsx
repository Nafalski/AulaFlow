"use client";

import { UserRoundCheck, UserRoundX } from "lucide-react";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { setStudentStatusAction } from "@/lib/actions/students";

export function StudentStatusForm({
  studentId,
  fullName,
  isActive,
}: {
  studentId: string;
  fullName: string;
  isActive: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    setStudentStatusAction,
    FORM_ACTION_IDLE_STATE,
  );
  const nextStatus = isActive ? "inactive" : "active";

  return (
    <Card variant="plain">
      <CardHeader
        title="Estado da ficha"
        description="Desativar nunca apaga dados, grupos ou histórico."
      />
      <CardBody>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="studentId" value={studentId} />
          <input type="hidden" name="status" value={nextStatus} />

          <Alert tone={isActive ? "warning" : "info"}>
            {isActive
              ? `${fullName} deixa de estar disponível para a gestão corrente, mas todo o registo é preservado.`
              : `${fullName} volta a estar disponível para grupos e para a gestão corrente.`}
          </Alert>

          <CheckboxField
            name="confirmation"
            required
            error={state.fieldErrors?.confirmation}
            label={
              isActive
                ? `Confirmo que pretendo desativar a ficha de ${fullName}.`
                : `Confirmo que pretendo reativar a ficha de ${fullName}.`
            }
          />

          {state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>
              {state.message}
            </Alert>
          )}

          <Button
            type="submit"
            variant={isActive ? "danger" : "primary"}
            loading={pending}
            loadingLabel={isActive ? "A desativar" : "A reativar"}
            icon={
              isActive ? (
                <UserRoundX className="size-4.5" aria-hidden="true" />
              ) : (
                <UserRoundCheck className="size-4.5" aria-hidden="true" />
              )
            }
          >
            {isActive ? "Desativar ficha" : "Reativar ficha"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
