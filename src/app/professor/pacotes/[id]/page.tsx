import { ArrowLeft, CalendarDays, Euro, ShieldCheck, Ticket } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PackageTemplateDuplicateForm } from "@/components/package-templates/package-template-duplicate-form";
import { PackageTemplateForm } from "@/components/package-templates/package-template-form";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  formatEuroCents,
  formatValidityDays,
  packageTemplateIdSchema,
} from "@/lib/validation/package-templates";

export const metadata: Metadata = { title: "Detalhes do modelo" };
export const dynamic = "force-dynamic";

export default async function PackageTemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsedId = packageTemplateIdSchema.safeParse({ packageTemplateId: id });
  if (!parsedId.success) notFound();

  const user = await requireRole("teacher", `/professor/pacotes/${id}`);
  const teacherId = user.teacherId;
  const organizationId = user.profile.organization_id;
  if (!teacherId || !organizationId) {
    throw new Error("Não foi possível confirmar a identidade do professor.");
  }

  const supabase = await createSupabaseServerClient();
  const { data: template, error } = await supabase
    .from("package_templates")
    .select(
      "id, organization_id, teacher_id, sport_id, name, description, default_credits, validity_days, reference_price_cents, is_active, created_at, updated_at",
    )
    .eq("id", parsedId.data.packageTemplateId)
    .eq("organization_id", organizationId)
    .eq("teacher_id", teacherId)
    .maybeSingle();

  if (error) {
    console.error("[AulaFlow] Falha ao carregar detalhe do modelo de pacote.", error);
    throw new Error("Não foi possível carregar o modelo.");
  }
  if (!template) notFound();

  const [sportsResult, assignedCountResult] = await Promise.all([
    supabase.from("sports").select("id, name, icon, is_active").order("name"),
    supabase
      .from("student_packages")
      .select("id", { count: "exact", head: true })
      .eq("template_id", template.id),
  ]);

  if (sportsResult.error || assignedCountResult.error) {
    console.error(
      "[AulaFlow] Falha ao carregar dados relacionados do modelo.",
      sportsResult.error ?? assignedCountResult.error,
    );
    throw new Error("Não foi possível carregar os dados relacionados do modelo.");
  }

  const availableSports = sportsResult.data
    .filter((sport) => sport.is_active || sport.id === template.sport_id)
    .map((sport) => ({
      id: sport.id,
      name: sport.name,
      icon: sport.icon,
      isActive: sport.is_active,
    }));
  const sportName = template.sport_id
    ? sportsResult.data.find((sport) => sport.id === template.sport_id)?.name ?? null
    : null;
  const assignedCount = assignedCountResult.count ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/professor/pacotes"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar aos pacotes
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">{template.name}</h1>
            <p className="mt-1 text-sm text-muted">
              {sportName ?? "Todas as modalidades"} · {template.default_credits} aula{template.default_credits === 1 ? "" : "s"}
            </p>
          </div>
          <Badge tone={template.is_active ? "success" : "neutral"}>
            {template.is_active ? "Ativo" : "Inativo"}
          </Badge>
        </div>
      </div>

      <Alert tone="info">
        <span className="inline-flex items-center gap-2">
          <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
          Alterar este modelo não modifica pacotes já atribuídos aos alunos.
        </span>
      </Alert>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <PackageTemplateForm
          mode="edit"
          values={{
            id: template.id,
            name: template.name,
            defaultCredits: template.default_credits,
            sportId: template.sport_id,
            description: template.description,
            validityDays: template.validity_days,
            referencePriceCents: template.reference_price_cents,
            isActive: template.is_active,
          }}
          sports={availableSports}
        />

        <div className="flex flex-col gap-6">
          <Card variant="plain">
            <CardHeader title="Resumo" description="Condições usadas em futuras atribuições." />
            <CardBody>
              <dl className="grid gap-4">
                <div>
                  <dt className="inline-flex items-center gap-2 text-xs font-bold tracking-wide text-muted uppercase">
                    <Ticket className="size-4" aria-hidden="true" /> Quantidade
                  </dt>
                  <dd className="mt-1 text-sm text-ink">{template.default_credits} crédito{template.default_credits === 1 ? "" : "s"}</dd>
                </div>
                <div>
                  <dt className="inline-flex items-center gap-2 text-xs font-bold tracking-wide text-muted uppercase">
                    <CalendarDays className="size-4" aria-hidden="true" /> Validade
                  </dt>
                  <dd className="mt-1 text-sm text-ink">{formatValidityDays(template.validity_days)}</dd>
                </div>
                <div>
                  <dt className="inline-flex items-center gap-2 text-xs font-bold tracking-wide text-muted uppercase">
                    <Euro className="size-4" aria-hidden="true" /> Valor
                  </dt>
                  <dd className="mt-1 text-sm text-ink">{formatEuroCents(template.reference_price_cents)}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card variant="plain">
            <CardHeader
              title="Origem preservada"
              description={`${assignedCount} pacote${assignedCount === 1 ? "" : "s"} atribuído${assignedCount === 1 ? "" : "s"} a partir deste modelo.`}
            />
            <CardBody>
              <p className="text-sm text-muted">
                A contagem é apenas informativa nesta etapa. Saldos, ajustes e histórico visual ficam para as próximas partes.
              </p>
            </CardBody>
          </Card>

          <Card variant="plain">
            <CardHeader title="Duplicar" description="Útil para criar variações de quantidade ou validade." />
            <CardBody>
              <PackageTemplateDuplicateForm packageTemplateId={template.id} />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
