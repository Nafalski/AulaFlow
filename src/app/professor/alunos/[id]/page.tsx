import { ArrowLeft, CalendarDays, Mail, PackageCheck, Phone, UserRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StudentForm } from "@/components/students/student-form";
import {
  StudentGroupsSummary,
  type StudentGroupSummaryItem,
} from "@/components/students/student-groups-summary";
import { StudentInvitationCard } from "@/components/students/student-invitation-card";
import {
  StudentPackageSummary,
  type StudentPackageSummaryData,
} from "@/components/students/student-package-summary";
import { StudentPackageListCard } from "@/components/students/student-package-list";
import { StudentStatusBadges } from "@/components/students/student-status-badges";
import { StudentStatusForm } from "@/components/students/student-status-form";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import { PACKAGE_ORIGIN_LABELS } from "@/lib/domain/package-display";
import { formatFullDate, lisbonDateKey } from "@/lib/datetime";
import { pageQueryRange, pageSlice, readPageNumber, type UrlSearchParams } from "@/lib/pagination";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { studentIdSchema } from "@/lib/validation/students";
import { initials } from "@/lib/utils";

const STUDENT_DETAIL_COLUMNS =
  "id, organization_id, created_by_teacher_id, profile_id, full_name, email, phone, birth_date, skill_level, notes, is_active, claimed_at, created_at, updated_at, account_status, account_email, invitation_id, invitation_status, invitation_prepared_at";
const PACKAGE_SUMMARY_COLUMNS =
  "student_id, package_count, usable_package_count, credits_available, credits_reserved, credits_used";
const STUDENT_PACKAGE_COLUMNS =
  "id, student_id, student_name, name, sport_name, initial_credits, credits_available, credits_reserved, credits_used, starts_on, expires_on, status, origin, paid_amount_cents, notes, created_at";
const PACKAGE_PAGE_SIZE = 12;
const GROUP_PAGE_SIZE = 12;

const EMPTY_PACKAGE_SUMMARY: StudentPackageSummaryData = {
  package_count: 0,
  usable_package_count: 0,
  credits_available: 0,
  credits_reserved: 0,
  credits_used: 0,
};

export const metadata: Metadata = { title: "Ficha do aluno" };
export const dynamic = "force-dynamic";

async function loadStudentGroups(
  studentId: string,
  teacherId: string,
  organizationId: string,
  page: number,
): Promise<{ groups: StudentGroupSummaryItem[]; hasNext: boolean }> {
  const supabase = await createSupabaseServerClient();
  const range = pageQueryRange(page, GROUP_PAGE_SIZE);
  const { data: memberships, error: membershipError } = await supabase
    .from("group_members")
    .select("group_id, joined_at")
    .eq("student_id", studentId)
    .eq("is_active", true)
    .order("joined_at", { ascending: false })
    .order("group_id", { ascending: false })
    .range(range.from, range.to);

  if (membershipError) {
    console.error("[AulaFlow] Falha ao carregar as turmas do aluno.", membershipError);
    throw new Error("Não foi possível carregar as turmas do aluno.");
  }

  const pagedMemberships = pageSlice(memberships, GROUP_PAGE_SIZE);
  const groupIds = pagedMemberships.rows.map((membership) => membership.group_id);
  if (groupIds.length === 0) return { groups: [], hasNext: false };

  const { data, error } = await supabase
    .from("groups")
    .select("id, name, is_active")
    .in("id", groupIds)
    .eq("teacher_id", teacherId)
    .eq("organization_id", organizationId)
    .order("name");

  if (error) {
    console.error("[AulaFlow] Falha ao confirmar as turmas do aluno.", error);
    throw new Error("Não foi possível carregar as turmas do aluno.");
  }

  const groupsById = new Map(data.map((group) => [group.id, group]));
  return {
    groups: groupIds.flatMap((groupId) => {
      const group = groupsById.get(groupId);
      return group ? [group] : [];
    }),
    hasNext: pagedMemberships.hasNext,
  };
}

