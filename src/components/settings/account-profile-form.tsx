"use client";

import { useActionState } from "react";

import { ProfileAvatar } from "@/components/settings/profile-avatar";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/field";
import {
  updateStudentAccountAction,
  updateTeacherAccountAction,
} from "@/lib/actions/profile-settings";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";

type EditableRole = "teacher" | "student";

export type AccountProfileValues = {
  fullName: string;
  email: string;
  phone: string | null;
  locale: string;
  timezone: string;
  contactPreference: "email" | "phone";
};

export function AccountProfileForm({
  role,
  values,
}: {
  role: EditableRole;
  values: AccountProfileValues;
}) {
  const action = role === "teacher" ? updateTeacherAccountAction : updateStudentAccountAction;
  const [state, formAction, pending] = useActionState(action, FORM_ACTION_IDLE_STATE);

  return (
    <Card>
      <CardHeader
        title={role === "teacher" ? "Dados da conta" : "Dados pessoais"}
        description="Informação privada usada para identificar e contactar a sua conta."
      />
      <CardBody className="flex flex-col gap-5">
        <ProfileAvatar fullName={values.fullName} />

        <form action={formAction} className="flex flex-col gap-4">
          {state.status !== "idle" && state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>
              {state.message}
            </Alert>
          )}

          <TextField
            label="Nome completo"
            name="fullName"
            autoComplete="name"
            defaultValue={values.fullName}
            minLength={2}
            maxLength={120}
            required
            error={state.fieldErrors?.fullName}
          />

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-semibold text-ink">Email da conta</p>
            <p className="min-h-11 break-all rounded-[var(--radius-field)] border border-line bg-sand-deep px-3.5 py-2.5 text-[0.9375rem] text-ink-soft">
              {values.email}
            </p>
            <p className="text-xs text-muted">
              O email identifica a conta e não pode ser alterado nesta página.
            </p>
          </div>

          <TextField
            label="Telefone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            defaultValue={values.phone ?? ""}
            placeholder="912 345 678"
            maxLength={24}
            pattern="[+0-9][0-9 ().–—-]{7,23}"
            hint="Nove algarismos recebem automaticamente o indicativo +351. Para outros países, inclua o indicativo."
            error={state.fieldErrors?.phone}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Idioma"
              name="locale"
              defaultValue={values.locale === "pt-PT" ? values.locale : "pt-PT"}
              required
              error={state.fieldErrors?.locale}
            >
              <option value="pt-PT">Português (Portugal)</option>
            </SelectField>

            <SelectField
              label="Fuso horário"
              name="timezone"
              defaultValue={values.timezone}
              required
              error={state.fieldErrors?.timezone}
            >
              <option value="Europe/Lisbon">Lisboa</option>
              <option value="Atlantic/Madeira">Madeira</option>
              <option value="Atlantic/Azores">Açores</option>
            </SelectField>
          </div>

          <SelectField
            label="Contacto preferencial"
            name="contactPreference"
            defaultValue={values.contactPreference}
            required
            hint="Usaremos esta preferência quando um contacto direto for necessário."
            error={state.fieldErrors?.contactPreference}
          >
            <option value="email">Email</option>
            <option value="phone">Telefone</option>
          </SelectField>

          <Button type="submit" loading={pending} loadingLabel="A guardar" fullWidth>
            Guardar dados da conta
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
