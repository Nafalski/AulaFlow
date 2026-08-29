import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Os filtros que quase ninguém abre.
 *
 * Um professor independente tem meia dúzia de locais e outros tantos modelos de
 * pacote. Pesquisar pelo nome resolve quase sempre; estado, âmbito, modalidade e
 * validade são para o caso raro. Estavam todos permanentemente à vista, e a
 * barra de filtros ocupava mais espaço do que a lista que filtrava.
 *
 * Aqui ficam recolhidos — mas continuam no DOM, dentro do mesmo `<form>`, por
 * isso o servidor recebe exatamente os mesmos parâmetros de sempre. Nenhuma
 * capacidade de consulta foi retirada.
 *
 * `<details>` e não um painel feito à mão: abre com Enter ou Espaço, anuncia o
 * estado ao leitor de ecrã e funciona sem JavaScript — o formulário é um GET
 * nativo, e seria estranho que os seus filtros dependessem de hidratação.
 */
export function MoreFilters({
  children,
  /** Aberto à partida quando já há um filtro ativo: senão a lista aparece
      filtrada sem que se veja porquê. */
  defaultOpen = false,
  label = "Mais filtros",
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  label?: string;
}) {
  return (
    <details open={defaultOpen} className="group border-t border-line pt-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink-soft transition-colors hover:text-ink">
        <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
        {label}
      </summary>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </details>
  );
}
