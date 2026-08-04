"use client";

import {
  Ban,
  CalendarDays,
  CalendarPlus,
  Clock,
  Filter,
  MapPin,
  Save,
  Trash2,
} from "lucide-react";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader, SectionTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CheckboxField, SelectField, TextareaField, TextField } from "@/components/ui/field";
import {
  FORM_ACTION_IDLE_STATE,
  preserveFormValuesOnReset,
} from "@/lib/actions/action-state";
import {
  cancelScheduleBlockAction,
  deactivateAvailabilityExceptionAction,
  deactivateAvailabilityRuleAction,
  saveAvailabilityExceptionAction,
  saveAvailabilityPreferencesAction,
  saveAvailabilityRuleAction,
  saveScheduleBlockAction,
} from "@/lib/actions/teacher-availability";
import {
  AVAILABILITY_EXCEPTION_MODES,
  DEFAULT_LESSON_DURATION_OPTIONS,
  MINIMUM_BREAK_OPTIONS,
  SCHEDULE_BLOCK_CATEGORIES,
  SCHEDULE_BLOCK_STATUS_LABELS,
  addCivilDays,
  categoryLabel,
  exceptionModeLabel,
  timeRangeLabel,
  weekdayLabel,
} from "@/lib/domain/availability";
import {
  formatDateTime,
  formatFullDate,
  formatTimeRange,
  TIMEZONE,
  toDateInput,
  toTimeInput,
} from "@/lib/datetime";
import type {
  TeacherAvailabilityExceptionRecord,
  TeacherAvailabilityRuleRecord,
  TeacherScheduleBlockRecord,
} from "@/types/database";

export type AvailabilityLocationOption = {
  id: string;
  name: string;
  isActive: boolean;
};

export type AvailabilityIdempotencyKeys = {
  createRuleByWeekday: Record<number, string>;
  editRule: Record<string, string>;
  deactivateRule: Record<string, string>;
  createException: string;
  editException: Record<string, string>;
  deactivateException: Record<string, string>;
  createBlock: string;
  editBlock: Record<string, string>;
  cancelBlock: Record<string, string>;
};

export type BlockFilters = {
  from: string;
  to: string;
  status: "active" | "cancelled" | "all";
};

function ActionMessage({
  state,
}: {
  state: { status: "idle" | "error" | "success"; message?: string };
}) {
  if (!state.message) return null;

  return (
    <Alert tone={state.status === "success" ? "success" : "danger"}>
      {state.message}
    </Alert>
  );
}

function LocationOptions({ locations }: { locations: AvailabilityLocationOption[] }) {
  return (
    <>
      <option value="">Sem local específico</option>
      {locations.map((location) => (
        <option key={location.id} value={location.id}>
          {location.name}
          {!location.isActive ? " (inativo)" : ""}
        </option>
      ))}
    </>
  );
}

