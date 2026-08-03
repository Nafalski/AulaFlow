import { CalendarDays, Link2 } from "lucide-react";
import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card, SectionTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireRole } from "@/lib/auth/session";
import { formatWeekdayDate } from "@/lib/datetime";
import { firstName } from "@/lib/utils";

export const metadata: Metadata = { title: "Próximas aulas" };

export default async function StudentHomePage() {
  const user = await requireRole("student");

  // `studentId` só existe depois de a conta ser ligada à ficha criada pelo
  // professor. Sem essa ligação não há aulas para mostrar — e o aluno precisa
  // de saber porquê, senão conclui que a aplicação está avariada.
  const isLinked = user.studentId !== null;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <p className="text-sm text-muted">{formatWeekdayDate(new Date())}</p>
        <p className="mt-0.5 text-2xl font-extrabold tracking-tight text-ink">
          Olá, {firstName(user.profile.full_name)}
        </p>
      </section>

      {!isLinked && (
        <Card className="p-5">
          <div className="mb-3 flex size-11 items-center justify-center rounded-[var(--radius-field)] bg-sun-soft">
            <Link2 className="size-5.5 text-sun-deep" aria-hidden="true" />
          </div>
          <h2 className="text-base font-bold text-ink">A sua conta ainda não está ligada</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Para ver as suas aulas, o seu professor precisa de o registar com este mesmo email:{" "}
            <strong className="font-semibold text-ink">{user.email}</strong>. Assim que o fizer,
            as aulas aparecem aqui automaticamente.
          </p>
        </Card>
      )}

      {isLinked && (
        <Alert tone="info">
          A sua conta está ligada. As aulas aparecem aqui a partir da Fase 7.
        </Alert>
      )}

      <section>
        <SectionTitle>Próximas aulas</SectionTitle>
        <EmptyState
          icon={CalendarDays}
          title="Ainda não tem aulas marcadas"
          description="Quando o seu professor marcar uma aula consigo, ela aparece aqui."
        />
      </section>
    </div>
  );
}
