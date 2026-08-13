"use client";

import { CalendarDays, CalendarPlus, Info, Repeat2, Save } from "lucide-react";
import Link from "next/link";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import {
  FORM_ACTION_IDLE_STATE,
  preserveFormValuesOnReset,
} from "@/lib/actions/action-state";
import { createLessonAction, updateLessonAction } from "@/lib/actions/lessons";
import {
  LESSON_CONTEXT_DESCRIPTIONS,
  LESSON_CONTEXT_LABELS,
  LESSON_CONFLICT_PROTECTION_NOTICE,
  LESSON_RECURRENCE_LABELS,
  LESSON_RECURRENCE_MODES,
  PARTICIPANT_MODE_LABELS,
  WEEKLY_RECURRENCE_LIMITS,
  durationChoices,
  locationsForContext,
  weeklyRecurrenceSummary,
  resourcesForLocation,
  type LessonParticipantMode,
  type LessonRecurrenceMode,
  type SchedulableLocation,
  type SchedulableResource,
} from "@/lib/domain/lesson-scheduling";
import {
  selectPackageForLesson,
  type PackageSelectionSnapshot,
} from "@/lib/domain/packages";
import { formatDuration } from "@/lib/datetime";
import type { LessonContextKind } from "@/types/database";

export type LessonFormOption = { id: string; name: string };
export type LessonPackagePreview = PackageSelectionSnapshot & {
  studentId: string;
  sportName: string | null;
};
export type LessonGroupMemberPreview = {
  groupId: string;
  studentId: string;
  studentName: string;
};

export type LessonFormValues = {
  lessonId?: string;
  date: string;
  time: string;
  durationMinutes: number;
  title: string;
  locationId: string | null;
  locationResourceId: string | null;
  notesForStudents: string | null;
  privateNotes: string | null;
  /** Contexto já fixado da aula. Só usado na edição, onde não se pode mudar. */
  contextKind?: LessonContextKind;
  clubOrganizationId?: string | null;
};

export type LessonFormData = {
  students: LessonFormOption[];
  groups: LessonFormOption[];
  sports: LessonFormOption[];
  clubs: LessonFormOption[];
  locations: (SchedulableLocation & { name: string })[];
  resources: SchedulableResource[];
  packagePreviews: LessonPackagePreview[];
  groupMembers: LessonGroupMemberPreview[];
  defaultDurationMinutes: number;
};

const LESSON_CREATION_CREDIT_COST = 1;

function creditsLabel(value: number): string {
  return `${value} crédito${value === 1 ? "" : "s"}`;
}

function packageLine(pkg: PackageSelectionSnapshot & { sportName?: string | null }): string {
  const sport = pkg.sportName ?? "Todas as modalidades";
  const expiry = pkg.expiresOn ? ` · válido até ${pkg.expiresOn}` : "";
  return `${pkg.name} · ${sport} · ${creditsLabel(pkg.creditsAvailable)} disponíveis${expiry}`;
}

function packagesForStudent(data: LessonFormData, studentId: string) {
  return data.packagePreviews.filter((pack) => pack.studentId === studentId);
}

