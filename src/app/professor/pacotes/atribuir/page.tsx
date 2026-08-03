import { ArrowLeft } from "lucide-react";
import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";

import {
  PackageAssignmentForm,
  type PackageAssignmentSportOption,
  type PackageAssignmentStudentOption,
  type PackageAssignmentTemplateOption,
} from "@/components/package-assignments/package-assignment-form";
import { buttonClasses } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/session";
import { lisbonDateKey } from "@/lib/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Atribuir pacote" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AssignPackagePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user = await requireRole("teacher", "/professor/pacotes/atribuir");
  const teacherId = user.teacherId;
  const organizationId = user.profile.organization_id;
  if (!teacherId || !organizationId) {
    throw new Error("Não foi possível confirmar a identidade do professor.");
  }

  const supabase = await createSupabaseServerClient();
  const [studentsResult, templatesResult, sportsResult] = await Promise.all([
    supabase
      .from("teacher_student_management_records")
      .select("id, full_name, email, phone")
      .eq("organization_id", organizationId)
      .eq("created_by_teacher_id", teacherId)
      .eq("is_active", true)
      .order("full_name")
      .limit(250),
    supabase
      .from("package_templates")
      .select("id, name, description, default_credits, sport_id, validity_days, reference_price_cents")
      .eq("organization_id", organizationId)
      .eq("teacher_id", teacherId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("sports")
      .select("id, name, icon")
      .eq("is_active", true)
      .order("name"),
  ]);

  if (studentsResult.error) {
    console.error("[AulaFlow] Falha ao carregar alunos para atribuição.", studentsResult.error);
    throw new Error("Não foi possível carregar os alunos.");
  }
  if (templatesResult.error) {
    console.error("[AulaFlow] Falha ao carregar modelos para atribuição.", templatesResult.error);
    throw new Error("Não foi possível carregar os modelos.");
  }
  if (sportsResult.error) {
    console.error("[AulaFlow] Falha ao carregar modalidades para atribuição.", sportsResult.error);
    throw new Error("Não foi possível carregar as modalidades.");
  }

  const students: PackageAssignmentStudentOption[] = (studentsResult.data ?? []).map((student) => ({
    id: student.id,
    fullName: student.full_name,
    email: student.email,
    phone: student.phone,
  }));

  const templates: PackageAssignmentTemplateOption[] = (templatesResult.data ?? []).map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    defaultCredits: template.default_credits,
    sportId: template.sport_id,
    validityDays: template.validity_days,
    referencePriceCents: template.reference_price_cents,
  }));

  const sports: PackageAssignmentSportOption[] = (sportsResult.data ?? []).map((sport) => ({
    id: sport.id,
    name: sport.name,
    icon: sport.icon,
  }));

  const initialStudentId = firstParam(params.studentId);
  const initialTemplateId = firstParam(params.templateId);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/professor/pacotes"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Voltar aos pacotes
        </Link>
        <div>
          <p className="text-sm font-bold tracking-wide text-brand uppercase">Pacotes</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">
            Atribuir pacote a aluno
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Crie um pacote concreto com saldos iniciais e histórico gerados numa única operação.
          </p>
        </div>
      </header>

      <PackageAssignmentForm
        students={students}
        templates={templates}
        sports={sports}
        today={lisbonDateKey(new Date())}
        idempotencyKey={randomUUID()}
        initialStudentId={initialStudentId}
        initialTemplateId={initialTemplateId}
      />
    </div>
  );
}
