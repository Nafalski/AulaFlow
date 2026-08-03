"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { signUpAction } from "../actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField, TextField } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { IDLE_FORM_STATE, MIN_PASSWORD_LENGTH } from "@/lib/validation/auth";

type Role = "teacher" | "student";

const ROLE_OPTIONS: { value: Role; title: string; description: string }[] = [
  {
    value: "teacher",
    title: "Sou professor",
    description: "Quero criar aulas e gerir os meus alunos.",
  },
  {
    value: "student",
    title: "Sou aluno",
    description: "Quero ver as aulas em que estou inscrito.",
  },
];

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUpAction, IDLE_FORM_STATE);
  const [role, setRole] = useState<Role>(
    (state.values?.role as Role | undefined) ?? "teacher",
  );

  // Após o registo só resta ir ao email. Manter o formulário no ecrã convidaria
  // a submeter outra vez, o que só produziria um erro de "conta já existe".
  if (state.status === "success") {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success" title="Está quase!">
          {state.message}
        </Alert>
        <p className="text-sm text-muted">
          Não recebeu nada? Verifique a pasta de spam, ou{" "}
          <Link href="/criar-conta" className="font-medium text-brand hover:underline">
            tente com outro email
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.status === "error" && state.message && <Alert tone="danger">{state.message}</Alert>}

      {/*
        Escolha do tipo de conta como cartões e não como <select>: é a decisão
        mais importante do formulário, e num telemóvel um menu suspenso esconde
        as opções atrás de um toque.

        `radiogroup` + `radio` dá a leitores de ecrã a mesma semântica que uns
        <input type="radio"> teriam, mantendo o controlo visual.
      */}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-semibold text-ink">
          Como vai usar o AulaFlow?
        </legend>

        <div className="grid gap-2" role="radiogroup" aria-label="Tipo de conta">
          {ROLE_OPTIONS.map((option) => {
            const selected = role === option.value;
            return (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-[var(--radius-field)] border p-3.5 transition-colors",
                  selected
                    ? "border-brand bg-brand-tint"
                    : "border-line bg-surface hover:border-brand/40",
                )}
              >
                <input
                  type="radio"
                  name="role"
                  value={option.value}
                  checked={selected}
                  onChange={() => setRole(option.value)}
                  className="mt-0.5 size-5 shrink-0 text-brand focus:ring-2 focus:ring-brand/25"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-ink">{option.title}</span>
                  <span className="block text-xs text-muted">{option.description}</span>
                </span>
              </label>
            );
          })}
        </div>

        {state.fieldErrors?.role && (
          <p role="alert" className="text-sm font-medium text-state-danger">
            {state.fieldErrors.role}
          </p>
        )}
      </fieldset>

      <TextField
        label="Nome completo"
        name="fullName"
        autoComplete="name"
        placeholder="Ana Marques"
        required
        defaultValue={state.values?.fullName ?? ""}
        error={state.fieldErrors?.fullName}
      />

      <TextField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        placeholder="nome@exemplo.pt"
        required
        defaultValue={state.values?.email ?? ""}
        error={state.fieldErrors?.email}
        hint={
          role === "student"
            ? "Use o mesmo email que deu ao seu professor — é assim que encontramos as suas aulas."
            : undefined
        }
      />

      <TextField
        label="Palavra-passe"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
        error={state.fieldErrors?.password}
      />

      <TextField
        label="Repetir palavra-passe"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.confirmPassword}
      />

      <CheckboxField
        name="acceptTerms"
        error={state.fieldErrors?.acceptTerms}
        label={
          <>
            Li e aceito os{" "}
            <Link href="/termos" className="font-medium text-brand hover:underline">
              Termos de Utilização
            </Link>{" "}
            e a{" "}
            <Link href="/privacidade" className="font-medium text-brand hover:underline">
              Política de Privacidade
            </Link>
            .
          </>
        }
      />

      <Button type="submit" size="lg" fullWidth loading={pending} loadingLabel="A criar conta">
        Criar conta
      </Button>
    </form>
  );
}
