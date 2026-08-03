"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function TeacherSettingsError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[AulaFlow] Definições do professor", error);
  }, [error]);

  return (
    <Card className="p-6 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-state-warning-soft">
        <TriangleAlert className="size-6 text-state-warning" aria-hidden="true" />
      </div>
      <h1 className="text-xl font-extrabold tracking-tight text-ink">
        Não foi possível carregar as definições
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
        Tente novamente. Se o problema continuar, aguarde alguns minutos antes de repetir.
      </p>
      <Button onClick={unstable_retry} className="mt-6">
        Tentar novamente
      </Button>
    </Card>
  );
}
