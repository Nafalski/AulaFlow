import type { Metadata } from "next";
import Link from "next/link";

import { SignUpForm } from "./sign-up-form";
import { AuthCard } from "@/components/auth/auth-card";

export const metadata: Metadata = {
  title: "Criar conta",
  description: "Crie a sua conta AulaFlow e comece a organizar as suas aulas.",
};

export default function SignUpPage() {
  return (
    <AuthCard
      title="Criar conta"
      description="Leva menos de um minuto."
      footer={
        <>
          Já tem conta?{" "}
          <Link
            href="/entrar"
            className="font-semibold text-brand underline-offset-2 hover:underline"
          >
            Entrar
          </Link>
        </>
      }
    >
      <SignUpForm />
    </AuthCard>
  );
}
