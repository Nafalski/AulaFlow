import { Building2, ChevronRight, Scale, Settings2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AccountProfileForm } from "@/components/settings/account-profile-form";
import { NotificationPreferencesForm } from "@/components/settings/notification-preferences-form";
import { SecuritySettingsCard } from "@/components/settings/security-settings-card";
import { TeacherPublicProfileForm } from "@/components/settings/teacher-public-profile-form";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Definições" };
export const dynamic = "force-dynamic";

function settingsLookupError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao carregar ${context} das definições do professor.`, error);
  throw new Error("Não foi possível carregar as definições do professor.");
}

export default async function TeacherSettingsPage() {
  const user = await requireRole("teacher", "/professor/definicoes");
  const supabase = await createSupabaseServerClient();

  const { data: teacherProfile, error: teacherError } = await supabase
    .from("teacher_profiles")
    .select("id, public_name, bio, service_area")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (teacherError) settingsLookupError("o perfil profissional", teacherError);
  if (!teacherProfile) settingsLookupError("o perfil profissional", "Perfil inexistente");

  const [sportsResult, selectedSportsResult, preferencesResult, organizationResult] =
    await Promise.all([
      supabase
        .from("sports")
        .select("id, name, icon")
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("teacher_sports")
        .select("sport_id")
        .eq("teacher_id", teacherProfile.id),
      supabase
        .from("notification_preferences")
        .select(
          "profile_id, in_app_enabled, email_enabled, lesson_created, lesson_updated, lesson_cancelled, lesson_rescheduled, participant_changed, reminder_24h, reminder_2h",
        )
        .eq("profile_id", user.id)
        .maybeSingle(),
      user.profile.organization_id
        ? supabase
            .from("organizations")
            .select("id, name")
            .eq("id", user.profile.organization_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

  if (sportsResult.error) settingsLookupError("as modalidades", sportsResult.error);
  if (selectedSportsResult.error) {
    settingsLookupError("as modalidades do professor", selectedSportsResult.error);
  }
  if (preferencesResult.error) settingsLookupError("as preferências", preferencesResult.error);
  if (!preferencesResult.data) settingsLookupError("as preferências", "Preferências inexistentes");
  if (organizationResult.error) settingsLookupError("a organização", organizationResult.error);

  const preferences = preferencesResult.data;
  const accountValues = {
    fullName: user.profile.full_name,
    email: user.profile.email,
    phone: user.profile.phone,
    locale: user.profile.locale,
    timezone: user.profile.timezone,
    contactPreference: user.profile.preferred_contact_method,
  };
  const notificationValues = {
    inAppEnabled: preferences.in_app_enabled,
    emailEnabled: preferences.email_enabled,
    lessonCreated: preferences.lesson_created,
    lessonUpdated: preferences.lesson_updated,
    lessonCancelled: preferences.lesson_cancelled,
    lessonRescheduled: preferences.lesson_rescheduled,
    participantChanged: preferences.participant_changed,
    reminder24h: preferences.reminder_24h,
    reminder2h: preferences.reminder_2h,
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="flex items-center gap-2 text-brand">
          <Settings2 className="size-5" aria-hidden="true" />
          <p className="text-sm font-bold tracking-wide uppercase">Conta de professor</p>
        </div>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Definições</h1>
        <p className="mt-1 text-sm text-muted">
          Atualize o seu perfil, os contactos, os avisos e a segurança da conta.
        </p>
      </header>

      {organizationResult.data && (
        <Card variant="plain" className="flex items-center gap-3 p-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-tint">
            <Building2 className="size-5 text-brand" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">Organização</p>
            <p className="font-bold text-ink">{organizationResult.data.name}</p>
          </div>
        </Card>
      )}

      <Alert tone="info">
        O nome profissional, a apresentação, a zona e as modalidades podem ser vistos pelos
        seus alunos. Telefone, idioma e preferências permanecem privados.
      </Alert>

      <Card variant="plain" className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-tint">
            <Scale className="size-5 text-brand" aria-hidden="true" />
          </span>
          <div>
            <p className="font-bold text-ink">Políticas de cancelamento</p>
            <p className="mt-0.5 text-sm text-muted">
              Defina prazos, cancelamentos tardios, faltas e exceções manuais.
            </p>
          </div>
        </div>
        <Link
          href="/professor/definicoes/politicas-cancelamento"
          className={buttonClasses({ variant: "outline", className: "shrink-0" })}
        >
          Gerir políticas <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="flex flex-col gap-6">
          <AccountProfileForm role="teacher" values={accountValues} />

          {sportsResult.data.length > 0 ? (
            <TeacherPublicProfileForm
              publicName={teacherProfile.public_name ?? user.profile.full_name}
              bio={teacherProfile.bio}
              serviceArea={teacherProfile.service_area}
              sports={sportsResult.data}
              selectedSportIds={selectedSportsResult.data.map((entry) => entry.sport_id)}
            />
          ) : (
            <EmptyState
              icon={Settings2}
              title="Ainda não existem modalidades disponíveis"
              description="Peça à administração para configurar uma modalidade antes de completar o perfil profissional."
            />
          )}
        </div>

        <div className="flex flex-col gap-6">
          <NotificationPreferencesForm role="teacher" values={notificationValues} />
          <SecuritySettingsCard email={user.email} />
        </div>
      </div>
    </div>
  );
}
