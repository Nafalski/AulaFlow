import type { Metadata } from "next";
import Link from "next/link";

import { ResetRequestForm } from "./reset-request-form";
import { AuthCard } from "@/components/auth/auth-card";

export const metadata: Metadata = {
  title: "Recuperar acesso",
  description: "Receba um email para definir uma nova palavra-passe.",
};

export default function RecoverPage() {
  return (
    <AuthCard
      title="Recuperar acesso"
      description="Escreva o seu email e enviamos-lhe um link para definir uma nova palavra-passe."
      footer={
        <Link href="/entrar" className="font-semibold text-brand underline-offset-2 hover:underline">
          Voltar ao início de sessão
        </Link>
      }
    >
      <ResetRequestForm />
    </AuthCard>
  );
}
