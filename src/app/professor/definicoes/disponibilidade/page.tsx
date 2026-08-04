import { randomUUID } from "node:crypto";

import { ArrowLeft, CalendarClock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  TeacherAvailabilityManager,
  type AvailabilityIdempotencyKeys,
  type BlockFilters,
} from "@/components/availability/teacher-availability-manager";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { addCivilDays } from "@/lib/domain/availability";
import { lisbonInputToInstant, toDateInput } from "@/lib/datetime";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Disponibilidade" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BLOCK_STATUS_VALUES = ["active", "cancelled", "all"] as const;

function singleParam(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function isValidDateOnly(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;

  const instant = new Date(Date.UTC(year, month - 1, day));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  );
}

function readBlockFilters(params: SearchParams): BlockFilters {
  const today = toDateInput(new Date());
  const from = singleParam(params, "blockFrom");
  const to = singleParam(params, "blockTo");
  const status = singleParam(params, "blockStatus");

  return {
    from: isValidDateOnly(from) ? from : today,
    to: isValidDateOnly(to) ? to : "",
    status: BLOCK_STATUS_VALUES.includes(status as BlockFilters["status"])
      ? (status as BlockFilters["status"])
      : "active",
  };
}

function randomKeyMap(records: Array<{ id: string }>): Record<string, string> {
  return Object.fromEntries(records.map((record) => [record.id, randomUUID()]));
}

function createIdempotencyKeys({
  rules,
  exceptions,
  blocks,
}: {
  rules: Array<{ id: string }>;
  exceptions: Array<{ id: string }>;
  blocks: Array<{ id: string }>;
}): AvailabilityIdempotencyKeys {
  const createRuleByWeekday: Record<number, string> = {};
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    createRuleByWeekday[weekday] = randomUUID();
  }

  return {
    createRuleByWeekday,
    editRule: randomKeyMap(rules),
    deactivateRule: randomKeyMap(rules),
    createException: randomUUID(),
    editException: randomKeyMap(exceptions),
    deactivateException: randomKeyMap(exceptions),
    createBlock: randomUUID(),
    editBlock: randomKeyMap(blocks),
    cancelBlock: randomKeyMap(blocks),
  };
}

function availabilityLookupError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao carregar ${context} da disponibilidade.`, error);
  throw new Error("Não foi possível carregar a disponibilidade do professor.");
}

export default async function TeacherAvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireRole("teacher", "/professor/definicoes/disponibilidade");
  if (!user.teacherId || !user.profile.organization_id) {
    throw new Error("Não foi possível identificar o professor e a organização.");
  }

  const filters = readBlockFilters(await searchParams);
  const supabase = await createSupabaseServerClient();
  const blockFromInstant = lisbonInputToInstant(filters.from, "00:00").toISOString();
  const blockToInstant = filters.to
    ? lisbonInputToInstant(addCivilDays(filters.to, 1), "00:00").toISOString()
    : null;

  let blocksQuery = supabase
    .from("teacher_schedule_block_records")
    .select(
      "id, organization_id, teacher_id, location_id, location_name, starts_at, ends_at, all_day, reason, category, status, created_by, cancelled_at, cancelled_by, cancellation_reason, created_at, updated_at",
    )
    .gte("ends_at", blockFromInstant)
    .order("starts_at", { ascending: true });

  if (blockToInstant) blocksQuery = blocksQuery.lt("starts_at", blockToInstant);
  if (filters.status !== "all") blocksQuery = blocksQuery.eq("status", filters.status);

  const [
    teacherProfileResult,
    rulesResult,
    exceptionsResult,
    blocksResult,
    locationsResult,
  ] = await Promise.all([
    supabase
      .from("teacher_profiles")
      .select("id, default_lesson_duration_minutes, minimum_break_minutes")
      .eq("id", user.teacherId)
      .maybeSingle(),
    supabase
      .from("teacher_availability_rule_records")
      .select("id, organization_id, teacher_id, weekday, starts_at, ends_at, location_id, location_name, is_active, created_at, updated_at")
      .order("weekday", { ascending: true })
      .order("starts_at", { ascending: true }),
    supabase
      .from("teacher_availability_exception_records")
      .select("id, organization_id, teacher_id, exception_date, mode, starts_at, ends_at, location_id, location_name, notes, is_active, created_at, updated_at")
      .gte("exception_date", filters.from)
      .order("exception_date", { ascending: true })
      .order("starts_at", { ascending: true }),
    blocksQuery,
    supabase
      .from("teacher_location_records")
      .select("id, name, is_active")
      .eq("is_active", true)
      .order("name", { ascending: true }),
  ]);

  if (teacherProfileResult.error) {
    availabilityLookupError("as preferências do professor", teacherProfileResult.error);
  }
  if (!teacherProfileResult.data) {
    availabilityLookupError("as preferências do professor", "Perfil profissional inexistente");
  }
  if (rulesResult.error) availabilityLookupError("os horários semanais", rulesResult.error);
  if (exceptionsResult.error) availabilityLookupError("as exceções", exceptionsResult.error);
  if (blocksResult.error) availabilityLookupError("os bloqueios", blocksResult.error);
  if (locationsResult.error) availabilityLookupError("os locais", locationsResult.error);

  const rules = rulesResult.data ?? [];
  const exceptions = exceptionsResult.data ?? [];
  const blocks = blocksResult.data ?? [];
  const keys = createIdempotencyKeys({ rules, exceptions, blocks });

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/professor/definicoes"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar às definições
        </Link>
        <div className="flex items-center gap-2 text-brand">
          <CalendarClock className="size-5" aria-hidden="true" />
          <p className="text-sm font-bold tracking-wide uppercase">Agenda do professor</p>
        </div>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Disponibilidade</h1>
        <p className="mt-1 text-sm text-muted">
          Configure quando aceita trabalhar, exceções por data e períodos bloqueados. A criação de aulas chega nas próximas etapas.
        </p>
      </header>

      <Alert tone="info" title="Fonte de verdade da agenda">
        Bloqueios têm prioridade sobre exceções, exceções têm prioridade sobre a rotina semanal e, sem configuração positiva, o professor fica indisponível.
      </Alert>

      <TeacherAvailabilityManager
        preferences={{
          defaultLessonDurationMinutes: teacherProfileResult.data.default_lesson_duration_minutes,
          minimumBreakMinutes: teacherProfileResult.data.minimum_break_minutes,
        }}
        rules={rules}
        exceptions={exceptions}
        blocks={blocks}
        locations={(locationsResult.data ?? []).map((location) => ({
          id: location.id,
          name: location.name,
          isActive: location.is_active,
        }))}
        keys={keys}
        blockFilters={filters}
      />
    </div>
  );
}
