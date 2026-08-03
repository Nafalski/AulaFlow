import type { ReactNode } from "react";

/**
 * Página de texto corrido (termos, privacidade).
 *
 * `max-w-2xl` não é decorativo: linhas com mais de ~75 caracteres obrigam o
 * olho a procurar o início da linha seguinte, e a leitura fica mais lenta.
 */
export function LegalPage({
  title,
  updatedAt,
  children,
}: {
  title: string;
  updatedAt: string;
  children: ReactNode;
}) {
  return (
    <article className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-3xl font-extrabold tracking-tight text-ink">{title}</h1>
      <p className="mt-2 text-sm text-muted">Última atualização: {updatedAt}</p>

      <div className="mt-8 flex flex-col gap-6 text-[0.9375rem] leading-relaxed text-ink-soft">
        {children}
      </div>
    </article>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-bold text-ink">{title}</h2>
      {children}
    </section>
  );
}
