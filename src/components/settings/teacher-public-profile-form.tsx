"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, TextareaField, TextField } from "@/components/ui/field";
import {
  updateTeacherPublicProfileAction,
} from "@/lib/actions/profile-settings";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";

export type TeacherSportOption = {
  id: string;
  name: string;
  icon: string | null;
};

export function TeacherPublicProfileForm({
  publicName,
  bio,
  serviceArea,
  sports,
  selectedSportIds,
}: {
  publicName: string;
  bio: string | null;
  serviceArea: string | null;
  sports: TeacherSportOption[];
  selectedSportIds: string[];
}) {
  const [state, formAction, pending] = useActionState(
    updateTeacherPublicProfileAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <Card>
      <CardHeader
        title="Perfil profissional"
        description="Estes dados podem ser vistos pelos alunos da sua organização."
      />
      <CardBody>
        <form action={formAction} className="flex flex-col gap-4">
          {state.status !== "idle" && state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>
              {state.message}
            </Alert>
          )}

          <TextField
            label="Nome público ou profissional"
            name="publicName"
            defaultValue={publicName}
            minLength={2}
            maxLength={120}
            required
            autoComplete="organization-title"
            error={state.fieldErrors?.publicName}
          />

          <TextareaField
            label="Apresentação"
            name="bio"
            defaultValue={bio ?? ""}
            minLength={2}
            maxLength={1_000}
            rows={5}
            placeholder="Conte aos alunos como trabalha e qual é a sua experiência."
            error={state.fieldErrors?.bio}
          />

          <TextField
            label="Zona de atuação"
            name="serviceArea"
            defaultValue={serviceArea ?? ""}
            minLength={2}
            maxLength={160}
            placeholder="Ex.: Lisboa, Oeiras e Cascais"
            error={state.fieldErrors?.serviceArea}
          />

          <fieldset className="flex flex-col gap-3 rounded-[var(--radius-field)] border border-line p-3.5">
            <legend className="px-1 text-sm font-bold text-ink">Modalidades ensinadas</legend>
            <p className="text-xs text-muted">Escolha pelo menos uma modalidade.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {sports.map((sport) => (
                <CheckboxField
                  key={sport.id}
                  name="sportIds"
                  value={sport.id}
                  defaultChecked={selectedSportIds.includes(sport.id)}
                  label={
                    /* `sport.icon` é o identificador de um ícone do lucide, não
                       um emoji: imprimi-lo dava "volleyball Beach Tennis". */
                    <span className="inline-flex items-center gap-2">{sport.name}</span>
                  }
                />
              ))}
            </div>
            {state.fieldErrors?.sportIds && (
              <p role="alert" className="text-sm font-medium text-state-danger">
                {state.fieldErrors.sportIds}
              </p>
            )}
          </fieldset>

          <Button type="submit" loading={pending} loadingLabel="A guardar" fullWidth>
            Guardar perfil profissional
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
