import type { Metadata } from "next";

import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "Avisos" };

export default function TeacherNotificationsPage() {
  return (
    <PhasePlaceholder
      phase={8}
      title="Central de notificações"
      description="Avisos de confirmações, cancelamentos e lembretes das próximas aulas."
    />
  );
}
