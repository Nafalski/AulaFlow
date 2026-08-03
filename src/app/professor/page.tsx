import { CalendarDays, CalendarPlus, Clock, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireRole } from "@/lib/auth/session";
import { formatWeekdayDate } from "@/lib/datetime";
import { firstName } from "@/lib/utils";

export const metadata: Metadata = { title: "Painel" };

/**
 * Painel do professor.
 *
 * A estrutura está montada; os números chegam na Fase 5, quando existirem
 * aulas para contar. Os estados vazios são o comportamento definitivo para
 * um professor que acabou de criar conta — não são temporários.
 */
export default async function TeacherDashboardPage() {
  const user = await requireRole("teacher");
  const today = new Date();

  return (
    <div className="flex flex-col gap-6">
      <section>
        <p className="text-sm text-muted">{formatWeekdayDate(today)}</p>
        <p className="mt-0.5 text-2xl font-extrabold tracking-tight text-ink">
          Olá, {firstName(user.profile.full_name)}
        </p>
      </section>

      <Alert tone="info" title="Configuração inicial">
        A base de dados e a autenticação estão prontas. As aulas, os alunos e o calendário
        chegam nas fases seguintes.
      </Alert>

      {/* Ação principal do ecrã, em coral e em destaque, conforme o requisito
          de "botão destacado para criar uma nova aula". */}
      <Link
        href="/professor/calendario"
        className={buttonClasses({ variant: "accent", size: "lg", fullWidth: true })}
      >
        <CalendarPlus className="size-5" aria-hidden="true" />
        Nova aula
      </Link>

      <section>
        <SectionTitle>Resumo de hoje</SectionTitle>
        <div className="grid grid-cols-3 gap-3">
          <StatCard icon={CalendarDays} value="0" label="Aulas hoje" />
          <StatCard icon={Users} value="0" label="Alunos" />
          <StatCard icon={Clock} value="—" label="Próxima" />
        </div>
      </section>

      <section>
        <SectionTitle>Aulas de hoje</SectionTitle>
        <EmptyState
          icon={CalendarDays}
          title="Ainda não existem aulas neste dia"
          description="Quando marcar aulas, aparecem aqui por ordem de horário."
        />
      </section>

      <section>
        <SectionTitle>Confirmações pendentes</SectionTitle>
        <EmptyState
          icon={Users}
          title="Nada por confirmar"
          description="Os pedidos de confirmação de presença aparecem aqui."
        />
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof CalendarDays;
  value: string;
  label: string;
}) {
  return (
    <Card className="p-3.5">
      <Icon className="mb-2 size-4.5 text-brand" aria-hidden="true" />
      <p className="text-2xl leading-none font-extrabold text-ink">{value}</p>
      <p className="mt-1 text-xs text-muted">{label}</p>
    </Card>
  );
}
