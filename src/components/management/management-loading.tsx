export function ManagementLoading({ label = "conteúdo" }: { label?: string }) {
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite">
      <span className="sr-only">A carregar {label}…</span>
      <div className="h-8 w-48 animate-pulse rounded bg-sand-deep" aria-hidden="true" />
      <div className="h-24 animate-pulse rounded-[var(--radius-card)] bg-sand-deep" aria-hidden="true" />
      <div className="grid gap-3 md:grid-cols-2" aria-hidden="true">
        <div className="h-32 animate-pulse rounded-[var(--radius-card)] bg-sand-deep" />
        <div className="h-32 animate-pulse rounded-[var(--radius-card)] bg-sand-deep" />
      </div>
    </div>
  );
}
