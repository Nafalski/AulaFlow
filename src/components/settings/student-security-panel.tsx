import { SecuritySettingsCard } from "@/components/settings/security-settings-card";

export function StudentSecurityPanel({ email }: { email: string }) {
  return <SecuritySettingsCard email={email} />;
}
