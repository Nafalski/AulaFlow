import { ArrowLeft, ShieldCheck, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { GroupForm } from "@/components/groups/group-form";
import { GroupMembersManager } from "@/components/groups/group-members-manager";
import { GroupStatusForm } from "@/components/groups/group-status-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/status-badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { groupIdSchema } from "@/lib/validation/groups";

export const metadata: Metadata = { title: "Detalhes da turma" };
export const dynamic = "force-dynamic";

export default async function GroupDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aluno?: string | string[] }>;
}) {
  const { id } = await params;
  const parsedId = groupIdSchema.safeParse({ groupId: id });
  if (!parsedId.success) notFound();

  await requireRole("teacher", `/professor/grupos/${id}`);
  const memberSearchRaw = (await searchParams).aluno;
  const memberSearch = typeof memberSearchRaw === "string" ? memberSearchRaw.trim().replace(/\s+/g, " ").slice(0, 120) : "";
  const supabase = await createSupabaseServerClient();

  const { data: group, error: groupError } = await supabase
    .from("teacher_group_records")
    .select("id, name, sport_id, description, administrative_notes, max_participants, is_active, participant_count")
    .eq("id", parsedId.data.groupId)
    .maybeSingle();

  if (groupError) {
    console.error("[AulaFlow] Falha ao carregar o detalhe de uma turma própria.", groupError);
    throw new Error("Não foi possível carregar a turma.");
  }
  if (!group) notFound();

  const [sportsResult, memberRelationsResult] = await Promise.all([
    supabase.from("sports").select("id, name, icon, is_active").order("name"),
    supabase.from("group_members").select("student_id").eq("group_id", group.id).eq("is_active", true),
  ]);
  if (sportsResult.error || memberRelationsResult.error) {
    console.error("[AulaFlow] Falha ao carregar dados relacionados da turma.", sportsResult.error ?? memberRelationsResult.error);
    throw new Error("Não foi possível carregar os membros da turma.");
  }

  const memberIds = memberRelationsResult.data.map((relation) => relation.student_id);
  const currentMembersResult = memberIds.length > 0
    ? await supabase.from("teacher_student_management_records").select("id, full_name, email").in("id", memberIds).order("full_name")
    : { data: [], error: null };
  if (currentMembersResult.error) {
    console.error("[AulaFlow] Falha ao carregar as fichas dos membros da turma.", currentMembersResult.error);
    throw new Error("Não foi possível carregar os membros da turma.");
  }

  let eligibleStudents: { id: string; full_name: string; email: string | null }[] = [];
  const canAdd = group.is_active && (group.max_participants === null || group.participant_count < group.max_participants);
  if (memberSearch && canAdd) {
    const escapedSearch = memberSearch.replace(/[\\%_]/g, "\\$&");
    const pattern = `%${escapedSearch}%`;
    const phoneSearch = memberSearch.replace(/[\s().–—-]/g, "");
    const escapedPhoneSearch = phoneSearch.replace(/[\\%_]/g, "\\$&");
    const buildEligibleQuery = () => {
      let query = supabase
        .from("teacher_student_management_records")
        .select("id, full_name, email")
        .eq("is_active", true)
        .order("full_name")
        .limit(20);
      if (memberIds.length > 0) {
        query = query.not("id", "in", `(${memberIds.join(",")})`);
      }
      return query;
    };
    const queries = [
      buildEligibleQuery().ilike("full_name", pattern),
      buildEligibleQuery().ilike("email", pattern),
    ];
    if (escapedPhoneSearch !== "") {
      queries.push(buildEligibleQuery().ilike("phone", `%${escapedPhoneSearch}%`));
    }
    const results = await Promise.all(queries);
    const failed = results.find((result) => result.error);
    if (failed?.error) {
      console.error("[AulaFlow] Falha ao pesquisar alunos elegíveis para a turma.", failed.error);
      throw new Error("Não foi possível pesquisar alunos elegíveis.");
    }
    const unique = new Map<string, (typeof eligibleStudents)[number]>();
    for (const result of results) {
      for (const student of result.data ?? []) unique.set(student.id, student);
    }
    eligibleStudents = [...unique.values()]
      .sort((left, right) => left.full_name.localeCompare(right.full_name, "pt-PT", { sensitivity: "base" }))
      .slice(0, 20);
  }

  const availableSports = sportsResult.data
    .filter((sport) => sport.is_active || sport.id === group.sport_id)
    .map((sport) => ({
      id: sport.id,
      name: sport.name,
      icon: sport.icon,
      isActive: sport.is_active,
    }));
  const currentMembers = currentMembersResult.data.map((student) => ({ id: student.id, fullName: student.full_name, email: student.email }));
  const eligible = eligibleStudents.map((student) => ({ id: student.id, fullName: student.full_name, email: student.email }));
  const selectedSportName = group.sport_id
    ? sportsResult.data.find((sport) => sport.id === group.sport_id)?.name ?? null
    : null;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/professor/grupos" className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}><ArrowLeft className="size-4" aria-hidden="true" /> Voltar às turmas</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h1 className="text-2xl font-extrabold tracking-tight text-ink">{group.name}</h1><p className="mt-1 text-sm text-muted">{selectedSportName ?? "Sem modalidade associada"}</p></div>
          <Badge tone={group.is_active ? "success" : "neutral"}>{group.is_active ? "Ativa" : "Inativa"}</Badge>
        </div>
      </div>

      <Alert tone="info"><span className="inline-flex items-center gap-2"><ShieldCheck className="size-4 shrink-0" aria-hidden="true" />As observações administrativas desta página não são expostas aos alunos.</span></Alert>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <GroupForm mode="edit" values={{ id: group.id, name: group.name, sportId: group.sport_id, description: group.description, administrativeNotes: group.administrative_notes, maxParticipants: group.max_participants }} sports={availableSports} />
        <Card variant="plain"><CardHeader title="Estado da turma" description="Desativar preserva membros e referências." /><CardBody><GroupStatusForm groupId={group.id} groupName={group.name} isActive={group.is_active} /></CardBody></Card>
      </div>

      <Card variant="plain">
        <CardHeader title={<span className="inline-flex items-center gap-2"><UsersRound className="size-5 text-brand" aria-hidden="true" />Participantes</span>} description="Um aluno pode pertencer a várias turmas; a remoção conserva a relação histórica." />
        <CardBody><GroupMembersManager groupId={group.id} currentMembers={currentMembers} eligibleStudents={eligible} search={memberSearch} canAdd={canAdd} /></CardBody>
      </Card>
    </div>
  );
}
