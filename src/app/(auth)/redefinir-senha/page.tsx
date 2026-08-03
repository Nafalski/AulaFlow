import type { Metadata } from "next";
import Link from "next/link";

import { UpdatePasswordForm } from "./update-password-form";
import { AuthCard } from "@/components/auth/auth-card";
import { Alert } from "@/components/ui/alert";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Nova palavra-passe",
};

/** Depende da sessão criada pelo link de recuperação: nunca pré-renderizada. */
export const dynamic = "force-dynamic";

/**
 * Chegada do link de recuperação.
 *
 * A altura em que se chega aqui já tem sessão: o `/auth/callback` trocou o
 * código do email por cookies antes de redirecionar. Sem sessão, o link
 * expirou ou já foi usado — e é preciso dizê-lo, em vez de mostrar um
 * formulário que só falharia ao submeter.
 */
export default async function ResetPasswordPage() {
  const user = await getSessionUser();

  if (!user) {
    return (
      <AuthCard
        title="Link inválido"
        footer={
          <Link
            href="/recuperar-acesso"
            className="font-semibold text-brand underline-offset-2 hover:underline"
          >
            Pedir um novo link
          </Link>
        }
      >
        <Alert tone="warning" title="Este link já não é válido">
          Os links de recuperação expiram por segurança e só podem ser usados uma vez. Peça um
          novo e use-o assim que o receber.
        </Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Nova palavra-passe"
      description={`A definir uma nova palavra-passe para ${user.email}.`}
    >
      <UpdatePasswordForm />
    </AuthCard>
  );
}