export default async function StudentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<UrlSearchParams>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const packagePage = readPageNumber(resolvedSearchParams.paginaPacotes);
  const groupPage = readPageNumber(resolvedSearchParams.paginaTurmas);
  const parsedId = studentIdSchema.safeParse({ studentId: id });
  if (!parsedId.success) notFound();

  const user = await requireRole("teacher", `/professor/alunos/${id}`);
  if (!user.teacherId || !user.profile.organization_id) {
    throw new Error("Não foi possível confirmar a identidade do professor.");
  }

  const supabase = await createSupabaseServerClient();
  const packageRange = pageQueryRange(packagePage, PACKAGE_PAGE_SIZE);
  const { data: student, error } = await supabase
    .from("teacher_student_management_records")
    .select(STUDENT_DETAIL_COLUMNS)
    .eq("id", parsedId.data.studentId)
    .eq("organization_id", user.profile.organization_id)
    .eq("created_by_teacher_id", user.teacherId)
    .maybeSingle();

  if (error) {
    console.error("[AulaFlow] Falha ao carregar a ficha do aluno.", error);
    throw new Error("Não foi possível carregar a ficha do aluno.");
  }
  if (!student) notFound();

  const [packageResult, packageListResult, groups] = await Promise.all([
    supabase
      .from("teacher_student_package_summary")
      .select(PACKAGE_SUMMARY_COLUMNS)
      .eq("student_id", student.id)
      .maybeSingle(),
    supabase
      .from("teacher_package_records")
      .select(STUDENT_PACKAGE_COLUMNS)
      .eq("student_id", student.id)
      .order("status", { ascending: true })
      .order("expires_on", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(packageRange.from, packageRange.to),
    loadStudentGroups(student.id, user.teacherId, user.profile.organization_id, groupPage),
  ]);

  if (packageResult.error) {
    console.error("[AulaFlow] Falha ao carregar o resumo de pacotes do aluno.", packageResult.error);
    throw new Error("Não foi possível carregar o resumo de pacotes do aluno.");
  }
  if (packageListResult.error) {
    console.error("[AulaFlow] Falha ao carregar pacotes do aluno.", packageListResult.error);
    throw new Error("Não foi possível carregar os pacotes do aluno.");
  }

  const packageSummary = packageResult.data ?? EMPTY_PACKAGE_SUMMARY;
  const pagedPackages = pageSlice(packageListResult.data ?? [], PACKAGE_PAGE_SIZE);
  const packages = pagedPackages.rows.map((pack) => ({
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
    notes: pack.notes,
    createdAt: pack.created_at,
  }));
  const today = lisbonDateKey(new Date());

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/professor/alunos"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Voltar aos alunos
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex size-14 shrink-0 items-center justify-center rounded-full bg-brand-soft text-lg font-extrabold text-brand-deep"
              aria-hidden="true"
            >
              {initials(student.full_name)}
            </span>
            <div className="min-w-0">
              <h1 className="break-words text-2xl font-extrabold tracking-tight text-ink">
                {student.full_name}
              </h1>
              <p className="mt-0.5 break-all text-sm text-muted">
                {student.email ?? "Ficha sem email"}
              </p>
            </div>
          </div>
          <StudentStatusBadges student={student} />
        </div>
      </header>

      <Card variant="plain">
        <CardHeader title="Resumo da ficha" description="Dados de consulta rápida." />
        <CardBody>
          <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs font-bold tracking-wide text-muted uppercase">Email</dt>
              <dd className="mt-1 flex items-start gap-2 break-all text-sm text-ink">
                <Mail className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                {student.email ?? "Não indicado"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold tracking-wide text-muted uppercase">Telefone</dt>
              <dd className="mt-1 flex items-center gap-2 text-sm text-ink">
                <Phone className="size-4 shrink-0 text-muted" aria-hidden="true" />
                {student.phone ?? "Não indicado"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold tracking-wide text-muted uppercase">Nascimento</dt>
              <dd className="mt-1 flex items-center gap-2 text-sm text-ink">
                <CalendarDays className="size-4 shrink-0 text-muted" aria-hidden="true" />
                {student.birth_date ? formatFullDate(student.birth_date) : "Não indicado"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold tracking-wide text-muted uppercase">Nível</dt>
              <dd className="mt-1 flex items-center gap-2 text-sm text-ink">
                <UserRound className="size-4 shrink-0 text-muted" aria-hidden="true" />
                {student.skill_level ? <Badge>{student.skill_level}</Badge> : "Não indicado"}
              </dd>
            </div>
          </dl>
          <p className="mt-5 text-xs text-muted">Ficha criada em {formatFullDate(student.created_at)}.</p>
        </CardBody>
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <StudentForm
          mode="edit"
          linkedAccount={Boolean(student.profile_id)}
          accountEmail={student.account_email}
          values={{
            id: student.id,
            fullName: student.full_name,
            email: student.email,
            phone: student.phone,
            birthDate: student.birth_date,
            skillLevel: student.skill_level,
            notes: student.notes,
          }}
        />

        <div className="flex flex-col gap-6">
          <Link
            href={`/professor/pacotes/atribuir?studentId=${student.id}`}
            className={buttonClasses({ variant: "accent", fullWidth: true })}
          >
            <PackageCheck className="size-4.5" aria-hidden="true" />
            Atribuir pacote
          </Link>
          <StudentInvitationCard
            studentId={student.id}
            email={student.email}
            isActive={student.is_active}
            profileId={student.profile_id}
            accountStatus={student.account_status}
            accountEmail={student.account_email}
            invitationId={student.invitation_id}
            invitationStatus={student.invitation_status}
            invitationPreparedAt={student.invitation_prepared_at}
          />
          <StudentPackageSummary summary={packageSummary} />
          <StudentPackageListCard packages={packages} today={today} />
          <Pagination
            basePath={`/professor/alunos/${student.id}`}
            searchParams={resolvedSearchParams}
            page={packagePage}
            hasNext={pagedPackages.hasNext}
            pageParam="paginaPacotes"
          />
          <StudentGroupsSummary groups={groups.groups} />
          <Pagination
            basePath={`/professor/alunos/${student.id}`}
            searchParams={resolvedSearchParams}
            page={groupPage}
            hasNext={groups.hasNext}
            pageParam="paginaTurmas"
          />
          <StudentStatusForm
            studentId={student.id}
            fullName={student.full_name}
            isActive={student.is_active}
          />
        </div>
      </div>
    </div>
  );
}
