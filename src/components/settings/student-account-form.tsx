import {
  AccountProfileForm,
  type AccountProfileValues,
} from "@/components/settings/account-profile-form";

/** Adapta o formulário comum à área do aluno sem aumentar o bundle cliente da página. */
export function StudentAccountForm(props: AccountProfileValues) {
  return <AccountProfileForm role="student" values={props} />;
}
