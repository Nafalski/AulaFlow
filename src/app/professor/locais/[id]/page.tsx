import { ArrowLeft, Building2, MapPin, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LocationForm } from "@/components/locations/location-form";
import { LocationStatusForm } from "@/components/locations/location-status-form";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { locationIdSchema } from "@/lib/validation/locations";

export const metadata: Metadata = { title: "Detalhes do local" };
export const dynamic = "force-dynamic";

export default async function LocationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = locationIdSchema.safeParse({ locationId: id });
  if (!parsed.success) notFound();
  const user = await requireRole("teacher", `/professor/locais/${id}`);
  const supabase = await createSupabaseServerClient();
  const [locationResult, organizationResult] = await Promise.all([
    supabase
      .from("teacher_location_records")
      .select("id, teacher_id, name, address, city, country, postal_code, internal_reference, notes, is_active, can_manage, visibility, moderation_status, moderation_reason")
      .eq("id", parsed.data.locationId)
      .maybeSingle(),
    user.profile.organization_id
      ? supabase
          .from("organizations")
          .select("name")
          .eq("id", user.profile.organization_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (locationResult.error) {
    console.error("[AulaFlow] Falha ao carregar o detalhe de um local disponível.", locationResult.error);
    throw new Error("Não foi possível carregar o local.");
  }
  const location = locationResult.data;
  if (!location) notFound();

  if (organizationResult.error) {
    console.error("[AulaFlow] Falha ao carregar a organização do local.", organizationResult.error);
    throw new Error("Não foi possível carregar a organização do local.");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/professor/locais" className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}><ArrowLeft className="size-4" aria-hidden="true" /> Voltar aos locais</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h1 className="text-2xl font-extrabold tracking-tight text-ink">{location.name}</h1><p className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted"><MapPin className="size-4" aria-hidden="true" />{location.city ?? location.address ?? "Localização não indicada"}</p></div>
          <div className="flex flex-wrap gap-1.5">
            {!location.can_manage && <Badge tone="brand">Partilhado</Badge>}
            <Badge tone={location.is_active ? "success" : "neutral"}>{location.is_active ? "Ativo" : "Inativo"}</Badge>
          </div>
        </div>
      </div>

      <Alert tone="info" title={location.can_manage ? undefined : "Local partilhado em modo de consulta"}><span className="inline-flex items-center gap-2"><ShieldCheck className="size-4 shrink-0" aria-hidden="true" />{location.can_manage ? "A referência e as observações administrativas não são expostas aos alunos." : "Pode consultar os dados públicos deste local, mas só o professor responsável pode editar, desativar ou ler os dados administrativos."}</span></Alert>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        {location.can_manage ? (
          <LocationForm mode="edit" values={{ id: location.id, name: location.name, address: location.address, city: location.city, country: location.country, postalCode: location.postal_code, internalReference: location.internal_reference, notes: location.notes }} />
        ) : (
          <Card variant="plain">
            <CardHeader title="Dados do local" description="Informação partilhada na organização, em modo de consulta." />
            <CardBody>
              <dl className="grid gap-4 sm:grid-cols-2">
                <div><dt className="text-xs font-bold tracking-wide text-muted uppercase">Morada</dt><dd className="mt-1 text-sm text-ink">{location.address ?? "Não indicada"}</dd></div>
                <div><dt className="text-xs font-bold tracking-wide text-muted uppercase">Cidade / zona</dt><dd className="mt-1 text-sm text-ink">{location.city ?? "Não indicada"}</dd></div>
              </dl>
            </CardBody>
          </Card>
        )}
        <div className="flex flex-col gap-6">
          <Card variant="plain"><CardHeader title="Responsabilidade" description={location.can_manage ? "Local gerido pelo professor desta sessão." : "Local disponível na mesma organização, gerido por outro responsável."} /><CardBody><p className="inline-flex items-center gap-2 text-sm text-ink"><Building2 className="size-4 text-muted" aria-hidden="true" />{organizationResult.data?.name ?? "Organização da conta"}</p></CardBody></Card>
          {location.can_manage && <Card variant="plain"><CardHeader title="Estado do local" description="Desativar impede apenas a seleção futura." /><CardBody><LocationStatusForm locationId={location.id} locationName={location.name} isActive={location.is_active} /></CardBody></Card>}
        </div>
      </div>
    </div>
  );
}