function LessonCreditPreview({
  participantMode,
  studentId,
  groupId,
  sportId,
  lessonDate,
  data,
}: {
  participantMode: LessonParticipantMode;
  studentId: string;
  groupId: string;
  sportId: string;
  lessonDate: string;
  data: LessonFormData;
}) {
  if (!sportId || !lessonDate) return null;

  const selectionOptions = {
    credits: LESSON_CREATION_CREDIT_COST,
    sportId,
    today: lessonDate,
    lessonDate,
  };

  if (participantMode === "student") {
    if (!studentId) {
      return (
        <Alert tone="info" title="Crédito da aula">
          Escolha um aluno para ver o pacote provável. A reserva final é confirmada ao criar.
        </Alert>
      );
    }

    const selected = selectPackageForLesson(
      packagesForStudent(data, studentId),
      selectionOptions,
    );

    if (!selected) {
      return (
        <Alert tone="warning" title="Crédito da aula">
          Nenhum pacote compatível com saldo disponível para esta data. A criação será
          revalidada pelo banco.
        </Alert>
      );
    }

    return (
      <Alert tone="success" title="Pacote provável">
        {packageLine(selected)}. A reserva final é confirmada ao criar.
      </Alert>
    );
  }

  if (!groupId) {
    return (
      <Alert tone="info" title="Créditos da turma">
        Escolha uma turma para resumir os pacotes prováveis. A reserva final é confirmada ao criar.
      </Alert>
    );
  }

  const members = data.groupMembers.filter((member) => member.groupId === groupId);
  if (members.length === 0) {
    return (
      <Alert tone="warning" title="Créditos da turma">
        Esta turma não tem alunos ativos para reservar créditos.
      </Alert>
    );
  }

  const missing = members.filter(
    (member) =>
      selectPackageForLesson(packagesForStudent(data, member.studentId), selectionOptions) ===
      null,
  );

  if (missing.length > 0) {
    const names = missing
      .slice(0, 3)
      .map((member) => member.studentName)
      .join(", ");
    const suffix = missing.length > 3 ? ` e mais ${missing.length - 3}` : "";
    return (
      <Alert tone="warning" title="Créditos da turma">
        {members.length - missing.length} de {members.length} participante
        {members.length === 1 ? "" : "s"} têm pacote compatível. Sem crédito provável: {names}
        {suffix}. A turma só é criada se todos passarem na reserva final.
      </Alert>
    );
  }

  return (
    <Alert tone="success" title="Créditos da turma">
      {members.length} participante{members.length === 1 ? "" : "s"} com pacote compatível
      para {creditsLabel(LESSON_CREATION_CREDIT_COST)} cada. A reserva final é confirmada ao
      criar.
    </Alert>
  );
}

/**
 * Formulário de aula.
 *
 * Divulgação progressiva: o professor escolhe primeiro QUEM e ONDE, e só depois
 * vê os campos que dependem dessas escolhas. Um formulário com todos os campos
 * visíveis obrigaria a ler dez controlos para preencher cinco.
 *
 * O contexto, o participante e a modalidade só existem na criação: trocar o
 * aluno de uma aula é criar outra aula, e mudar de contexto mudaria a quem ela
 * pertence. A RPC de edição recusa ambos.
 */
