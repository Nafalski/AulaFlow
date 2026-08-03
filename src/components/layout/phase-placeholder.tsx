import { Construction } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";

/**
 * Ecrã ainda por construir.
 *
 * A navegação de todas as áreas está completa desde a Fase 1, para que a
 * estrutura possa ser percorrida e avaliada. Cada ecrã por preencher diz em
 * que fase chega — é mais honesto do que uma página em branco ou um 404, e
 * evita a dúvida de se o link está partido.
 */
export function PhasePlaceholder({
  phase,
  title,
  description,
}: {
  phase: number;
  title: string;
  description: string;
}) {
  return (
    <EmptyState
      icon={Construction}
      title={title}
      description={`${description} Este ecrã chega na Fase ${phase}.`}
    />
  );
}
