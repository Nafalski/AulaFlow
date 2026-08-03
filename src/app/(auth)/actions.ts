"use server";

import { redirect } from "next/navigation";

import { getSiteUrl } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  formDataToObject,
  requestPasswordResetSchema,
  signInSchema,
  signUpSchema,
  updatePasswordSchema,
  zodFieldErrors,
  type FormState,
} from "@/lib/validation/auth";

/**
 * Server Actions de autenticação.
 *
 * Os formulários de autenticação passam por Server Actions: tokens não entram
 * nos campos, props ou estado React da aplicação. O formato dos cookies e a
 * renovação da sessão pertencem ao `@supabase/ssr`; não assumir `HttpOnly`,
 * porque a biblioteca também suporta o cliente de browser.
 */

/**
 * Traduz os erros do Supabase, que chegam em inglês e em linguagem técnica.
 *
 * "Invalid login credentials" não diz a ninguém o que fazer a seguir. E é
 * deliberadamente vago sobre QUAL das duas coisas está errada: dizer "este
 * email não existe" transformaria o formulário de login numa forma de
 * descobrir quem está registado na plataforma.
 */
function authErrorMessage(message: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes("invalid login credentials")) {
    return "Email ou palavra-passe incorretos. Verifique e tente novamente.";
  }
  if (normalized.includes("email not confirmed")) {
    return "Ainda não confirmou o seu email. Procure a mensagem que lhe enviámos — inclusive no spam.";
  }
  if (normalized.includes("user already registered")) {
    return "Já existe uma conta com este email. Experimente entrar ou recuperar o acesso.";
  }
  if (normalized.includes("rate limit") || normalized.includes("too many")) {
    return "Demasiadas tentativas seguidas. Aguarde um minuto antes de tentar de novo.";
  }
  if (normalized.includes("password should be")) {
    return "A palavra-passe é demasiado fraca. Use pelo menos 8 caracteres.";
  }
  if (normalized.includes("same password")) {
    return "A nova palavra-passe tem de ser diferente da anterior.";
  }

  return "Não foi possível concluir a operação. Tente novamente dentro de instantes.";
}

/** Impede redirecionamentos abertos: só caminhos internos são aceites. */
function safeRedirectTarget(value: string | undefined): string {
  if (!value) return "/inicio";
  if (!value.startsWith("/") || value.startsWith("//")) return "/inicio";
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = formDataToObject(formData);
  const parsed = signInSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      status: "error",
      fieldErrors: zodFieldErrors(parsed.error),
      values: { email: raw.email ?? "" },
    };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    return {
      status: "error",
      message: authErrorMessage(error.message),
      values: { email: parsed.data.email },
    };
  }

  // `redirect` lança uma exceção interna do Next para interromper a ação —
  // por isso fica fora de qualquer try/catch, que a engoliria.
  redirect(safeRedirectTarget(raw.proximo));
}

// ─────────────────────────────────────────────────────────────────────────────

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = formDataToObject(formData);
  const parsed = signUpSchema.safeParse(raw);

  const echo = {
    fullName: raw.fullName ?? "",
    email: raw.email ?? "",
    role: raw.role ?? "teacher",
  };

  if (!parsed.success) {
    return { status: "error", fieldErrors: zodFieldErrors(parsed.error), values: echo };
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${getSiteUrl()}/auth/callback`,
      // Lidos pelo trigger handle_new_user(). O `role` é revalidado do lado da
      // base de dados: qualquer valor diferente de 'teacher' torna-se
      // 'student', pelo que injetar 'admin' aqui não tem efeito.
      data: {
        full_name: parsed.data.fullName,
        role: parsed.data.role,
      },
    },
  });

  if (error) {
    return { status: "error", message: authErrorMessage(error.message), values: echo };
  }

  // Sem sessão imediata = a confirmação de email está ativa (o que se
  // recomenda; é o que impede alguém de reclamar a ficha de outro aluno).
  if (!data.session) {
    return {
      status: "success",
      message:
        "Conta criada. Enviámos-lhe um email de confirmação — abra-o para começar a usar o AulaFlow.",
    };
  }

  redirect("/inicio");
}

// ─────────────────────────────────────────────────────────────────────────────

export async function requestPasswordResetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formDataToObject(formData);
  const parsed = requestPasswordResetSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      status: "error",
      fieldErrors: zodFieldErrors(parsed.error),
      values: { email: raw.email ?? "" },
    };
  }

  const supabase = await createSupabaseServerClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${getSiteUrl()}/auth/callback?proximo=/redefinir-senha`,
  });

  // A mesma resposta quer o email exista ou não — e o erro é ignorado de
  // propósito. Distinguir os dois casos transformaria este formulário num
  // verificador de quem tem conta na plataforma.
  return {
    status: "success",
    message:
      "Se existir uma conta com esse email, enviámos-lhe as instruções para definir uma nova palavra-passe.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export async function updatePasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = updatePasswordSchema.safeParse(formDataToObject(formData));

  if (!parsed.success) {
    return { status: "error", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createSupabaseServerClient();

  // A sessão vem do link de recuperação, já trocado por cookies no
  // /auth/callback. Sem ela, qualquer pessoa poderia mudar a palavra-passe
  // de qualquer conta.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      status: "error",
      message:
        "O link de recuperação expirou ou já foi usado. Peça um novo em «Recuperar acesso».",
    };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    return { status: "error", message: authErrorMessage(error.message) };
  }

  redirect("/inicio");
}
