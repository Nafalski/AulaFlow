import { Ticket } from "lucide-react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";

export type StudentPackageSummaryData = {
  package_count: number;
  usable_package_count: number;
  credits_available: number;
  credits_reserved: number;
  credits_used: number;
};

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-field)] bg-sand-deep p-3 text-center">
      <p className="text-xl font-extrabold text-ink">{value}</p>
      <p className="mt-0.5 text-xs font-semibold text-muted">{label}</p>
    </div>
  );
}

export function StudentPackageSummary({ summary }: { summary: StudentPackageSummaryData }) {
  return (
    <Card variant="plain">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Ticket className="size-4.5 text-brand" aria-hidden="true" />
            Resumo de pacotes
          </span>
        }
        description={`${summary.usable_package_count} utilizáveis em ${summary.package_count} pacotes.`}
      />
      <CardBody>
        <div className="grid grid-cols-3 gap-2">
          <Metric label="Disponíveis" value={summary.credits_available} />
          <Metric label="Reservados" value={summary.credits_reserved} />
          <Metric label="Utilizados" value={summary.credits_used} />
        </div>
        <p className="mt-3 text-xs text-muted">
          Disponíveis e reservados contam apenas pacotes utilizáveis; utilizados incluem o
          histórico total. Atribuições, ajustes e livro-razão chegam na Fase 4.
        </p>
      </CardBody>
    </Card>
  );
}
