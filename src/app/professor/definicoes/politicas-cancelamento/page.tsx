import { ArrowLeft, CircleCheck, Layers3, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { CancellationPolicyForm } from "@/components/cancellation-policies/cancellation-policy-form";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { CancellationPolicy } from "@/types/database";

export const metadata: Metadata = { title: "Políticas de cancelamento" };
export const dynamic = "force-dynamic";

const RULE_LABELS = {
  charge: "Consumir créditos",
  refund: "Devolver créditos",
  teacher_decides: "Professor decide",
} as const;

function effectiveSource(policy: CancellationPolicy, teacherId: string): string {
  return policy.teacher_id === teacherId ? "Política ativa do professor" : "Política padrão da organização";
}

export default async function CancellationPoliciesPage() {
  const user = await requireRole("teacher", "/professor/definicoes/politicas-cancelamento");
  if (!user.teacherId || !user.profile.organization_id) {
    throw new Error("Não foi possível identificar o professor e a organização.");
  }

  const supabase = await createSupabaseServerClient();
  const [teacherPolicyResult, organizationPolicyResult, effectiveResult] = await Promise.all([
    supabase
      .from("cancellation_policies")
      .select("id, organization_id, teacher_id, name, min_hours_before_cancel, late_cancellation, student_no_show, allow_manual_exceptions, is_active, is_default, created_at, updated_at")
      .eq("teacher_id", user.teacherId)
      .maybeSingle(),
    supabase
      .from("cancellation_policies")
      .select("id, organization_id, teacher_id, name, min_hours_before_cancel, late_cancellation, student_no_show, allow_manual_exceptions, is_active, is_default, created_at, updated_at")
      .eq("organization_id", user.profile.organization_id)
      .is("teacher_id", null)
      .eq("is_default", true)
      .maybeSingle(),
    supabase.rpc("resolve_cancellation_policy", { p_teacher_id: user.teacherId }),
  ]);

  if (teacherPolicyResult.error || organizationPolicyResult.error || effectiveResult.error) {
    console.error(
      "[AulaFlow] Falha ao carregar as políticas de cancelamento.",
      teacherPolicyResult.error ?? organizationPolicyResult.error ?? effectiveResult.error,
    );
    throw new Error("Não foi possível carregar as políticas de cancelamento.");
  }

  const organizationPolicy = organizationPolicyResult.data;
  const effective = effectiveResult.data;
  if (!organizationPolicy || !effective) {
    throw new Error("A organização não tem uma política padrão válida.");
  }

  const teacherPolicy = teacherPolicyResult.data;
  const formSource = teacherPolicy ?? effective;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/professor/definicoes" className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}>
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar às definições
        </Link>
        <p className="text-sm font-bold tracking-wide text-brand uppercase">Regras de créditos</p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Políticas de cancelamento</h1>
        <p className="mt-1 text-sm text-muted">Configure e teste a regra; a aplicação às aulas chega nas fases de calendário e presenças.</p>
      </div>

      <Alert tone="info" title="Configuração apenas">
        Esta fase guarda e resolve a política. Ainda não existem botões de cancelar aulas nem alterações visuais de créditos.
      </Alert>

      <Card variant="plain">
        <CardHeader title={<span className="inline-flex items-center gap-2"><CircleCheck className="size-5 text-state-success" aria-hidden="true" />Política efetiva</span>} description={effectiveSource(effective, user.teacherId)} action={<Badge tone="success">Em vigor</Badge>} />
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs font-bold tracking-wide text-muted uppercase">Nome</dt><dd className="mt-1 font-semibold text-ink">{effective.name}</dd></div>
            <div><dt className="text-xs font-bold tracking-wide text-muted uppercase">Prazo</dt><dd className="mt-1 font-semibold text-ink">{effective.min_hours_before_cancel} horas</dd></div>
            <div><dt className="text-xs font-bold tracking-wide text-muted uppercase">Cancelamento tardio</dt><dd className="mt-1 font-semibold text-ink">{RULE_LABELS[effective.late_cancellation]}</dd></div>
            <div><dt className="text-xs font-bold tracking-wide text-muted uppercase">Falta do aluno</dt><dd className="mt-1 font-semibold text-ink">{RULE_LABELS[effective.student_no_show]}</dd></div>
          </dl>
        </CardBody>
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
        <CancellationPolicyForm
          hasTeacherOverride={teacherPolicy !== null}
          values={{
            name: teacherPolicy?.name ?? "Política do professor",
            minHoursBeforeCancel: formSource.min_hours_before_cancel,
            lateCancellation: formSource.late_cancellation,
            studentNoShow: formSource.student_no_show,
            allowManualExceptions: formSource.allow_manual_exceptions,
            isActive: teacherPolicy?.is_active ?? true,
          }}
        />

        <div className="flex flex-col gap-6">
          <Card variant="plain">
            <CardHeader title={<span className="inline-flex items-center gap-2"><Layers3 className="size-5 text-brand" aria-hidden="true" />Precedência</span>} description="A decisão é resolvida no PostgreSQL, não no browser." />
            <CardBody>
              <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-ink-soft">
                <li><strong className="text-ink">Política específica aplicável.</strong> Camada preparada para um contexto futuro; não é configurada sem aulas nesta fase.</li>
                <li><strong className="text-ink">Política ativa do professor.</strong> É a substituição que este formulário gere.</li>
                <li><strong className="text-ink">Política da organização.</strong> Funciona como fallback obrigatório.</li>
                <li><strong className="text-ink">Padrão do sistema.</strong> Os seus valores são materializados ao criar a organização.</li>
              </ol>
            </CardBody>
          </Card>

          <Card variant="plain">
            <CardHeader title="Fallback da organização" description="É somente leitura para o professor e nunca fica sem uma regra válida." />
            <CardBody>
              <p className="font-bold text-ink">{organizationPolicy.name}</p>
              <p className="mt-1 text-sm text-muted">{organizationPolicy.min_hours_before_cancel} horas · {RULE_LABELS[organizationPolicy.late_cancellation]} em cancelamento tardio</p>
              <div className="mt-4 inline-flex items-start gap-2 rounded-[var(--radius-field)] bg-sand-deep p-3 text-xs text-muted"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />Professores não conseguem alterar a organização, o proprietário ou a marca de política padrão através do formulário.</div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
