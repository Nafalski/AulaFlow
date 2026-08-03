import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { StudentForm } from "@/components/students/student-form";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Novo aluno" };
export const dynamic = "force-dynamic";

export default async function NewStudentPage() {
  await requireRole("teacher", "/professor/alunos/novo");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header>
        <Link
          href="/professor/alunos"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Voltar aos alunos
        </Link>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Novo aluno</h1>
        <p className="mt-1 text-sm text-muted">
          Registe os dados administrativos necessários para começar a organizar as aulas.
        </p>
      </header>

      <Alert tone="info" title="Não é necessária uma conta">
        Pode criar a ficha agora. A ligação a uma conta confirmada é preparada depois, por email.
      </Alert>

      <StudentForm
        mode="create"
        values={{
          fullName: "",
          email: null,
          phone: null,
          birthDate: null,
          skillLevel: null,
          notes: null,
        }}
      />
    </div>
  );
}
