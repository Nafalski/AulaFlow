import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LocationForm } from "@/components/locations/location-form";
import { buttonClasses } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Novo local" };
export const dynamic = "force-dynamic";

export default async function NewLocationPage() {
  await requireRole("teacher", "/professor/locais/novo");
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div>
        <Link href="/professor/locais" className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}><ArrowLeft className="size-4" aria-hidden="true" /> Voltar aos locais</Link>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Novo local</h1>
        <p className="mt-1 text-sm text-muted">A organização e o responsável são associados pela sessão, não pelo formulário.</p>
      </div>
      <LocationForm mode="create" values={{ name: "", address: null, city: null, internalReference: null, notes: null }} />
    </div>
  );
}
