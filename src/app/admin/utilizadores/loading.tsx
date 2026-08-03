function SkeletonRow() {
  return (
    <div className="flex animate-pulse items-center gap-4 border-b border-line px-4 py-4 last:border-b-0">
      <div className="size-10 shrink-0 rounded-full bg-sand-deep" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="h-3.5 w-40 rounded bg-sand-deep" />
        <div className="h-3 w-56 max-w-full rounded bg-sand-deep" />
      </div>
      <div className="hidden h-8 w-24 rounded-full bg-sand-deep sm:block" />
    </div>
  );
}

export default function AdminUsersLoading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="A carregar utilizadores">
      <span className="sr-only">A carregar utilizadores…</span>
      <div className="animate-pulse">
        <div className="h-7 w-40 rounded bg-sand-deep" />
        <div className="mt-2 h-4 w-96 max-w-full rounded bg-sand-deep" />
      </div>
      <div className="h-44 animate-pulse rounded-[var(--radius-card)] bg-surface shadow-card" />
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </div>
  );
}
