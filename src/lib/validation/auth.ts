import { z } from "zod";

/**
 * Schemas de autenticação.
 *
 * O MESMO schema valida no cliente (resposta imediata) e no servidor (a que
 * conta). O requisito pede validação nos dois lados; escrever duas versões
 * garantiria que um dia divergiriam.
 */

/** Mínimo de 8 caracteres — acima do mínimo do Supabase, que é 6. */
export const MIN_PASSWORD_LENGTH = 8;

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Escreva um email válido, como nome@exemplo.pt."));

const passwordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `A palavra-passe tem de ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`)
  .max(72, "A palavra-passe é demasiado longa (máximo 72 caracteres).");

const fullNameField = z
  .string()
  .trim()
  .min(2, "Escreva o seu nome completo.")
  .max(120, "O nome é demasiado longo.");

/** Checkbox de FormData: "on" quando marcada, ausente quando não. */
const acceptedField = z.preprocess(
  (value) => value === "on" || value === "true" || value === true,
  z.boolean().refine((v) => v, "Tem de aceitar os Termos e a Política de Privacidade."),
);

// ─────────────────────────────────────────────────────────────────────────────

export const signInSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Escreva a sua palavra-passe."),
});

export type SignInInput = z.infer<typeof signInSchema>;

export const signUpSchema = z
  .object({
    fullName: fullNameField,
    email: emailField,
    password: passwordField,
    confirmPassword: z.string(),
    /**
     * SEGURANÇA: só 'teacher' e 'student' são aceites aqui, e o trigger
     * handle_new_user() volta a validar do lado da base de dados. Sem essa
     * segunda verificação, este campo seria o caminho mais curto para alguém
     * se registar como administrador.
     */
    role: z.enum(["teacher", "student"], {
      error: "Escolha se é professor ou aluno.",
    }),
    acceptTerms: acceptedField,
  })
  .refine((data) => data.password === data.confirmPassword, {
    error: "As palavras-passe não coincidem.",
    path: ["confirmPassword"],
  });

export type SignUpInput = z.infer<typeof signUpSchema>;

export const requestPasswordResetSchema = z.object({
  email: emailField,
});

export const updatePasswordSchema = z
  .object({
    password: passwordField,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    error: "As palavras-passe não coincidem.",
    path: ["confirmPassword"],
  });

// ─────────────────────────────────────────────────────────────────────────────
// Ponte entre FormData e Zod
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resultado de uma Server Action, no formato que `useActionState` consome.
 *
 * `fieldErrors` é indexado pelo nome do campo para que cada `<Field>` mostre a
 * sua própria mensagem, em vez de uma lista de erros no topo do formulário que
 * obriga o utilizador a descobrir a que campo pertence cada linha.
 */
export interface FormState {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Valores a repor no formulário — nunca inclui palavras-passe. */
  values?: Record<string, string>;
}

export const IDLE_FORM_STATE: FormState = { status: "idle" };

export function formDataToObject(formData: FormData): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") entries[key] = value;
  }
  return entries;
}

/** Achata os erros do Zod para um mapa campo → primeira mensagem. */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    // A primeira mensagem por campo é a mais útil; empilhá-las só gera ruído.
    fieldErrors[key] ??= issue.message;
  }
  return fieldErrors;
}
