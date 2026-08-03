export default function AdminUserDetailLoading() {
  return (
    <div className="flex animate-pulse flex-col gap-6" role="status" aria-label="A carregar conta">
      <span className="sr-only">A carregar os detalhes da conta…</span>
      <div>
        <div className="h-11 w-48 rounded bg-sand-deep" />
        <div className="mt-4 flex items-center gap-3">
          <div className="size-14 rounded-full bg-sand-deep" />
          <div className="flex flex-col gap-2">
            <div className="h-6 w-48 rounded bg-sand-deep" />
            <div className="h-3.5 w-60 max-w-full rounded bg-sand-deep" />
          </div>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-64 rounded-[var(--radius-card)] bg-surface shadow-card" />
        <div className="h-64 rounded-[var(--radius-card)] bg-surface shadow-card" />
      </div>
      <div className="h-64 rounded-[var(--radius-card)] bg-surface shadow-card" />
    </div>
  );
}
