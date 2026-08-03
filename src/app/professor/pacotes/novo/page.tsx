import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PackageTemplateForm } from "@/components/package-templates/package-template-form";
import { buttonClasses } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Novo modelo de pacote" };
export const dynamic = "force-dynamic";

export default async function NewPackageTemplatePage() {
  await requireRole("teacher", "/professor/pacotes/novo");
  const supabase = await createSupabaseServerClient();
  const { data: sports, error } = await supabase
    .from("sports")
    .select("id, name, icon")
    .eq("is_active", true)
    .order("name");

  if (error) {
    console.error("[AulaFlow] Falha ao carregar modalidades para novo modelo.", error);
    throw new Error("Não foi possível preparar o formulário de pacote.");
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div>
        <Link
          href="/professor/pacotes"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar aos pacotes
        </Link>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Novo modelo de pacote</h1>
        <p className="mt-1 text-sm text-muted">
          Defina uma opção reutilizável. A atribuição a alunos vem na próxima etapa.
        </p>
      </div>
      <PackageTemplateForm
        mode="create"
        values={{
          name: "",
          defaultCredits: 0,
          sportId: null,
          description: null,
          validityDays: null,
          referencePriceCents: null,
          isActive: true,
        }}
        sports={sports}
      />
    </div>
  );
}
