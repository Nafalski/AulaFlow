"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, TextField } from "@/components/ui/field";
import {
  updateStudentNotificationPreferencesAction,
  updateTeacherNotificationPreferencesAction,
} from "@/lib/actions/profile-settings";
import {
  FORM_ACTION_IDLE_STATE,
  preserveFormValuesOnReset,
} from "@/lib/actions/action-state";

export type NotificationPreferenceValues = {
  emailEnabled: boolean;
  lessonCreated: boolean;
  lessonUpdated: boolean;
  lessonCancelled: boolean;
  lessonRescheduled: boolean;
  participantChanged: boolean;
  reminder24h: boolean;
  reminder2h: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  /** Só o aluno recebe os avisos de pacote da Etapa 8B. */
  packageExpiring?: boolean;
  packageExpired?: boolean;
  packageLowBalance?: boolean;
};

type EventKey = Extract<
  keyof NotificationPreferenceValues,
  | "lessonCreated"
  | "lessonUpdated"
  | "lessonCancelled"
  | "lessonRescheduled"
  | "participantChanged"
  | "reminder24h"
  | "reminder2h"
>;

const EVENT_FIELDS: Array<{ key: EventKey; label: string }> = [
  { key: "lessonCreated", label: "Novas aulas" },
  { key: "lessonUpdated", label: "Alterações a aulas" },
  { key: "lessonCancelled", label: "Cancelamentos" },
  { key: "lessonRescheduled", label: "Reagendamentos" },
  { key: "participantChanged", label: "Alterações de participantes" },
  { key: "reminder24h", label: "Lembrete até 24 horas antes" },
  { key: "reminder2h", label: "Lembrete até 2 horas antes" },
];

type PackageKey = "packageExpiring" | "packageExpired" | "packageLowBalance";

const PACKAGE_FIELDS: Array<{ key: PackageKey; label: string }> = [
  { key: "packageLowBalance", label: "Poucas aulas no pacote" },
  { key: "packageExpiring", label: "Pacote a terminar" },
  { key: "packageExpired", label: "Pacote expirado" },
];

export function NotificationPreferencesForm({
  role,
  values,
  timezone,
}: {
  role: "teacher" | "student";
  values: NotificationPreferenceValues;
  /** Vem do perfil. Aqui só se mostra — escolher fuso horário é outro formulário. */
  timezone: string;
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
        description="Escolha o que quer receber por email. Os avisos importantes ficam sempre na sua caixa do AulaFlow."
      />
      <CardBody>
        <form
          action={formAction}
          onReset={preserveFormValuesOnReset}
          className="flex flex-col gap-5"
        >
          {state.status !== "idle" && state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>
              {state.message}
            </Alert>
          )}

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-bold text-ink">Email</legend>
            <CheckboxField
              name="emailEnabled"
              defaultChecked={values.emailEnabled}
              label="Receber avisos por email"
              error={state.fieldErrors?.emailEnabled}
            />
            {/* Não é um interruptor porque desligá-lo não faria nada: o aviso
                dentro da aplicação é o registo do que aconteceu. Dizê-lo é mais
                honesto do que oferecer uma caixa que não muda comportamento. */}
            <p className="text-sm text-muted">
              Os avisos dentro do AulaFlow são o histórico das suas aulas e ficam sempre
              disponíveis na sua caixa.
            </p>
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

          {/* Só o aluno. O professor não recebe avisos de pacote nenhuns, e
              oferecer-lhos seria oferecer controlos que não governam nada. */}
          {role === "student" && (
            <fieldset className="flex flex-col gap-3 border-t border-line pt-5">
              <legend className="mb-1 text-sm font-bold text-ink">Os seus pacotes</legend>
              {PACKAGE_FIELDS.map(({ key, label }) => (
                <CheckboxField
                  key={key}
                  name={key}
                  defaultChecked={values[key] ?? true}
                  label={label}
                  error={state.fieldErrors?.[key]}
                />
              ))}
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-3 border-t border-line pt-5">
            <legend className="mb-1 text-sm font-bold text-ink">Horas de silêncio</legend>
            <p className="text-sm text-muted">
              Durante este horário os emails ficam guardados e são enviados depois. Os avisos
              dentro do AulaFlow continuam disponíveis imediatamente.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <TextField
                name="quietHoursStart"
                type="time"
                label="Início"
                defaultValue={values.quietHoursStart ?? ""}
                error={state.fieldErrors?.quietHoursStart}
              />
              <TextField
                name="quietHoursEnd"
                type="time"
                label="Fim"
                defaultValue={values.quietHoursEnd ?? ""}
                error={state.fieldErrors?.quietHoursEnd}
              />
            </div>
            <p className="text-sm text-muted">
              Horas da sua conta ({timezone}). Deixe os dois campos vazios para não ter horas de
              silêncio.
            </p>
          </fieldset>

          <Button type="submit" loading={pending} loadingLabel="A guardar" fullWidth>
            Guardar preferências
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
