"use client";

import { Save } from "lucide-react";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextField, TextareaField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE, preserveFormValuesOnReset } from "@/lib/actions/action-state";
import { updateLessonAction } from "@/lib/actions/lessons";

/**
 * Editar o conteúdo de uma aula (Etapa 6C.2).
 *
 * Data, hora, duração, local e campo não estão aqui — e não é uma questão de
 * arrumação. Mover uma aula é reagendar: a original fica no histórico, a
 * substituta herda a reserva e o motivo fica registado. Enquanto a edição
 * também mexesse no horário, esse rasto era opcional.
 *
 * `update_lesson()` recusa qualquer mudança de colocação do lado do servidor,
 * por isso esconder os campos não é a barreira — é apenas a consequência dela.
 */
export function LessonContentForm({
  lessonId,
  title,
  notesForStudents,
  privateNotes,
}: {
  lessonId: string;
  title: string;
  notesForStudents: string | null;
  privateNotes: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    updateLessonAction,
    FORM_ACTION_IDLE_STATE,
  );

  const [titleValue, setTitleValue] = useState(title);
  const [notesValue, setNotesValue] = useState(notesForStudents ?? "");
  const [privateValue, setPrivateValue] = useState(privateNotes ?? "");

  return (
    <Card>
      <CardHeader
        title="Dados da aula"
        description="Título e observações. Para mudar data, hora, local ou campo, use o reagendamento."
      />
      <CardBody>
        <form
          action={formAction}
          onReset={preserveFormValuesOnReset}
          className="flex flex-col gap-5"
        >
          <input type="hidden" name="lessonId" value={lessonId} />

          {state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
          )}

          <TextField
            name="title"
            label="Título"
            value={titleValue}
            onChange={(event) => setTitleValue(event.target.value)}
            minLength={2}
            maxLength={120}
            required
            autoComplete="off"
            error={state.fieldErrors?.title}
          />

          <TextareaField
            name="notesForStudents"
            label="Observações para o aluno"
            value={notesValue}
            onChange={(event) => setNotesValue(event.target.value)}
            maxLength={2_000}
            rows={3}
            hint="Aparecem na aula do aluno."
            error={state.fieldErrors?.notesForStudents}
          />

          <TextareaField
            name="privateNotes"
            label="Observações privadas"
            value={privateValue}
            onChange={(event) => setPrivateValue(event.target.value)}
            maxLength={2_000}
            rows={3}
            hint="Só para si. Nunca aparecem na área do aluno."
            error={state.fieldErrors?.privateNotes}
          />

          {state.fieldErrors?.form && (
            <p role="alert" className="text-sm font-medium text-state-danger">
              {state.fieldErrors.form}
            </p>
          )}

          <div>
            <Button type="submit" loading={pending} loadingLabel="A guardar">
              <Save className="size-4" aria-hidden="true" />
              Guardar aula
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
