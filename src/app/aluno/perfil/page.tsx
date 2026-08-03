import { Link2 } from "lucide-react";
import type { Metadata } from "next";

import { StudentAccountForm } from "@/components/settings/student-account-form";
import {
  StudentNotificationForm,
  type StudentNotificationPreferences,
} from "@/components/settings/student-notification-form";
import { StudentProfileContext } from "@/components/settings/student-profile-context";
import { StudentSecurityPanel } from "@/components/settings/student-security-panel";
import { Alert } from "@/components/ui/alert";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Perfil e definições" };

/** Uma página autenticada nunca pode ser pré-renderizada sem a sessão real. */
export const dynamic = "force-dynamic";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

function throwProfileReadError(context: string, error: unknown): never {
  console.error("[AulaFlow] Falha ao consultar " + context + " do perfil do aluno.", error);
  throw new Error("Não foi possível carregar o perfil.");
}

async function loadStudentProfile(supabase: SupabaseServerClient, profileId: string) {
  const { data, error } = await supabase
    .from("student_self_profile")
    .select("organization_id, created_by_teacher_id, profile_id, is_active")
    .eq("profile_id", profileId)
    .maybeSingle();

  if (error) throwProfileReadError("a ficha própria", error);
  return data;
}

async function loadNotificationPreferences(
  supabase: SupabaseServerClient,
  profileId: string,
) {
  const { data, error } = await supabase
    .from("notification_preferences")
    .select(
      "in_app_enabled, email_enabled, lesson_created, lesson_updated, lesson_cancelled, lesson_rescheduled, participant_changed, reminder_24h, reminder_2h",
    )
    .eq("profile_id", profileId)
    .maybeSingle();

  if (error) throwProfileReadError("as preferências de avisos", error);
  if (!data) throwProfileReadError("as preferências de avisos", "linha em falta");
  return data;
}

async function loadOrganization(supabase: SupabaseServerClient, organizationId: string | null) {
  if (!organizationId) return null;

  const { data, error } = await supabase
    .from("organizations")
    .select("name, timezone")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) throwProfileReadError("a organização", error);
  return data;
}

async function loadTeacher(supabase: SupabaseServerClient, teacherId: string | null) {
  if (!teacherId) return null;

  const { data, error } = await supabase
    .from("teacher_public_profiles")
    .select("public_name, bio, service_area")
    .eq("id", teacherId)
    .maybeSingle();

  if (error) throwProfileReadError("o professor responsável", error);
  return data;
}

async function loadTeacherSports(supabase: SupabaseServerClient, teacherId: string | null) {
  if (!teacherId) return [];

  const { data, error } = await supabase
    .from("teacher_public_sports")
    .select("sport_id, name")
    .eq("teacher_id", teacherId)
    .order("name");

  if (error) throwProfileReadError("as modalidades do professor", error);
  return data;
}

function notificationPreferences(
  row: Awaited<ReturnType<typeof loadNotificationPreferences>>,
): StudentNotificationPreferences {
  return {
    inAppEnabled: row.in_app_enabled,
    emailEnabled: row.email_enabled,
    lessonCreated: row.lesson_created,
    lessonUpdated: row.lesson_updated,
    lessonCancelled: row.lesson_cancelled,
    lessonRescheduled: row.lesson_rescheduled,
    participantChanged: row.participant_changed,
    reminder24h: row.reminder_24h,
    reminder2h: row.reminder_2h,
  };
}

const TIMEZONE_LABELS: Record<string, string> = {
  "Europe/Lisbon": "Lisboa",
  "Atlantic/Madeira": "Madeira",
  "Atlantic/Azores": "Açores",
};

export default async function StudentProfilePage() {
  const user = await requireRole("student", "/aluno/perfil");
  const supabase = await createSupabaseServerClient();

  const [studentProfile, preferences] = await Promise.all([
    loadStudentProfile(supabase, user.id),
    loadNotificationPreferences(supabase, user.id),
  ]);

  const organizationId = studentProfile?.organization_id ?? user.profile.organization_id;
  const teacherId = studentProfile?.created_by_teacher_id ?? null;

  const [organization, teacher, sports] = await Promise.all([
    loadOrganization(supabase, organizationId),
    loadTeacher(supabase, teacherId),
    loadTeacherSports(supabase, teacherId),
  ]);

  const isLinked = studentProfile !== null;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <p className="text-sm font-semibold tracking-wide text-brand uppercase">A sua conta</p>
        <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight text-ink">
          Perfil e definições
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Atualize os seus dados de contacto e escolha como quer receber avisos.
        </p>
      </section>

      {!isLinked && (
        <Alert tone="warning" title="Ficha ainda não ligada">
          <span className="inline-flex items-start gap-2">
            <Link2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Pode editar a conta normalmente. A organização e o professor aparecem quando
              for criada uma ficha com o email <strong>{user.email}</strong>.
            </span>
          </span>
        </Alert>
      )}

      {studentProfile && !studentProfile.is_active && (
        <Alert tone="warning" title="Ficha de aluno inativa">
          O seu professor assinalou esta ficha como inativa. Os dados da conta continuam
          disponíveis, mas deve contactá-lo para esclarecer o estado da ficha.
        </Alert>
      )}

      <StudentAccountForm
        fullName={user.profile.full_name}
        email={user.email}
        phone={user.profile.phone}
        locale={user.profile.locale}
        timezone={user.profile.timezone}
        contactPreference={user.profile.preferred_contact_method}
      />

      <section aria-label="Associação da ficha">
        <StudentProfileContext
          isLinked={isLinked}
          organization={
            organization
              ? {
                  name: organization.name,
                  timezone: TIMEZONE_LABELS[organization.timezone] ?? organization.timezone,
                }
              : null
          }
          teacher={
            teacher
              ? {
                  publicName: teacher.public_name,
                  bio: teacher.bio,
                  serviceArea: teacher.service_area,
                  sports: sports.map((sport) => ({ id: sport.sport_id, name: sport.name })),
                }
              : null
          }
        />
      </section>

      <StudentNotificationForm preferences={notificationPreferences(preferences)} />
      <StudentSecurityPanel email={user.email} />
    </div>
  );
}
