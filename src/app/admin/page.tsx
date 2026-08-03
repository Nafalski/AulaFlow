import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card, SectionTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/session";
import { firstName } from "@/lib/utils";

export const metadata: Metadata = { title: "Administração" };

export default async function AdminHomePage() {
  const user = await requireRole("admin");

  return (
    <div className="flex flex-col gap-6">
      <section>
        <p className="text-2xl font-extrabold tracking-tight text-ink">
          Olá, {firstName(user.profile.full_name)}
        </p>
        <p className="mt-0.5 text-sm text-muted">Gestão de contas da plataforma.</p>
      </section>

      <Alert tone="info" title="Âmbito desta área">
        No MVP, a administração serve para ver professores e utilizadores e para bloquear ou
        reativar contas. A gestão de aulas pertence a cada professor.
      </Alert>

      <section>
        <SectionTitle>Estado do sistema</SectionTitle>
        <Card className="p-5">
          <div className="mb-3 flex size-11 items-center justify-center rounded-[var(--radius-field)] bg-state-success-soft">
            <ShieldCheck className="size-5.5 text-state-success" aria-hidden="true" />
          </div>
          <h2 className="text-base font-bold text-ink">Row Level Security ativo</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Todas as tabelas ativam RLS. As tabelas acessíveis ao cliente têm policies
            explícitas; a outbox interna fica em default deny. Os dados de cada professor e
            aluno são isolados pela base de dados, e não apenas pela aplicação.
          </p>
        </Card>
      </section>
    </div>
  );
}
