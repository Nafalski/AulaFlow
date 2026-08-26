"use client";

import { LessonHistoryError } from "@/components/lessons/lesson-history-error";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <LessonHistoryError reset={reset} />;
}
