import type { Metadata } from "next";

import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "Histórico" };

export default function TeacherHistoryPage() {
  return (
    <PhasePlaceholder
      phase={6}
      title="Histórico de aulas"
      description="Todas as aulas dadas, canceladas e remarcadas, com o motivo de cada alteração."
    />
  );
}
