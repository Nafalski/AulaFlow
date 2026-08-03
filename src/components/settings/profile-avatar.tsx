import { initials } from "@/lib/utils";

/**
 * Fallback deliberado enquanto não existe um bucket de avatares configurado.
 * Não apresenta um controlo de upload que não conseguiria guardar a imagem.
 */
export function ProfileAvatar({ fullName }: { fullName: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-field)] bg-sand p-3.5">
      <span
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-soft text-base font-extrabold text-brand-deep"
        aria-hidden="true"
      >
        {initials(fullName)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-ink">Avatar com iniciais</p>
        <p className="text-xs leading-relaxed text-muted">
          O carregamento de fotografia será disponibilizado quando existir armazenamento seguro
          configurado.
        </p>
      </div>
    </div>
  );
}
