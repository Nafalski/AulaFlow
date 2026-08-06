import { ArrowLeft, CalendarRange } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  AvailabilityCalendar,
  type AvailabilityCalendarItem,
} from "@/components/calendar/availability-calendar";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ClubCalendarLegend } from "@/components/workspaces/club-calendar-legend";
import { ClubCalendarSharingForm } from "@/components/workspaces/club-calendar-sharing-form";
import { ClubCalendarTeacherFilter } from "@/components/workspaces/club-calendar-teacher-filter";
import { requireRole } from "@/lib/auth/session";
import { loadWorkspaceContexts } from "@/lib/auth/workspace-context";
import { lisbonDateKey } from "@/lib/datetime";
import {
  CLUB_CALENDAR_FILTER_PARAM,
  clubCalendarBasePath,
  isClubCalendarEmpty,
  mergeClubPeriods,
  resolveClubCalendarFilter,
  sharingStateLabel,
  sortClubCalendarMembers,
  toClubCalendarItems,
  type ClubCalendarMember,
  type ClubCalendarPeriod,
} from "@/lib/domain/club-calendar";
import { isWorkspaceOperational } from "@/lib/domain/workspaces";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  readCalendarSearchParamsResult,
  type CalendarSearchParams,
} from "@/lib/validation/calendar";
import { workspaceInvitationIdSchema } from "@/lib/validation/workspaces";

export const metadata: Metadata = { title: "Calendário do clube" };
export const dynamic = "force-dynamic";

function throwClubCalendarError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao carregar ${context} do calendário do clube.`, error);
  throw new Error("Não foi possível carregar o calendário do clube.");
}

export default async function ClubCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<CalendarSearchParams>;
}) {
  const { id } = await params;
  await requireRole("teacher", `/professor/clubes/${id}/calendario`);

  const parsedId = workspaceInvitationIdSchema.shape.invitationId.safeParse(id);
  if (!parsedId.success) notFound();

  // Sem membership ativa a view não devolve linha nenhuma: não é preciso — nem
  // desejável — distinguir "não existe" de "não tem acesso".
  const contexts = await loadWorkspaceContexts();
  const club = contexts.find(
    (context) => context.organizationId === parsedId.data && !context.isPersonal,
  );
  if (!club) notFound();

  const now = new Date();
  const today = lisbonDateKey(now);
  const resolvedSearchParams = await searchParams;
  const calendarParams = readCalendarSearchParamsResult(resolvedSearchParams, now);
  const { window } = calendarParams;

  const supabase = await createSupabaseServerClient();

  const directoryResult = await supabase
    .from("club_calendar_member_directory")
    .select("membership_id, teacher_name, calendar_sharing_enabled, is_self")
    .eq("organization_id", club.organizationId);

  if (directoryResult.error) throwClubCalendarError("os professores", directoryResult.error);

  const members: ClubCalendarMember[] = sortClubCalendarMembers(
    (directoryResult.data ?? []).map((row) => ({
      membershipId: row.membership_id,
      teacherName: row.teacher_name,
      sharingEnabled: row.calendar_sharing_enabled,
      isSelf: row.is_self,
    })),
  );

  const self = members.find((member) => member.isSelf);
  const requestedFilter = resolvedSearchParams[CLUB_CALENDAR_FILTER_PARAM];
  const selectedMembershipId = resolveClubCalendarFilter(
    members,
    Array.isArray(requestedFilter) ? requestedFilter[0] : requestedFilter,
  );
  const selectedMember = members.find((member) => member.membershipId === selectedMembershipId);

  const suspended = !isWorkspaceOperational(club.workspaceStatus);
  const nobodyShares = isClubCalendarEmpty(members);

  // Um clube suspenso não devolve calendário: a RPC recusa, e pedir para
  // receber a recusa só produziria um erro sem valor para quem está a ler.
  let periods: ClubCalendarPeriod[] = [];
  if (!suspended && !nobodyShares) {
    const calendarResult = await supabase.rpc("get_club_availability_calendar", {
      p_organization_id: club.organizationId,
      p_start_date: window.startDate,
      p_end_date: window.endDate,
      p_membership_id: selectedMembershipId,
    });

    if (calendarResult.error) throwClubCalendarError("a disponibilidade", calendarResult.error);

    periods = (calendarResult.data ?? []).map((row) => ({
      membershipId: row.membership_id,
      teacherName: row.teacher_name,
      date: row.date,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
    }));
  }

  // Com um professor escolhido mostra-se a agenda dele; em "Todos" sobrepõem-se
  // os períodos, porque a pergunta passa a ser "há alguém disponível?".
  const items: AvailabilityCalendarItem[] = selectedMembershipId
    ? toClubCalendarItems(periods)
    : mergeClubPeriods(periods);

  const basePath = clubCalendarBasePath(club.organizationId, selectedMembershipId);
  const selectedLabel = selectedMember
    ? `${selectedMember.teacherName}${selectedMember.isSelf ? " (você)" : ""}`
    : "Todos os professores que partilham";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href={`/professor/clubes/${club.organizationId}`}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-ink-soft hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {club.organizationName}
        </Link>
      </div>

      {suspended ? (
        <Alert tone="warning" title="Clube suspenso">
          A administração suspendeu este clube. O calendário partilhado fica indisponível até à
          reativação. Nada foi apagado, e a sua agenda pessoal continua a funcionar normalmente.
        </Alert>
      ) : (
        <>
          {self && (
            <Card>
              <CardHeader
                title="A minha partilha"
                description={sharingStateLabel(self.sharingEnabled)}
              />
              <CardBody>
                <ClubCalendarSharingForm
                  organizationId={club.organizationId}
                  enabled={self.sharingEnabled}
                />
              </CardBody>
            </Card>
          )}

          <ClubCalendarTeacherFilter
            members={members}
            selectedMembershipId={selectedMembershipId}
            basePath={clubCalendarBasePath(club.organizationId)}
            date={window.selectedDate}
            view={window.view}
          />

          <ClubCalendarLegend />

          {nobodyShares ? (
            <EmptyState
              icon={CalendarRange}
              title="Ainda ninguém partilha a disponibilidade"
              description="Cada professor decide se partilha a sua agenda com este clube. Enquanto ninguém ativar a partilha, não há nada para mostrar aqui."
            />
          ) : selectedMember && !selectedMember.sharingEnabled ? (
            <EmptyState
              icon={CalendarRange}
              title={sharingStateLabel(false)}
              description={`${selectedMember.teacherName} ainda não partilha a disponibilidade com este clube.`}
            />
          ) : (
            <AvailabilityCalendar
              audience="club"
              basePath={basePath}
              window={window}
              today={today}
              items={items}
              title="Calendário do clube"
              subtitle={`${selectedLabel} · Europe/Lisbon`}
              teacherName={selectedMember?.teacherName ?? null}
              invalidDate={calendarParams.invalidDate}
              invalidView={calendarParams.invalidView}
            />
          )}
        </>
      )}

      <Alert tone="info" title="O que este calendário mostra — e o que não mostra">
        Apenas disponibilidade genérica de quem consentiu partilhá-la: disponível ou
        indisponível. Um bloqueio pessoal de um colega aparece como indisponibilidade, sem
        motivo nem categoria. Não existem aulas, participantes, locais, campos, reservas nem
        créditos nesta etapa — e por isso nada aqui significa “ocupado com aluno” ou “lotado”.
      </Alert>
    </div>
  );
}
