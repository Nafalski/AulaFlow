import {
  NotificationPreferencesForm,
  type NotificationPreferenceValues,
} from "@/components/settings/notification-preferences-form";

export type StudentNotificationPreferences = NotificationPreferenceValues;

/** Adapta as preferências comuns à área do aluno. */
export function StudentNotificationForm({
  preferences,
}: {
  preferences: StudentNotificationPreferences;
}) {
  return <NotificationPreferencesForm role="student" values={preferences} />;
}
