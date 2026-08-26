import { History, PackageCheck, PackagePlus, Ticket } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { TeacherPackageFiltersForm } from "@/components/package-assignments/teacher-package-filters";
import type { TeacherPackageFilters } from "@/components/package-assignments/teacher-package-filters";
import {
  TeacherPackageList,
  type TeacherPackageListEntry,
} from "@/components/package-assignments/teacher-package-list";
import { PackageTemplateFiltersForm } from "@/components/package-templates/package-template-filters";
import {
  PackageTemplateList,
  type PackageTemplateListEntry,
} from "@/components/package-templates/package-template-list";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/status-badge";
import { PACKAGE_ORIGIN_LABELS } from "@/lib/domain/package-display";
import { EXPIRY_WARNING_DAYS, LOW_BALANCE_THRESHOLD } from "@/lib/domain/packages";
import { lisbonDateKey } from "@/lib/datetime";
import { requireRole } from "@/lib/auth/session";
import { pageQueryRange, pageSlice, readPageNumber } from "@/lib/pagination";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  packageTemplateFiltersSchema,
  readPackageTemplateFilters,
} from "@/lib/validation/package-templates";
import type { PackageStatus } from "@/types/database";

export const metadata: Metadata = { title: "Pacotes" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
type Tab = "templates" | "assigned";
const ASSIGNED_PAGE_SIZE = 25;
const ASSIGNED_COLUMNS =
  "id, student_id, student_name, name, sport_id, sport_name, initial_credits, credits_available, credits_reserved, credits_used, starts_on, expires_on, status, origin, paid_amount_cents, created_at";
const EXACT_COUNT_OPTIONS = { count: "exact", head: true } as const;

function valueOf(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function readTab(params: SearchParams): Tab {
  return valueOf(params, "tab") === "assigned" ? "assigned" : "templates";
}

const PACKAGE_STATUSES: PackageStatus[] = [
  "not_started",
  "active",
  "depleted",
  "expired",
  "suspended",
  "cancelled",
];

function readAssignedFilters(params: SearchParams) {
  const status = valueOf(params, "status");
  const balance = valueOf(params, "balance");
  const expiry = valueOf(params, "expiry");
  const sportId = valueOf(params, "sportId");
  const search = (valueOf(params, "search") ?? "").trim().slice(0, 120);
  const parsedStatus: TeacherPackageFilters["status"] =
    status && PACKAGE_STATUSES.includes(status as PackageStatus) ? (status as PackageStatus) : "all";
  const parsedBalance: TeacherPackageFilters["balance"] =
    balance === "low" || balance === "empty" ? balance : "all";
  const parsedExpiry: TeacherPackageFilters["expiry"] =
    expiry === "soon" || expiry === "expired" ? expiry : "all";

  return {
    tab: "assigned" as const,
    search,
    status: parsedStatus,
    sportId: sportId && /^[0-9a-f-]{36}$/i.test(sportId) ? sportId : null,
    balance: parsedBalance,
    expiry: parsedExpiry,
  };
}

function toEntry(pack: {
  id: string;
  student_id: string;
  student_name: string;
  name: string;
  sport_name: string | null;
  initial_credits: number;
  credits_available: number;
  credits_reserved: number;
  credits_used: number;
  starts_on: string;
  expires_on: string | null;
  status: PackageStatus;
  origin: keyof typeof PACKAGE_ORIGIN_LABELS;
  paid_amount_cents: number | null;
  created_at: string;
}): TeacherPackageListEntry {
  return {
    id: pack.id,
    studentId: pack.student_id,
    studentName: pack.student_name,
    name: pack.name,
    sportName: pack.sport_name,
    initialCredits: pack.initial_credits,
    creditsAvailable: pack.credits_available,
    creditsReserved: pack.credits_reserved,
    creditsUsed: pack.credits_used,
    startsOn: pack.starts_on,
    expiresOn: pack.expires_on,
    status: pack.status,
    originLabel: PACKAGE_ORIGIN_LABELS[pack.origin],
    paidAmountCents: pack.paid_amount_cents,
    createdAt: pack.created_at,
  };
}

export default async function TeacherPackagesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const rawSearchParams = await searchParams;
  const tab = readTab(rawSearchParams);
  const assignedPage = readPageNumber(rawSearchParams.pagina);
  const user = await requireRole("teacher", "/professor/pacotes");
  const teacherId = user.teacherId;
  const organizationId = user.profile.organization_id;
  if (!teacherId || !organizationId) {
    throw new Error("Não foi possível confirmar a identidade do professor.");
  }

  const supabase = await createSupabaseServerClient();
  const { data: sports, error: sportsError } = await supabase
    .from("sports")
    .select("id, name")
    .eq("is_active", true)
    .order("name");

  if (sportsError) {
    console.error("[AulaFlow] Falha ao carregar modalidades para filtros de pacotes.", sportsError);
    throw new Error("Não foi possível carregar as modalidades.");
  }

  const today = lisbonDateKey(new Date());
  const sportNames = new Map(sports.map((sport) => [sport.id, sport.name]));
  const parsedTemplateFilters = packageTemplateFiltersSchema.safeParse(
    readPackageTemplateFilters(rawSearchParams),
  );
  const templateFilters = parsedTemplateFilters.success
    ? parsedTemplateFilters.data
    : { search: "", status: "all" as const, sportId: null };

  let templateQuery = supabase
    .from("package_templates")
    .select("id, name, default_credits, sport_id, validity_days, reference_price_cents, is_active")
    .eq("organization_id", organizationId)
    .eq("teacher_id", teacherId)
    .order("name");

  if (templateFilters.search) {
    templateQuery = templateQuery.ilike("name", `%${escapeLikePattern(templateFilters.search)}%`);
  }
  if (templateFilters.status !== "all") {
    templateQuery = templateQuery.eq("is_active", templateFilters.status === "active");
  }
  if (templateFilters.sportId) templateQuery = templateQuery.eq("sport_id", templateFilters.sportId);

  const assignedFilters = readAssignedFilters(rawSearchParams);
  const assignedRange = pageQueryRange(assignedPage, ASSIGNED_PAGE_SIZE);
  const expiryWarningDate = addDateDays(today, EXPIRY_WARNING_DAYS);

  const buildAssignedQuery = (countOnly = false) => {
    let query = supabase
      .from("teacher_package_records")
      .select(ASSIGNED_COLUMNS, countOnly ? EXACT_COUNT_OPTIONS : undefined);

    if (assignedFilters.search) {
      const pattern = `%${escapeLikePattern(assignedFilters.search)}%`;
      query = query.or(`name.ilike.${pattern},student_name.ilike.${pattern}`);
    }
    if (assignedFilters.status !== "all") query = query.eq("status", assignedFilters.status);
    if (assignedFilters.sportId) query = query.eq("sport_id", assignedFilters.sportId);
    if (assignedFilters.balance === "low") {
      query = query
        .gte("credits_available", 1)
        .lte("credits_available", LOW_BALANCE_THRESHOLD);
    } else if (assignedFilters.balance === "empty") {
      query = query.eq("credits_available", 0);
    }
    if (assignedFilters.expiry === "soon") {
      query = query.gte("expires_on", today).lte("expires_on", expiryWarningDate);
    } else if (assignedFilters.expiry === "expired") {
      query = query.lt("expires_on", today);
    }

    return query;
  };

  const assignedQuery = buildAssignedQuery()
    .order("operational_sort_rank", { ascending: true })
    .order("expires_on", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(assignedRange.from, assignedRange.to);

  const assignedSummaryPromise = tab === "assigned"
    ? Promise.all([
        buildAssignedQuery(true).eq("status", "active"),
        buildAssignedQuery(true)
          .gte("credits_available", 1)
          .lte("credits_available", LOW_BALANCE_THRESHOLD),
        buildAssignedQuery(true).eq("credits_available", 0),
        buildAssignedQuery(true).gte("expires_on", today).lte("expires_on", expiryWarningDate),
        buildAssignedQuery(true).lt("expires_on", today),
      ])
    : Promise.resolve(null);

  const [templateResult, assignedResult, summaryResults] = await Promise.all([
    templateQuery,
    assignedQuery,
    assignedSummaryPromise,
  ]);

  if (templateResult.error) {
    console.error("[AulaFlow] Falha ao carregar modelos de pacotes.", templateResult.error);
    throw new Error("Não foi possível carregar os modelos de pacotes.");
  }
  if (assignedResult.error) {
    console.error("[AulaFlow] Falha ao carregar pacotes atribuídos.", assignedResult.error);
    throw new Error("Não foi possível carregar os pacotes atribuídos.");
  }
  const summaryError = summaryResults?.find((result) => result.error)?.error;
  if (summaryError) {
    console.error("[AulaFlow] Falha ao resumir os pacotes atribuídos.", summaryError);
    throw new Error("Não foi possível calcular o resumo dos pacotes atribuídos.");
  }

  const templates: PackageTemplateListEntry[] = (templateResult.data ?? []).map((template) => ({
    id: template.id,
    name: template.name,
    defaultCredits: template.default_credits,
    sportName: template.sport_id ? sportNames.get(template.sport_id) ?? null : null,
    validityDays: template.validity_days,
    referencePriceCents: template.reference_price_cents,
    isActive: template.is_active,
  }));

  const pagedAssigned = pageSlice(assignedResult.data ?? [], ASSIGNED_PAGE_SIZE);
  const assignedPackages = pagedAssigned.rows.map(toEntry);
  const assignedSummary = {
    active: summaryResults?.[0].count ?? 0,
    low: summaryResults?.[1].count ?? 0,
    empty: summaryResults?.[2].count ?? 0,
    expiring: summaryResults?.[3].count ?? 0,
    expired: summaryResults?.[4].count ?? 0,
  };
  const hasTemplateFilters =
    templateFilters.search !== "" || templateFilters.status !== "all" || templateFilters.sportId !== null;
  const hasAssignedFilters =
    assignedFilters.search !== "" ||
    assignedFilters.status !== "all" ||
    assignedFilters.sportId !== null ||
    assignedFilters.balance !== "all" ||
    assignedFilters.expiry !== "all";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold tracking-wide text-brand uppercase">Gestão de pacotes</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Pacotes</h1>
          <p className="mt-1 text-sm text-muted">
            Gere modelos reutilizáveis e consulta os pacotes reais atribuídos aos alunos.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/professor/pacotes/historico" className={buttonClasses({ variant: "outline" })}>
            <History className="size-4.5" aria-hidden="true" /> Histórico
          </Link>
          <Link href="/professor/pacotes/atribuir" className={buttonClasses({ variant: "accent" })}>
            <PackageCheck className="size-4.5" aria-hidden="true" /> Atribuir pacote
          </Link>
          <Link href="/professor/pacotes/novo" className={buttonClasses({ variant: "outline" })}>
            <PackagePlus className="size-4.5" aria-hidden="true" /> Novo modelo
          </Link>
        </div>
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="Áreas de pacotes">
        <Link
          href="/professor/pacotes?tab=templates"
          className={buttonClasses({ variant: tab === "templates" ? "primary" : "outline" })}
        >
          Modelos de pacotes
        </Link>
        <Link
          href="/professor/pacotes?tab=assigned"
          className={buttonClasses({ variant: tab === "assigned" ? "primary" : "outline" })}
        >
          Pacotes atribuídos
        </Link>
      </nav>

      {!parsedTemplateFilters.success && tab === "templates" && (
        <Alert tone="warning" title="Filtros inválidos ignorados">
          A pesquisa foi reposta. Volte a escolher os filtros pretendidos.
        </Alert>
      )}

      {tab === "templates" ? (
        <>
          <PackageTemplateFiltersForm filters={templateFilters} sports={sports} />
          {templates.length === 0 ? (
            <EmptyState
              icon={Ticket}
              title={hasTemplateFilters ? "Nenhum modelo corresponde aos filtros" : "Ainda não existem modelos de pacotes"}
              description={
                hasTemplateFilters
                  ? "Altere ou limpe os filtros para voltar a ver todos os modelos."
                  : "Crie um modelo para reutilizar ao atribuir aulas aos alunos."
              }
              action={
                !hasTemplateFilters ? (
                  <Link href="/professor/pacotes/novo" className={buttonClasses()}>
                    Criar modelo
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <PackageTemplateList templates={templates} />
          )}
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <SummaryMetric metric="active" label="Ativos" value={assignedSummary.active} />
            <SummaryMetric metric="low" label="Saldo baixo" value={assignedSummary.low} tone="warning" />
            <SummaryMetric metric="empty" label="Sem saldo" value={assignedSummary.empty} tone="danger" />
            <SummaryMetric metric="expiring" label="A expirar" value={assignedSummary.expiring} tone="warning" />
            <SummaryMetric metric="expired" label="Expirados" value={assignedSummary.expired} tone="danger" />
          </div>
          <TeacherPackageFiltersForm filters={assignedFilters} sports={sports} />
          {assignedPackages.length === 0 ? (
            <EmptyState
              icon={Ticket}
              title={
                assignedPage > 1
                  ? "Esta página já não tem pacotes"
                  : hasAssignedFilters
                    ? "Nenhum pacote corresponde aos filtros"
                    : "Ainda não existem pacotes atribuídos"
              }
              description={
                assignedPage > 1
                  ? "Volte à página anterior para continuar a consultar os pacotes atribuídos."
                  : hasAssignedFilters
                    ? "Altere ou limpe os filtros para voltar a ver todos os pacotes atribuídos."
                    : "Ainda não existem pacotes atribuídos. Atribua um modelo ou crie um pacote personalizado para um aluno."
              }
              action={
                !hasAssignedFilters ? (
                  <Link href="/professor/pacotes/atribuir" className={buttonClasses()}>
                    Atribuir pacote
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <TeacherPackageList packages={assignedPackages} today={today} />
          )}
          <Pagination
            basePath="/professor/pacotes"
            searchParams={rawSearchParams}
            page={assignedPage}
            hasNext={pagedAssigned.hasNext}
          />
        </>
      )}
    </div>
  );
}

function SummaryMetric({
  metric,
  label,
  value,
  tone = "neutral",
}: {
  metric: "active" | "low" | "empty" | "expiring" | "expired";
  label: string;
  value: number;
  tone?: "neutral" | "warning" | "danger";
}) {
  return (
    <div
      data-package-summary={metric}
      className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
    >
      <p data-summary-value className="text-2xl font-extrabold text-ink">{value}</p>
      <p className="mt-1 text-sm font-semibold text-muted">{label}</p>
      {tone !== "neutral" && <Badge tone={tone}>{tone === "danger" ? "Atenção" : "Vigiar"}</Badge>}
    </div>
  );
}

function addDateDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
