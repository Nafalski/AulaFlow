"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/field";
import {
  updateStudentNotificationPreferencesAction,
  updateTeacherNotificationPreferencesAction,
} from "@/lib/actions/profile-settings";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";

export type NotificationPreferenceValues = {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  lessonCreated: boolean;
  lessonUpdated: boolean;
  lessonCancelled: boolean;
  lessonRescheduled: boolean;
  participantChanged: boolean;
  reminder24h: boolean;
  reminder2h: boolean;
};

const EVENT_FIELDS: Array<{
  key: Exclude<keyof NotificationPreferenceValues, "inAppEnabled" | "emailEnabled">;
  label: string;
}> = [
  { key: "lessonCreated", label: "Novas aulas" },
  { key: "lessonUpdated", label: "Alterações a aulas" },
  { key: "lessonCancelled", label: "Cancelamentos" },
  { key: "lessonRescheduled", label: "Reagendamentos" },
  { key: "participantChanged", label: "Alterações de participantes" },
  { key: "reminder24h", label: "Lembrete 24 horas antes" },
  { key: "reminder2h", label: "Lembrete 2 horas antes" },
];

export function NotificationPreferencesForm({
  role,
  values,
}: {
  role: "teacher" | "student";
  values: NotificationPreferenceValues;
}) {
  const action =
    role === "teacher"
      ? updateTeacherNotificationPreferencesAction
      : updateStudentNotificationPreferencesAction;
  const [state, formAction, pending] = useActionState(action, FORM_ACTION_IDLE_STATE);

  return (
    <Card>
      <CardHeader
        title="Avisos e lembretes"
        description="Escolha os canais e acontecimentos sobre os quais quer ser avisado."
      />
      <CardBody>
        <form action={formAction} className="flex flex-col gap-5">
          {state.status !== "idle" && state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>
              {state.message}
            </Alert>
          )}

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-bold text-ink">Canais</legend>
            <CheckboxField
              name="inAppEnabled"
              defaultChecked={values.inAppEnabled}
              label="Avisos dentro do AulaFlow"
              error={state.fieldErrors?.inAppEnabled}
            />
            <CheckboxField
              name="emailEnabled"
              defaultChecked={values.emailEnabled}
              label="Avisos por email"
              error={state.fieldErrors?.emailEnabled}
            />
          </fieldset>

          <fieldset className="flex flex-col gap-3 border-t border-line pt-5">
            <legend className="mb-1 text-sm font-bold text-ink">Acontecimentos</legend>
            {EVENT_FIELDS.map(({ key, label }) => (
              <CheckboxField
                key={key}
                name={key}
                defaultChecked={values[key]}
                label={label}
                error={state.fieldErrors?.[key]}
              />
            ))}
          </fieldset>

          <Alert tone="info">
            As preferências ficam guardadas desde já. O envio automático de emails e lembretes
            agendados será ativado na fase de notificações.
          </Alert>

          <Button type="submit" loading={pending} loadingLabel="A guardar" fullWidth>
            Guardar preferências
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
