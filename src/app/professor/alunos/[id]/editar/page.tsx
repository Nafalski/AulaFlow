import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StudentForm } from "@/components/students/student-form";
import { buttonClasses } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { studentIdSchema } from "@/lib/validation/students";

/**
 * Editar a ficha, numa rota própria.
 *
 * A ficha do aluno abria com o formulário de edição inteiro montado, ao lado de
 * tudo o resto. Mas abrir a ficha de alguém é quase sempre ir ver um telefone,
 * um saldo ou uma turma — editar é uma decisão, e uma decisão pede um sítio.
 *
 * A mesma escolha já tinha sido feita para reagendar uma aula: dois submits com
 * consequências diferentes não partilham ecrã.
 */
export const metadata: Metadata = { title: "Editar aluno" };
export const dynamic = "force-dynamic";

const EDIT_COLUMNS = "id, full_name, email, phone, birth_date, skill_level, notes, profile_id, account_email";

export default async function EditStudentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsedId = studentIdSchema.safeParse({ studentId: id });
  if (!parsedId.success) notFound();

  const user = await requireRole("teacher", `/professor/alunos/${id}/editar`);
  if (!user.teacherId || !user.profile.organization_id) {
    throw new Error("Não foi possível confirmar a identidade do professor.");
  }

  const supabase = await createSupabaseServerClient();
  const { data: student, error } = await supabase
    .from("teacher_student_management_records")
    .select(EDIT_COLUMNS)
    .eq("id", parsedId.data.studentId)
    .eq("organization_id", user.profile.organization_id)
    .eq("created_by_teacher_id", user.teacherId)
    .maybeSingle();

  if (error) {
    console.error("[AulaFlow] Falha ao carregar a ficha para edição.", error);
    throw new Error("Não foi possível carregar a ficha do aluno.");
  }
  if (!student) notFound();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href={`/professor/alunos/${student.id}`}
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Voltar à ficha
        </Link>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Editar {student.full_name}</h1>
      </header>

      <div className="max-w-3xl">
        <StudentForm
          mode="edit"
          linkedAccount={Boolean(student.profile_id)}
          accountEmail={student.account_email}
          values={{
            id: student.id,
            fullName: student.full_name,
            email: student.email,
            phone: student.phone,
            birthDate: student.birth_date,
            skillLevel: student.skill_level,
            notes: student.notes,
          }}
        />
      </div>
    </div>
  );
}
