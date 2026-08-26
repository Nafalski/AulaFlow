"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function LessonHistoryError({ reset }: { reset: () => void }) {
  return (
    <Alert tone="danger" title="Não foi possível carregar o histórico">
      <p>Tente novamente. Se o problema continuar, volte ao calendário.</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={reset}>
        Tentar novamente
      </Button>
    </Alert>
  );
}
