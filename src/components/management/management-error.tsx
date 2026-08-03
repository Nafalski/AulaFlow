"use client";

import { useEffect } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function ManagementError({
  error,
  unstableRetry,
  resource,
}: {
  error: Error & { digest?: string };
  unstableRetry: () => void;
  resource: string;
}) {
  useEffect(() => {
    console.error(`[AulaFlow] Erro inesperado ao carregar ${resource}.`, error);
  }, [error, resource]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 py-8">
      <Alert tone="danger" title={`Não foi possível carregar ${resource}`}>
        O problema pode ser temporário. Tente novamente; se continuar, volte mais tarde.
      </Alert>
      <Button type="button" onClick={unstableRetry} className="self-start">
        Tentar novamente
      </Button>
    </div>
  );
}
