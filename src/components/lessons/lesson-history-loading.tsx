export function LessonHistoryLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="A carregar histórico">
      <div className="space-y-2">
        <div className="skeleton h-4 w-28" />
        <div className="skeleton h-8 w-56 max-w-full" />
        <div className="skeleton h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
            <div className="skeleton h-5 w-2/3" />
            <div className="mt-3 skeleton h-4 w-full" />
            <div className="mt-2 skeleton h-4 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