function PreferencesForm({
  defaultLessonDurationMinutes,
  minimumBreakMinutes,
}: {
  defaultLessonDurationMinutes: number;
  minimumBreakMinutes: number;
}) {
  const [state, formAction, pending] = useActionState(
    saveAvailabilityPreferencesAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Clock className="size-5 text-brand" aria-hidden="true" />
            Preferências
          </span>
        }
        description="Valores usados mais tarde ao criar aulas e calcular conflitos."
      />
      <CardBody>
        <form action={formAction} onReset={preserveFormValuesOnReset} className="flex flex-col gap-4">
          <ActionMessage state={state} />

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              name="defaultLessonDurationMinutes"
              label="Duração padrão da aula"
              defaultValue={String(defaultLessonDurationMinutes)}
              required
              error={state.fieldErrors?.defaultLessonDurationMinutes}
            >
              {DEFAULT_LESSON_DURATION_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutos
                </option>
              ))}
            </SelectField>

            <SelectField
              name="minimumBreakMinutes"
              label="Intervalo mínimo"
              defaultValue={String(minimumBreakMinutes)}
              required
              hint="Guardado agora; será aplicado aos conflitos de aulas na Etapa 5D."
              error={state.fieldErrors?.minimumBreakMinutes}
            >
              {MINIMUM_BREAK_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 0 ? "Sem intervalo" : `${minutes} minutos`}
                </option>
              ))}
            </SelectField>
          </div>

          <div className="rounded-[var(--radius-field)] border border-line bg-sand-deep p-3 text-sm text-ink-soft">
            Fuso horário: <strong className="text-ink">{TIMEZONE}</strong>. A rotina semanal é guardada como hora civil local, não como UTC.
          </div>

          <Button
            type="submit"
            loading={pending}
            loadingLabel="A guardar"
            icon={<Save className="size-4" aria-hidden="true" />}
          >
            Guardar preferências
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function RuleForm({
  weekday,
  rule,
  locations,
  idempotencyKey,
  title,
}: {
  weekday: number;
  rule?: TeacherAvailabilityRuleRecord;
  locations: AvailabilityLocationOption[];
  idempotencyKey: string;
  title: string;
}) {
  const [state, formAction, pending] = useActionState(saveAvailabilityRuleAction, FORM_ACTION_IDLE_STATE);

  return (
    <form
      action={formAction}
      onReset={preserveFormValuesOnReset}
      className="flex flex-col gap-3 rounded-[var(--radius-field)] border border-line bg-surface p-3"
    >
      <input type="hidden" name="ruleId" value={rule?.id ?? ""} />
      <input type="hidden" name="weekday" value={weekday} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <p className="text-sm font-bold text-ink">{title}</p>
      <ActionMessage state={state} />

      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          name="startsAt"
          label="Início"
          type="time"
          step={900}
          defaultValue={rule?.starts_at.slice(0, 5) ?? "09:00"}
          required
          error={state.fieldErrors?.startsAt}
        />
        <TextField
          name="endsAt"
          label="Fim"
          type="time"
          step={900}
          defaultValue={rule?.ends_at.slice(0, 5) ?? "13:00"}
          required
          error={state.fieldErrors?.endsAt}
        />
        <SelectField
          name="locationId"
          label="Local"
          defaultValue={rule?.location_id ?? ""}
          error={state.fieldErrors?.locationId}
        >
          <LocationOptions locations={locations} />
        </SelectField>
      </div>

      {state.fieldErrors?.form && (
        <p role="alert" className="text-sm font-medium text-state-danger">
          {state.fieldErrors.form}
        </p>
      )}

      <Button
        type="submit"
        variant={rule ? "outline" : "primary"}
        loading={pending}
        loadingLabel="A guardar"
        icon={<Save className="size-4" aria-hidden="true" />}
      >
        {rule ? "Guardar período" : "Adicionar período"}
      </Button>
    </form>
  );
}

