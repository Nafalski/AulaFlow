import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { GroupForm } from "@/components/groups/group-form";
import { buttonClasses } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Nova turma" };
export const dynamic = "force-dynamic";

export default async function NewGroupPage() {
  await requireRole("teacher", "/professor/grupos/novo");
  const supabase = await createSupabaseServerClient();
  const { data: sports, error } = await supabase
    .from("sports")
    .select("id, name, icon")
    .eq("is_active", true)
    .order("name");

  if (error) {
    console.error("[AulaFlow] Falha ao carregar modalidades para a nova turma.", error);
    throw new Error("Não foi possível preparar o formulário da turma.");
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div>
        <Link href="/professor/grupos" className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}>
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar às turmas
        </Link>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Nova turma</h1>
        <p className="mt-1 text-sm text-muted">Defina os dados administrativos; os membros são adicionados no detalhe.</p>
      </div>
      <GroupForm mode="create" values={{ name: "", sportId: null, description: null, administrativeNotes: null, maxParticipants: null }} sports={sports} />
    </div>
  );
}
