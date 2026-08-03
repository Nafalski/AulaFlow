import type { Metadata } from "next";

import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "Calendário" };

export default function TeacherCalendarPage() {
  return (
    <PhasePlaceholder
      phase={5}
      title="Calendário"
      description="Vistas por dia, semana e mês, com criação de aulas únicas ou recorrentes."
    />
  );
}
