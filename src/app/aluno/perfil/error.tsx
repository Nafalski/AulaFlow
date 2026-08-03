"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function StudentProfileError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[AulaFlow] Perfil do aluno:", error);
  }, [error]);

  return (
    <Card className="p-6 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-state-warning-soft">
        <TriangleAlert className="size-6 text-state-warning" aria-hidden="true" />
      </div>

      <h1 className="text-xl font-extrabold tracking-tight text-ink">
        Não foi possível carregar o perfil
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-soft">
        Os seus dados não foram alterados. Volte a tentar; se continuar a acontecer,
        aguarde alguns minutos.
      </p>

      {error.digest && (
        <p className="mt-3 font-mono text-xs text-muted">Referência: {error.digest}</p>
      )}

      <Button onClick={unstable_retry} className="mt-6" fullWidth>
        Tentar novamente
      </Button>
    </Card>
  );
}
