"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function AdminUsersError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[AulaFlow] Diretório administrativo", error);
  }, [error]);

  return (
    <Card className="mx-auto max-w-lg p-6 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-state-warning-soft">
        <TriangleAlert className="size-6 text-state-warning" aria-hidden="true" />
      </div>
      <h1 className="text-xl font-extrabold tracking-tight text-ink">
        Não foi possível carregar os utilizadores
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        A ligação pode estar temporariamente indisponível. Tente novamente dentro de instantes.
      </p>
      {error.digest && (
        <p className="mt-3 font-mono text-xs text-muted">Referência: {error.digest}</p>
      )}
      <Button type="button" onClick={unstable_retry} className="mt-6">
        Tentar novamente
      </Button>
    </Card>
  );
}
