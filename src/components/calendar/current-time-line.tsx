"use client";

import { useEffect, useState } from "react";

import {
  currentTimePositionForDate,
  type CalendarTimelineRange,
} from "@/lib/domain/calendar";
import { TIMEZONE } from "@/lib/datetime";

type CurrentTimeLineProps = {
  date: string;
  range: CalendarTimelineRange;
};

type LisbonClock = {
  date: string;
  minutes: number;
};

const CLOCK_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function lisbonClockNow(): LisbonClock {
  const parts = CLOCK_FORMATTER.formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

export function CurrentTimeLine({ date, range }: CurrentTimeLineProps) {
  const [topPercent, setTopPercent] = useState<number | null>(null);

  useEffect(() => {
    function updatePosition() {
      const now = lisbonClockNow();
      setTopPercent(
        currentTimePositionForDate({
          date,
          today: now.date,
          minutes: now.minutes,
          range,
        }),
      );
    }

    updatePosition();
    const timer = window.setInterval(updatePosition, 60_000);
    return () => window.clearInterval(timer);
  }, [date, range]);

  if (topPercent === null) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 z-40 flex items-center"
      data-calendar-now-line="true"
      style={{ top: `${topPercent}%` }}
    >
      <span className="-ml-1 size-2.5 shrink-0 rounded-full bg-sun shadow-card" />
      <span className="h-0.5 flex-1 bg-sun" />
      <span className="ml-1 rounded-full bg-sun px-1.5 py-0.5 text-[0.6875rem] font-bold text-white">
        agora
      </span>
    </div>
  );
}
