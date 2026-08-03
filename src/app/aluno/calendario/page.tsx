import type { Metadata } from "next";

import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "Calendário" };

export default function StudentCalendarPage() {
  return (
    <PhasePlaceholder
      phase={7}
      title="O seu calendário"
      description="As suas aulas organizadas por dia, com horário, local e professor."
    />
  );
}