export function LessonForm({
  mode,
  values,
  data,
  idempotencyKey,
}: {
  mode: "create" | "edit";
  values: LessonFormValues;
  data: LessonFormData;
  idempotencyKey?: string;
}) {
  const action = mode === "create" ? createLessonAction : updateLessonAction;
  const [state, formAction, pending] = useActionState(action, FORM_ACTION_IDLE_STATE);

  // Fixada no arranque: o servidor gera uma chave nova a cada render, e qualquer
  // revalidação da página remontaria o formulário a meio do preenchimento.
  const [initialKey] = useState(idempotencyKey ?? "");
  const key = state.status === "success" && state.resourceId ? state.resourceId : initialKey;

  const [participantMode, setParticipantMode] = useState<LessonParticipantMode>("student");
  const [studentId, setStudentId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [sportId, setSportId] = useState(data.sports[0]?.id ?? "");
  const [lessonDate, setLessonDate] = useState(values.date);
  const [lessonTime, setLessonTime] = useState(values.time);
  const [contextKind, setContextKind] = useState<LessonContextKind>("personal");
  const [clubId, setClubId] = useState<string>(data.clubs[0]?.id ?? "");
  const [locationId, setLocationId] = useState<string>(values.locationId ?? "");
  const [resourceId, setResourceId] = useState<string>(values.locationResourceId ?? "");
  const [recurrenceMode, setRecurrenceMode] = useState<LessonRecurrenceMode>("none");
  const [recurrenceCount, setRecurrenceCount] = useState("4");

  // Na edição o contexto está fixo na aula, e é ELE que decide os locais
  // válidos. Oferecer a lista toda mostraria o pavilhão do clube numa aula
  // pessoal e propostas públicas ainda por aprovar — opções que a RPC recusaria
  // depois de a pessoa as escolher.
  const locationOptions = locationsForContext(
    data.locations,
    mode === "create" ? contextKind : (values.contextKind ?? "personal"),
    mode === "create" ? clubId || null : (values.clubOrganizationId ?? null),
  );
  const resourceOptions = resourcesForLocation(data.resources, locationId || null);
  const created = mode === "create" && state.status === "success" && state.resourceId;
  const createdSeries = Boolean(created && state.resourceCount && state.resourceCount > 1);
  const recurrenceCountNumber = Number(recurrenceCount);
  const recurrenceSummary =
    mode === "create" &&
    recurrenceMode === "weekly" &&
    Number.isInteger(recurrenceCountNumber) &&
    recurrenceCountNumber >= WEEKLY_RECURRENCE_LIMITS.min &&
    recurrenceCountNumber <= WEEKLY_RECURRENCE_LIMITS.max
      ? weeklyRecurrenceSummary({
          date: lessonDate,
          time: lessonTime,
          occurrenceCount: recurrenceCountNumber,
        })
      : null;

  return (
    <Card>
      <CardHeader
        title={mode === "create" ? "Nova aula" : "Dados da aula"}
        description={
          mode === "create"
            ? "O horário é validado contra a sua disponibilidade."
            : "Horário, local e observações. O aluno e a modalidade não mudam."
        }
      />
      <CardBody>
        <form
          action={formAction}
          onReset={preserveFormValuesOnReset}
          key={key}
          className="flex flex-col gap-5"
        >
          {values.lessonId && <input type="hidden" name="lessonId" value={values.lessonId} />}
          {mode === "create" && <input type="hidden" name="idempotencyKey" value={key} />}

          {state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
          )}

          {mode === "create" && (
            <>
              {/* Escolha explícita, e não dois selects a competir: mostrar um
                  seletor de alunos e outro de turmas ao mesmo tempo convidaria a
                  preencher os dois, que é exatamente o que a base recusa. */}
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-bold text-ink">Tipo de aula</legend>
                <div className="flex flex-wrap gap-2">
                  {(["student", "group"] as const).map((option) => (
                    <label
                      key={option}
                      className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius-pill)] border px-4 text-sm font-semibold transition-colors ${
                        participantMode === option
                          ? "border-brand bg-brand-tint text-brand-deep"
                          : "border-line bg-surface text-ink-soft hover:border-brand/40"
                      }`}
                    >
                      <input
                        type="radio"
                        name="mode"
                        value={option}
                        checked={participantMode === option}
                        onChange={() => setParticipantMode(option)}
                        className="size-4 accent-[var(--color-brand)]"
                      />
                      {PARTICIPANT_MODE_LABELS[option]}
                    </label>
                  ))}
                </div>
                {state.fieldErrors?.mode && (
                  <p role="alert" className="text-sm font-medium text-state-danger">
                    {state.fieldErrors.mode}
                  </p>
                )}
              </fieldset>

              {participantMode === "student" ? (
                <SelectField
                  name="studentId"
                  label="Aluno"
                  value={studentId}
                  onChange={(event) => setStudentId(event.target.value)}
                  required
                  error={state.fieldErrors?.studentId}
                >
                  <option value="">Escolha um aluno</option>
                  {data.students.map((student) => (
                    <option key={student.id} value={student.id}>
                      {student.name}
                    </option>
                  ))}
                </SelectField>
              ) : (
                <SelectField
                  name="groupId"
                  label="Turma"
                  value={groupId}
                  onChange={(event) => setGroupId(event.target.value)}
                  required
                  hint="Os alunos da turma são fixados agora. Alterar a turma depois não muda esta aula."
                  error={state.fieldErrors?.groupId}
                >
                  <option value="">Escolha uma turma</option>
                  {data.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </SelectField>
              )}

              <SelectField
                name="sportId"
                label="Modalidade"
                value={sportId}
                onChange={(event) => setSportId(event.target.value)}
                required
                error={state.fieldErrors?.sportId}
              >
                {data.sports.map((sport) => (
                  <option key={sport.id} value={sport.id}>
                    {sport.name}
                  </option>
                ))}
              </SelectField>

              {data.clubs.length > 0 && (
                <>
                  <SelectField
                    name="contextKind"
                    label="Contexto"
                    value={contextKind}
                    onChange={(event) => {
                      setContextKind(event.target.value as LessonContextKind);
                      setLocationId("");
                      setResourceId("");
                    }}
                    hint={LESSON_CONTEXT_DESCRIPTIONS[contextKind]}
                    error={state.fieldErrors?.contextKind}
                  >
                    {(["personal", "club"] as const).map((option) => (
                      <option key={option} value={option}>
                        {LESSON_CONTEXT_LABELS[option]}
                      </option>
                    ))}
                  </SelectField>

                  {contextKind === "club" && (
                    <SelectField
                      name="clubOrganizationId"
                      label="Clube"
                      value={clubId}
                      onChange={(event) => {
                        setClubId(event.target.value);
                        setLocationId("");
                        setResourceId("");
                      }}
                      required
                      error={state.fieldErrors?.clubOrganizationId}
                    >
                      <option value="">Escolha um clube</option>
                      {data.clubs.map((club) => (
                        <option key={club.id} value={club.id}>
                          {club.name}
                        </option>
                      ))}
                    </SelectField>
                  )}
                </>
              )}
            </>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="date"
              label="Data"
              type="date"
              {...(mode === "create"
                ? {
                    value: lessonDate,
                    onChange: (event) => setLessonDate(event.target.value),
                  }
                : { defaultValue: values.date })}
              required
              error={state.fieldErrors?.date}
            />
            <TextField
              name="time"
              label="Hora de início"
              type="time"
              {...(mode === "create"
                ? {
                    value: lessonTime,
                    onChange: (event) => setLessonTime(event.target.value),
                  }
                : { defaultValue: values.time })}
              step={300}
              required
              error={state.fieldErrors?.time}
            />
          </div>

          <SelectField
            name="durationMinutes"
            label="Duração"
            defaultValue={String(values.durationMinutes)}
            required
            error={state.fieldErrors?.durationMinutes}
          >
            {durationChoices(data.defaultDurationMinutes).map((minutes) => (
              <option key={minutes} value={minutes}>
                {formatDuration(minutes)}
              </option>
            ))}
          </SelectField>

          {mode === "create" && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-bold text-ink">Repetição</legend>
              <div className="flex flex-wrap gap-2">
                {LESSON_RECURRENCE_MODES.map((option) => (
                  <label
                    key={option}
                    className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius-pill)] border px-4 text-sm font-semibold transition-colors ${
                      recurrenceMode === option
                        ? "border-brand bg-brand-tint text-brand-deep"
                        : "border-line bg-surface text-ink-soft hover:border-brand/40"
                    }`}
                  >
                    <input
                      type="radio"
                      name="recurrenceMode"
                      value={option}
                      checked={recurrenceMode === option}
                      onChange={() => setRecurrenceMode(option)}
                      className="size-4 accent-[var(--color-brand)]"
                    />
                    {option === "weekly" && <Repeat2 className="size-4" aria-hidden="true" />}
                    {LESSON_RECURRENCE_LABELS[option]}
                  </label>
                ))}
              </div>
              {state.fieldErrors?.recurrenceMode && (
                <p role="alert" className="text-sm font-medium text-state-danger">
                  {state.fieldErrors.recurrenceMode}
                </p>
              )}
            </fieldset>
          )}

          {mode === "create" && recurrenceMode === "weekly" && (
            <>
              <TextField
                name="recurrenceCount"
                label="Número de aulas"
                type="number"
                min={WEEKLY_RECURRENCE_LIMITS.min}
                max={WEEKLY_RECURRENCE_LIMITS.max}
                step={1}
                value={recurrenceCount}
                onChange={(event) => setRecurrenceCount(event.target.value)}
                required
                error={state.fieldErrors?.recurrenceCount}
              />
              {recurrenceSummary && (
                <Alert tone="info" title="Série semanal">
                  <span className="inline-flex items-start gap-2">
                    <CalendarDays className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {recurrenceSummary} Cada aula será criada e revalidada no banco.
                  </span>
                </Alert>
              )}
            </>
          )}

          {mode === "create" && (
            <LessonCreditPreview
              participantMode={participantMode}
              studentId={studentId}
              groupId={groupId}
              sportId={sportId}
              lessonDate={lessonDate}
              data={data}
            />
          )}

          {/* Local → recurso: mudar de local limpa o campo escolhido, porque um
              campo do local anterior deixaria de existir ali. */}
          <SelectField
            name="locationId"
            label="Local"
            value={locationId}
            onChange={(event) => {
              setLocationId(event.target.value);
              setResourceId("");
            }}
            hint="Opcional. Pode marcar uma aula sem indicar o local."
            error={state.fieldErrors?.locationId}
          >
            <option value="">Sem local indicado</option>
            {locationOptions.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </SelectField>

          {locationId &&
            (resourceOptions.length > 0 ? (
              <SelectField
                name="locationResourceId"
                label="Campo, sala ou área"
                value={resourceId}
                onChange={(event) => setResourceId(event.target.value)}
                error={state.fieldErrors?.locationResourceId}
              >
                <option value="">Sem campo indicado</option>
                {resourceOptions.map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.name}
                  </option>
                ))}
              </SelectField>
            ) : (
              <Alert tone="info">Este local ainda não tem campos ou salas ativos.</Alert>
            ))}

          <TextField
            name="title"
            label="Título"
            defaultValue={values.title}
            minLength={2}
            maxLength={120}
            required
            autoComplete="off"
            error={state.fieldErrors?.title}
          />

          <TextareaField
            name="notesForStudents"
            label="Observações para o aluno"
            defaultValue={values.notesForStudents ?? ""}
            maxLength={2_000}
            rows={3}
            hint="Aparecem na aula do aluno."
            error={state.fieldErrors?.notesForStudents}
          />

          <TextareaField
            name="privateNotes"
            label="Observações privadas"
            defaultValue={values.privateNotes ?? ""}
            maxLength={2_000}
            rows={3}
            hint="Só para si. Nunca aparecem na área do aluno."
            error={state.fieldErrors?.privateNotes}
          />

          <Alert tone="info">
            <span className="inline-flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {LESSON_CONFLICT_PROTECTION_NOTICE}
            </span>
          </Alert>

          {state.fieldErrors?.form && (
            <p role="alert" className="text-sm font-medium text-state-danger">
              {state.fieldErrors.form}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              loading={pending}
              loadingLabel={mode === "create" ? "A criar" : "A guardar"}
              disabled={Boolean(created)}
            >
              {mode === "create" ? (
                <>
                  <CalendarPlus className="size-4" aria-hidden="true" />
                  Criar aula
                </>
              ) : (
                <>
                  <Save className="size-4" aria-hidden="true" />
                  Guardar aula
                </>
              )}
            </Button>
            {mode === "create" && state.resourceId && (
              <Link
                href={`/professor/aulas/${state.resourceId}`}
                className={buttonClasses({ variant: "outline" })}
              >
                {createdSeries ? "Abrir primeira aula" : "Abrir aula"}
              </Link>
            )}
            {createdSeries && (
              <Link
                href="/professor/calendario"
                className={buttonClasses({ variant: "ghost" })}
              >
                Ver no calendário
              </Link>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
