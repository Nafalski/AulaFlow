import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { randomUUID } from "node:crypto";

import { LocationForm } from "@/components/locations/location-form";
import { buttonClasses } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/session";
import { loadWorkspaceContexts } from "@/lib/auth/workspace-context";
import { availableVisibilities } from "@/lib/domain/locations";
import { canManageMembers } from "@/lib/domain/workspaces";

export const metadata: Metadata = { title: "Novo local" };
export const dynamic = "force-dynamic";

export default async function NewLocationPage() {
  await requireRole("teacher", "/professor/locais/novo");

  // "Do clube" só aparece a quem administra pelo menos um clube ativo: oferecer
  // a opção a quem não a pode usar seria oferecer um erro.
  const contexts = await loadWorkspaceContexts();
  const clubs = contexts
    .filter((context) => !context.isPersonal && canManageMembers(context.role, context.workspaceStatus))
    .map((context) => ({ id: context.organizationId, name: context.organizationName }));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div>
        <Link href="/professor/locais" className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}><ArrowLeft className="size-4" aria-hidden="true" /> Voltar aos locais</Link>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Novo local</h1>
        <p className="mt-1 text-sm text-muted">A organização e o responsável são associados pela sessão, não pelo formulário.</p>
      </div>
      <LocationForm
        mode="create"
        values={{ name: "", address: null, city: null, country: null, postalCode: null, internalReference: null, notes: null }}
        visibilities={availableVisibilities({ managesAnyClub: clubs.length > 0 })}
        clubs={clubs}
        idempotencyKey={randomUUID()}
      />
    </div>
  );
}
