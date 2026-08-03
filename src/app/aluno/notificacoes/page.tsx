import type { Metadata } from "next";

import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "Avisos" };

export default function StudentNotificationsPage() {
  return (
    <PhasePlaceholder
      phase={8}
      title="Avisos"
      description="Alterações de horário, cancelamentos, remarcações e lembretes das suas aulas."
    />
  );
}
