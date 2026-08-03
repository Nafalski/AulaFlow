"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Fronteira de erro da aplicação.
 *
 * A mensagem técnica NÃO é mostrada ao utilizador — pode conter nomes de
 * tabelas, caminhos internos ou fragmentos de consulta. Vai para a consola,
 * onde é útil, e o ecrã diz o que a pessoa precisa de saber: que falhou, e
 * que pode tentar de novo.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // EXTENSÃO: enviar para um serviço de monitorização (Sentry) na Fase 9.
    console.error("[AulaFlow]", error);
  }, [error]);

  return (
    <div className="bg-beach flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md p-6 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-state-warning-soft">
          <TriangleAlert className="size-6 text-state-warning" aria-hidden="true" />
        </div>

        <h1 className="text-xl font-extrabold tracking-tight text-ink">Algo correu mal</h1>

        <p className="mt-2 text-sm text-ink-soft">
          Não conseguimos carregar esta página. Volte a tentar — se continuar a acontecer,
          aguarde uns minutos.
        </p>

        {error.digest && (
          <p className="mt-3 font-mono text-xs text-muted">Referência: {error.digest}</p>
        )}

        <Button onClick={reset} className="mt-6" fullWidth>
          Tentar novamente
        </Button>
      </Card>
    </div>
  );
}