function DeactivateRuleForm({ ruleId, idempotencyKey }: { ruleId: string; idempotencyKey: string }) {
  const [state, formAction, pending] = useActionState(
    deactivateAvailabilityRuleAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="ruleId" value={ruleId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <ActionMessage state={state} />
      <Button
        type="submit"
        variant="ghost"
        loading={pending}
        loadingLabel="A remover"
        icon={<Trash2 className="size-4" aria-hidden="true" />}
      >
        Remover período
      </Button>
    </form>
  );
}

function WeeklyAvailabilitySection({
  rules,
  locations,
  keys,
}: {
  rules: TeacherAvailabilityRuleRecord[];
  locations: AvailabilityLocationOption[];
  keys: AvailabilityIdempotencyKeys;
}) {
  const activeRules = rules.filter((rule) => rule.is_active);
  const hasWeeklyAvailability = activeRules.length > 0;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <SectionTitle count={activeRules.length}>Horário semanal</SectionTitle>
        {!hasWeeklyAvailability && (
          <Alert tone="warning">
            Os seus horários ainda não foram configurados. Sem um período semanal ou exceção positiva, o professor fica indisponível por padrão.
          </Alert>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {[1, 2, 3, 4, 5, 6, 0].map((weekday) => {
          const createKey = keys.createRuleByWeekday[weekday] ?? "";
          const dayRules = activeRules
            .filter((rule) => rule.weekday === weekday)
            .sort((left, right) => left.starts_at.localeCompare(right.starts_at));

          return (
            <Card key={weekday} variant="plain">
              <CardHeader
                title={weekdayLabel(weekday)}
                description={
                  dayRules.length > 0
                    ? `${dayRules.length} período${dayRules.length > 1 ? "s" : ""} disponível`
                    : "Indisponível neste dia"
                }
              />
              <CardBody className="flex flex-col gap-4">
                {dayRules.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {dayRules.map((rule) => (
                      <div key={rule.id} className="flex flex-col gap-3 rounded-[var(--radius-field)] bg-sand-deep p-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <p className="font-bold text-ink">
                            {timeRangeLabel(rule.starts_at, rule.ends_at)}
                          </p>
                          <p className="text-sm text-muted">
                            {rule.location_name ?? "Sem local específico"}
                          </p>
                        </div>
                        <RuleForm
                          weekday={weekday}
                          rule={rule}
                          locations={locations}
                          idempotencyKey={keys.editRule[rule.id] ?? createKey}
                          title="Editar período"
                        />
                        <DeactivateRuleForm
                          ruleId={rule.id}
                          idempotencyKey={keys.deactivateRule[rule.id] ?? createKey}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-[var(--radius-field)] bg-sand-deep p-3 text-sm text-muted">
                    Dia sem disponibilidade. Pode adicionar um período abaixo.
                  </p>
                )}

                <RuleForm
                  weekday={weekday}
                  locations={locations}
                  idempotencyKey={createKey}
                  title="Novo período"
                />
              </CardBody>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function ExceptionForm({
  exception,
  locations,
  idempotencyKey,
}: {
  exception?: TeacherAvailabilityExceptionRecord;
  locations: AvailabilityLocationOption[];
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    saveAvailabilityExceptionAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <form
      action={formAction}
      onReset={preserveFormValuesOnReset}
      className="flex flex-col gap-4 rounded-[var(--radius-field)] border border-line bg-surface p-3"
    >
      <input type="hidden" name="exceptionId" value={exception?.id ?? ""} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <ActionMessage state={state} />

      <div className="grid gap-4 md:grid-cols-4">
        <TextField
          name="exceptionDate"
          label="Data"
          type="date"
          defaultValue={exception?.exception_date ?? toDateInput(new Date())}
          required
          error={state.fieldErrors?.exceptionDate}
        />
        <SelectField
          name="mode"
          label="Tipo"
          defaultValue={exception?.mode ?? "replace"}
          required
          error={state.fieldErrors?.mode}
        >
          {AVAILABILITY_EXCEPTION_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </SelectField>
        <TextField
          name="startsAt"
          label="Início"
          type="time"
          step={900}
          defaultValue={exception?.starts_at.slice(0, 5) ?? "09:00"}
          required
          error={state.fieldErrors?.startsAt}
        />
        <TextField
          name="endsAt"
          label="Fim"
          type="time"
          step={900}
          defaultValue={exception?.ends_at.slice(0, 5) ?? "13:00"}
          required
          error={state.fieldErrors?.endsAt}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)]">
        <SelectField
          name="locationId"
          label="Local"
          defaultValue={exception?.location_id ?? ""}
          error={state.fieldErrors?.locationId}
        >
          <LocationOptions locations={locations} />
        </SelectField>
        <TextareaField
          name="notes"
          label="Observações internas"
          rows={3}
          maxLength={240}
          defaultValue={exception?.notes ?? ""}
          error={state.fieldErrors?.notes}
        />
      </div>

      {state.fieldErrors?.form && (
        <p role="alert" className="text-sm font-medium text-state-danger">
          {state.fieldErrors.form}
        </p>
      )}

      <Button
        type="submit"
        loading={pending}
        loadingLabel="A guardar"
        icon={<CalendarPlus className="size-4" aria-hidden="true" />}
      >
        {exception ? "Guardar exceção" : "Criar exceção"}
      </Button>
    </form>
  );
}

function DeactivateExceptionForm({
  exceptionId,
  idempotencyKey,
}: {
  exceptionId: string;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    deactivateAvailabilityExceptionAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="exceptionId" value={exceptionId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <ActionMessage state={state} />
      <Button
        type="submit"
        variant="ghost"
        loading={pending}
        loadingLabel="A desativar"
        icon={<Trash2 className="size-4" aria-hidden="true" />}
      >
        Desativar exceção
      </Button>
    </form>
  );
}

function ExceptionsSection({
  exceptions,
  locations,
  keys,
}: {
  exceptions: TeacherAvailabilityExceptionRecord[];
  locations: AvailabilityLocationOption[];
  keys: AvailabilityIdempotencyKeys;
}) {
  const activeExceptions = exceptions.filter((exception) => exception.is_active);

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle count={activeExceptions.length}>Exceções</SectionTitle>

      <Card>
        <CardHeader
          title="Nova exceção de disponibilidade"
          description="Use para trabalhar num dia especial, começar mais tarde ou substituir a rotina de uma data."
        />
        <CardBody>
          <ExceptionForm locations={locations} idempotencyKey={keys.createException} />
        </CardBody>
      </Card>

      {activeExceptions.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="Ainda não existem exceções futuras"
          description="A rotina semanal continua a ser a regra até criar uma exceção para uma data específica."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {activeExceptions.map((exception) => (
            <Card key={exception.id} variant="plain">
              <CardHeader
                title={formatFullDate(`${exception.exception_date}T12:00:00.000Z`)}
                description={`${exceptionModeLabel(exception.mode)} · ${timeRangeLabel(exception.starts_at, exception.ends_at)}`}
              />
              <CardBody className="flex flex-col gap-4">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold text-muted">Local</dt>
                    <dd className="text-ink">{exception.location_name ?? "Sem local específico"}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-muted">Tipo</dt>
                    <dd className="text-ink">{exceptionModeLabel(exception.mode)}</dd>
                  </div>
                </dl>
                {exception.notes && (
                  <p className="rounded-[var(--radius-field)] bg-sand-deep p-3 text-sm text-ink-soft">
                    {exception.notes}
                  </p>
                )}
                <ExceptionForm
                  exception={exception}
                  locations={locations}
                  idempotencyKey={keys.editException[exception.id] ?? keys.createException}
                />
                <DeactivateExceptionForm
                  exceptionId={exception.id}
                  idempotencyKey={keys.deactivateException[exception.id] ?? keys.createException}
                />
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function ScheduleBlockForm({
  block,
  locations,
  idempotencyKey,
}: {
  block?: TeacherScheduleBlockRecord;
  locations: AvailabilityLocationOption[];
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(saveScheduleBlockAction, FORM_ACTION_IDLE_STATE);
  const [allDay, setAllDay] = useState(block?.all_day ?? false);

  const defaultStartDate = block ? toDateInput(block.starts_at) : toDateInput(new Date());
  const defaultEndDate = block
    ? block.all_day
      ? addCivilDays(toDateInput(block.ends_at), -1)
      : toDateInput(block.ends_at)
    : toDateInput(new Date());

  return (
    <form
      action={formAction}
      onReset={(event) => {
        preserveFormValuesOnReset(event);
        setAllDay(block?.all_day ?? false);
      }}
      className="flex flex-col gap-4 rounded-[var(--radius-field)] border border-line bg-surface p-3"
    >
      <input type="hidden" name="blockId" value={block?.id ?? ""} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <ActionMessage state={state} />

      <CheckboxField
        name="allDay"
        checked={allDay}
        onChange={(event) => setAllDay(event.currentTarget.checked)}
        label="Bloqueio de dia inteiro"
        error={state.fieldErrors?.allDay}
      />

      <div className="grid gap-4 md:grid-cols-4">
        <TextField
          name="startsOn"
          label="Data inicial"
          type="date"
          defaultValue={defaultStartDate}
          required
          error={state.fieldErrors?.startsOn}
        />
        <TextField
          name="startsAt"
          label="Hora inicial"
          type="time"
          step={900}
          defaultValue={block && !block.all_day ? toTimeInput(block.starts_at) : "09:00"}
          required
          hint={allDay ? "Ignorada em dia inteiro." : undefined}
          error={state.fieldErrors?.startsAt}
        />
        <TextField
          name="endsOn"
          label="Data final"
          type="date"
          defaultValue={defaultEndDate}
          required
          error={state.fieldErrors?.endsOn}
        />
        <TextField
          name="endsAt"
          label="Hora final"
          type="time"
          step={900}
          defaultValue={block && !block.all_day ? toTimeInput(block.ends_at) : "17:00"}
          required
          hint={allDay ? "Ignorada em dia inteiro." : undefined}
          error={state.fieldErrors?.endsAt}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SelectField
          name="category"
          label="Categoria"
          defaultValue={block?.category ?? "other"}
          required
          error={state.fieldErrors?.category}
        >
          {SCHEDULE_BLOCK_CATEGORIES.map((category) => (
            <option key={category.value} value={category.value}>
              {category.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          name="locationId"
          label="Local"
          defaultValue={block?.location_id ?? ""}
          error={state.fieldErrors?.locationId}
        >
          <LocationOptions locations={locations} />
        </SelectField>
      </div>

      <TextareaField
        name="reason"
        label="Motivo administrativo"
        rows={3}
        maxLength={240}
        required
        defaultValue={block?.reason ?? ""}
        hint="Privado: não entra na projeção segura do aluno."
        error={state.fieldErrors?.reason}
      />

      {state.fieldErrors?.form && (
        <p role="alert" className="text-sm font-medium text-state-danger">
          {state.fieldErrors.form}
        </p>
      )}

      <Button
        type="submit"
        loading={pending}
        loadingLabel="A guardar"
        icon={<Ban className="size-4" aria-hidden="true" />}
      >
        {block ? "Guardar bloqueio" : "Criar bloqueio"}
      </Button>
    </form>
  );
}

function CancelBlockForm({
  blockId,
  idempotencyKey,
}: {
  blockId: string;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(cancelScheduleBlockAction, FORM_ACTION_IDLE_STATE);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm("Cancelar este bloqueio? O histórico será preservado.")) {
          event.preventDefault();
        }
      }}
      className="flex flex-col gap-3 rounded-[var(--radius-field)] border border-line bg-surface p-3"
    >
      <input type="hidden" name="blockId" value={blockId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <ActionMessage state={state} />
      <TextareaField
        name="cancellationReason"
        label="Motivo do cancelamento"
        rows={2}
        maxLength={240}
        error={state.fieldErrors?.cancellationReason}
      />
      <Button
        type="submit"
        variant="danger"
        loading={pending}
        loadingLabel="A cancelar"
        icon={<Trash2 className="size-4" aria-hidden="true" />}
      >
        Cancelar bloqueio
      </Button>
    </form>
  );
}

function BlockFilterForm({ filters }: { filters: BlockFilters }) {
  return (
    <Card variant="plain">
      <CardBody>
        <form method="get" className="grid gap-4 md:grid-cols-[1fr_1fr_12rem_auto] md:items-end">
          <TextField name="blockFrom" label="Desde" type="date" defaultValue={filters.from} />
          <TextField name="blockTo" label="Até" type="date" defaultValue={filters.to} />
          <SelectField name="blockStatus" label="Estado" defaultValue={filters.status}>
            <option value="active">Ativos</option>
            <option value="cancelled">Cancelados</option>
            <option value="all">Todos</option>
          </SelectField>
          <button type="submit" className={buttonClasses({ variant: "outline" })}>
            <Filter className="size-4" aria-hidden="true" />
            Filtrar
          </button>
        </form>
      </CardBody>
    </Card>
  );
}

function BlockSummary({ block }: { block: TeacherScheduleBlockRecord }) {
  const allDayStart = toDateInput(block.starts_at);
  const allDayEnd = addCivilDays(toDateInput(block.ends_at), -1);
  const period = block.all_day
    ? `${formatFullDate(`${allDayStart}T12:00:00.000Z`)} - ${formatFullDate(`${allDayEnd}T12:00:00.000Z`)}`
    : formatTimeRange(block.starts_at, block.ends_at);

  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <dt className="font-semibold text-muted">Período</dt>
        <dd className="text-ink">{period}</dd>
      </div>
      <div>
        <dt className="font-semibold text-muted">Categoria</dt>
        <dd className="text-ink">{categoryLabel(block.category)}</dd>
      </div>
      <div>
        <dt className="font-semibold text-muted">Local</dt>
        <dd className="text-ink">{block.location_name ?? "Sem local específico"}</dd>
      </div>
      <div>
        <dt className="font-semibold text-muted">Estado</dt>
        <dd className="text-ink">{SCHEDULE_BLOCK_STATUS_LABELS[block.status]}</dd>
      </div>
    </dl>
  );
}

function BlocksSection({
  blocks,
  locations,
  keys,
  filters,
}: {
  blocks: TeacherScheduleBlockRecord[];
  locations: AvailabilityLocationOption[];
  keys: AvailabilityIdempotencyKeys;
  filters: BlockFilters;
}) {
  return (
    <section className="flex flex-col gap-4">
      <SectionTitle count={blocks.length}>Bloqueios</SectionTitle>

      <BlockFilterForm filters={filters} />

      <Card>
        <CardHeader
          title="Novo bloqueio de agenda"
          description="Use para férias, torneios, compromissos pessoais ou indisponibilidade de local."
        />
        <CardBody>
          <ScheduleBlockForm locations={locations} idempotencyKey={keys.createBlock} />
        </CardBody>
      </Card>

      {blocks.length === 0 ? (
        <EmptyState
          icon={Ban}
          title="Nenhum bloqueio no período escolhido"
          description="Crie um bloqueio quando houver uma indisponibilidade específica. O motivo será sempre privado."
        />
      ) : (
        <div className="grid gap-4">
          {blocks.map((block) => (
            <Card key={block.id} variant="plain">
              <CardHeader
                title={
                  block.all_day
                    ? "Bloqueio de dia inteiro"
                    : `Bloqueio em ${formatDateTime(block.starts_at)}`
                }
                description={block.reason}
                action={
                  <span className="shrink-0 rounded-full bg-sand-deep px-3 py-1 text-xs font-bold text-ink-soft">
                    {SCHEDULE_BLOCK_STATUS_LABELS[block.status]}
                  </span>
                }
              />
              <CardBody className="flex flex-col gap-4">
                <BlockSummary block={block} />
                {block.status === "active" ? (
                  <>
                    <ScheduleBlockForm
                      block={block}
                      locations={locations}
                      idempotencyKey={keys.editBlock[block.id] ?? keys.createBlock}
                    />
                    <CancelBlockForm
                      blockId={block.id}
                      idempotencyKey={keys.cancelBlock[block.id] ?? keys.createBlock}
                    />
                  </>
                ) : (
                  <Alert tone="info">
                    Cancelado em {block.cancelled_at ? formatDateTime(block.cancelled_at) : "data não registada"}.
                  </Alert>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

export function TeacherAvailabilityManager({
  preferences,
  rules,
  exceptions,
  blocks,
  locations,
  keys,
  blockFilters,
}: {
  preferences: {
    defaultLessonDurationMinutes: number;
    minimumBreakMinutes: number;
  };
  rules: TeacherAvailabilityRuleRecord[];
  exceptions: TeacherAvailabilityExceptionRecord[];
  blocks: TeacherScheduleBlockRecord[];
  locations: AvailabilityLocationOption[];
  keys: AvailabilityIdempotencyKeys;
  blockFilters: BlockFilters;
}) {
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <PreferencesForm
          defaultLessonDurationMinutes={preferences.defaultLessonDurationMinutes}
          minimumBreakMinutes={preferences.minimumBreakMinutes}
        />

        <Card variant="plain" className="p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-tint">
              <MapPin className="size-5 text-brand" aria-hidden="true" />
            </span>
            <div>
              <p className="font-bold text-ink">Como os intervalos funcionam</p>
              <p className="mt-1 text-sm text-muted">
                Para criar almoço ou deslocação, divida o dia em dois períodos. Exemplo:
                09:00-13:00 e 15:00-20:00 deixam 13:00-15:00 indisponível.
              </p>
              <p className="mt-2 text-sm text-muted">
                Bloqueios têm prioridade máxima; depois vêm exceções, rotina semanal e indisponível por padrão.
              </p>
            </div>
          </div>
        </Card>
      </div>

      <WeeklyAvailabilitySection rules={rules} locations={locations} keys={keys} />
      <ExceptionsSection exceptions={exceptions} locations={locations} keys={keys} />
      <BlocksSection blocks={blocks} locations={locations} keys={keys} filters={blockFilters} />
    </div>
  );
}
