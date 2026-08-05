export function CalendarLoading({ label = "calendário" }: { label?: string }) {
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite">
      <span className="sr-only">A carregar {label}…</span>

      <header className="flex flex-col gap-4" aria-hidden="true">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="h-5 w-36 skeleton" />
            <div className="mt-2 h-8 w-72 max-w-full skeleton" />
            <div className="mt-2 h-4 w-96 max-w-full skeleton" />
          </div>
          <div className="h-6 w-32 skeleton" />
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex gap-2">
            <div className="h-11 w-11 skeleton" />
            <div className="h-11 w-20 skeleton" />
            <div className="h-11 w-11 skeleton" />
          </div>
          <div className="h-12 w-full max-w-xs skeleton" />
        </div>
      </header>

      <section
        className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card"
        aria-hidden="true"
      >
        <div className="grid grid-cols-[4.5rem_repeat(7,minmax(0,1fr))] border-b border-line">
          <div className="h-14 bg-sand-deep" />
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className="border-l border-line-soft p-2">
              <div className="mx-auto h-9 w-14 skeleton" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-[4.5rem_repeat(7,minmax(0,1fr))]">
          <div className="h-[34rem] border-r border-line bg-surface p-2">
            <div className="mt-8 h-3 w-10 skeleton" />
            <div className="mt-12 h-3 w-10 skeleton" />
            <div className="mt-12 h-3 w-10 skeleton" />
            <div className="mt-12 h-3 w-10 skeleton" />
          </div>
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className="relative h-[34rem] border-r border-line-soft p-2">
              {index === 1 && <div className="mt-16 h-28 skeleton" />}
              {index === 2 && <div className="mt-28 h-20 skeleton" />}
              {index === 4 && <div className="mt-44 h-24 skeleton" />}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
