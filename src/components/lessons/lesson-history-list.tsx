import { CalendarClock, MapPin, Ticket, UserRound, UsersRound } from "lucide-react";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/status-badge";
import { formatFullDate, formatTime } from "@/lib/datetime";
import type { StatusTone } from "@/lib/domain/lesson-status";
import type { LessonStatus } from "@/types/database";

export type LessonHistoryListEntry = {
  id: string;
  title: string;
  status: LessonStatus;
  startsAt: string;
  endsAt: string;
  sportName: string;
  teacherName?: string | null;
  locationName: string | null;
  resourceName?: string | null;
  groupName?: string | null;
  participantCount?: number | null;
  participationLabel?: string | null;
  participationTone?: StatusTone;
  attendanceLabel?: string | null;
  attendanceTone?: StatusTone;
  billingLabel?: string | null;
  billingTone?: StatusTone;
  packageName?: string | null;
  reason?: string | null;
  href?: string | null;
};

export function LessonHistoryList({ lessons }: { lessons: LessonHistoryListEntry[] }) {
  return (
    <div className="grid gap-3">
      {lessons.map((lesson) => (
        <Card key={lesson.id} variant="plain" data-history-card>
          <CardHeader
            title={<span className="block break-words">{lesson.title}</span>}
            description={lesson.sportName}
            action={<StatusBadge status={lesson.status} size="sm" />}
          />
          <CardBody>
            <div className="grid gap-2 text-sm text-ink-soft sm:grid-cols-2">
              <p className="flex min-w-0 items-start gap-2">
                <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                <span>
                  {formatFullDate(lesson.startsAt)} · {formatTime(lesson.startsAt)}–{formatTime(lesson.endsAt)}
                </span>
              </p>
              {lesson.teacherName && (
                <p className="flex min-w-0 items-start gap-2">
                  <UserRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="break-words">{lesson.teacherName}</span>
                </p>
              )}
              {(lesson.locationName || lesson.resourceName) && (
                <p className="flex min-w-0 items-start gap-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="break-words">
                    {[lesson.locationName, lesson.resourceName].filter(Boolean).join(" · ")}
                  </span>
                </p>
              )}
              {(lesson.groupName || lesson.participantCount !== undefined) && (
                <p className="flex min-w-0 items-start gap-2">
                  <UsersRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="break-words">
                    {lesson.groupName ??
                      `${lesson.participantCount ?? 0} participante${lesson.participantCount === 1 ? "" : "s"}`}
                  </span>
                </p>
              )}
              {lesson.packageName && (
                <p className="flex min-w-0 items-start gap-2">
                  <Ticket className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="break-words">{lesson.packageName}</span>
                </p>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {lesson.participationLabel && (
                <Badge tone={lesson.participationTone}>{lesson.participationLabel}</Badge>
              )}
              {lesson.attendanceLabel && (
                <Badge tone={lesson.attendanceTone}>{lesson.attendanceLabel}</Badge>
              )}
              {lesson.billingLabel && <Badge tone={lesson.billingTone}>{lesson.billingLabel}</Badge>}
            </div>

            {lesson.reason && (
              <p className="mt-3 rounded-[var(--radius-field)] bg-sand-deep p-3 text-sm text-ink-soft">
                <strong className="font-bold text-ink">Motivo:</strong> {lesson.reason}
              </p>
            )}

            {lesson.href && (
              <div className="mt-3">
                <Link href={lesson.href} className={buttonClasses({ variant: "ghost", size: "sm" })}>
                  Abrir aula
                </Link>
              </div>
            )}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
