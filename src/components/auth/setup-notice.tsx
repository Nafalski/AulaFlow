import { Card } from "@/components/ui/card";

/**
 * Primeiro arranque sem `.env.local`.
 *
 * Mostrado no lugar dos formulários quando não há credenciais Supabase. Uma
 * página de login que falha ao submeter, sem explicar porquê, é a pior forma
 * de descobrir que falta configuração — e é o que aconteceria a quem clonasse
 * o repositório e corresse `npm run dev`.
 */
export function SupabaseSetupNotice() {
  return (
    <Card className="p-6">
      <h1 className="text-xl font-extrabold tracking-tight text-ink">Falta configurar o Supabase</h1>

      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        A aplicação está a correr, mas ainda não tem ligação à base de dados. São quatro passos:
      </p>

      <ol className="mt-4 flex flex-col gap-3 text-sm text-ink-soft">
        <Step n={1}>
          Crie um projeto em{" "}
          <span className="font-semibold text-ink">supabase.com</span>.
        </Step>
        <Step n={2}>
          Copie <code className="rounded bg-sand px-1.5 py-0.5 font-mono text-xs">.env.example</code>{" "}
          para <code className="rounded bg-sand px-1.5 py-0.5 font-mono text-xs">.env.local</code> e
          preencha o URL e a chave <span className="font-mono text-xs">anon</span>.
        </Step>
        <Step n={3}>
          Ligue este repositório ao projeto com{" "}
          <code className="rounded bg-sand px-1.5 py-0.5 font-mono text-xs">npm run db:link</code>.
        </Step>
        <Step n={4}>
          Aplique as migrações com{" "}
          <code className="rounded bg-sand px-1.5 py-0.5 font-mono text-xs">npm run db:push</code>.
        </Step>
      </ol>

      <p className="mt-5 text-sm text-muted">
        As instruções completas estão em <span className="font-semibold text-ink">AGENTS.md</span>.
      </p>
    </Card>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand-deep"
        aria-hidden="true"
      >
        {n}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}
