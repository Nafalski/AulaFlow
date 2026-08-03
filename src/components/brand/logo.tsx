import { cn } from "@/lib/utils";

/**
 * Marca AulaFlow.
 *
 * A marca é um círculo (a bola) atravessado por uma onda (a praia, e o "flow"
 * do nome). Desenhado em SVG inline por três razões: fica nítido em qualquer
 * densidade de ecrã, herda a cor do contexto, e não custa um pedido de rede
 * no primeiro ecrã — que num telemóvel com rede fraca é o que se nota.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden="true">
      <circle cx="16" cy="16" r="15" className="fill-brand" />
      <path
        d="M4 19.5c3 0 3-3.2 6-3.2s3 3.2 6 3.2 3-3.2 6-3.2 3 3.2 6 3.2"
        fill="none"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="22.5" cy="10" r="3.2" className="fill-sun" />
    </svg>
  );
}

export function Logo({
  className,
  showText = true,
}: {
  className?: string;
  showText?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      {showText && (
        <span className="text-lg font-extrabold tracking-tight text-ink">
          Aula<span className="text-brand">Flow</span>
        </span>
      )}
      {!showText && <span className="sr-only">AulaFlow</span>}
    </span>
  );
}
