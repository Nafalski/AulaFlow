import type { Metadata } from "next";

import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "Histórico" };

export default function StudentHistoryPage() {
  return (
    <PhasePlaceholder
      phase={7}
      title="Histórico"
      description="As aulas que já teve, incluindo as canceladas e as que foram remarcadas."
    />
  );
}
