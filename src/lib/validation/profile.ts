import { z } from "zod";

/** Opções que a aplicação consegue tratar realmente nesta fase. */
export const SUPPORTED_LOCALES = ["pt-PT"] as const;
export const SUPPORTED_TIMEZONES = [
  "Europe/Lisbon",
  "Atlantic/Madeira",
  "Atlantic/Azores",
] as const;
export const CONTACT_PREFERENCES = ["email", "phone"] as const;

export const PROFILE_LIMITS = {
  fullName: 120,
  publicName: 120,
  bio: 1_000,
  serviceArea: 160,
} as const;

function normalizeSingleLine(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptionalSingleLine(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const normalized = normalizeSingleLine(value);
  return normalized === "" ? null : normalized;
}

function normalizeOptionalMultiline(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;

  const normalized = value.trim().replace(/\r\n?/g, "\n");
  return normalized === "" ? null : normalized;
}

/**
 * Guarda telefones num formato comparável e adequado a links `tel:`.
 *
 * Nove algarismos sem indicativo são interpretados como um número português;
 * números estrangeiros têm de trazer `+` ou o prefixo internacional `00`.
 */
function normalizePhone(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;

  let normalized = value.trim();
  if (normalized === "") return null;

  normalized = normalized.replace(/[\s().-]/g, "");

  if (normalized.startsWith("00")) {
    normalized = `+${normalized.slice(2)}`;
  } else if (/^\d{9}$/.test(normalized)) {
    normalized = `+351${normalized}`;
  } else if (/^351\d{9}$/.test(normalized)) {
    normalized = `+${normalized}`;
  }

  return normalized;
}

const fullNameField = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escreva o seu nome." })
    .min(2, "O nome tem de ter pelo menos 2 caracteres.")
    .max(PROFILE_LIMITS.fullName, "O nome é demasiado longo (máximo 120 caracteres)."),
);

const phoneField = z.preprocess(
  normalizePhone,
  z
    .string({ error: "Escreva um número de telefone válido." })
    .regex(/^\+[1-9]\d{7,14}$/, "Escreva um telefone válido, com indicativo quando necessário.")
    .nullable(),
);

const localeField = z.preprocess(
  (value) => {
    const normalized = normalizeSingleLine(value);
    return normalized === "" ? undefined : normalized;
  },
  z
    .enum(SUPPORTED_LOCALES, { error: "Escolha um idioma suportado." })
    .default("pt-PT"),
);

const timezoneField = z.preprocess(
  (value) => {
    const normalized = normalizeSingleLine(value);
    return normalized === "" ? undefined : normalized;
  },
  z
    .enum(SUPPORTED_TIMEZONES, { error: "Escolha um fuso horário suportado." })
    .default("Europe/Lisbon"),
);

const contactPreferenceField = z.preprocess(
  (value) => {
    const normalized = normalizeSingleLine(value);
    return normalized === "" ? undefined : normalized;
  },
  z
    .enum(CONTACT_PREFERENCES, { error: "Escolha email ou telefone como contacto preferencial." })
    .default("email"),
);

/** Campos privados comuns às contas de professor e de aluno. */
export const accountProfileSchema = z
  .strictObject({
    fullName: fullNameField,
    phone: phoneField,
    locale: localeField,
    timezone: timezoneField,
    contactPreference: contactPreferenceField,
  })
  .superRefine((data, context) => {
    if (data.contactPreference === "phone" && data.phone === null) {
      context.addIssue({
        code: "custom",
        path: ["phone"],
        message: "Indique um telefone para o usar como contacto preferencial.",
      });
    }
  });

export type AccountProfileInput = z.infer<typeof accountProfileSchema>;

const optionalBioField = z.preprocess(
  normalizeOptionalMultiline,
  z
    .string({ error: "A apresentação é inválida." })
    .min(2, "A apresentação tem de ter pelo menos 2 caracteres.")
    .max(PROFILE_LIMITS.bio, "A apresentação é demasiado longa (máximo 1000 caracteres).")
    .nullable(),
);

const optionalServiceAreaField = z.preprocess(
  normalizeOptionalSingleLine,
  z
    .string({ error: "A zona de atuação é inválida." })
    .min(2, "A zona de atuação tem de ter pelo menos 2 caracteres.")
    .max(PROFILE_LIMITS.serviceArea, "A zona de atuação é demasiado longa (máximo 160 caracteres).")
    .nullable(),
);

const sportIdField = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.uuid("A modalidade selecionada é inválida."),
);

/** Dados que podem ser apresentados aos alunos. */
export const teacherPublicProfileSchema = z.strictObject({
  publicName: z.preprocess(
    normalizeSingleLine,
    z
      .string({ error: "Escreva o nome público ou profissional." })
      .min(2, "O nome público tem de ter pelo menos 2 caracteres.")
      .max(PROFILE_LIMITS.publicName, "O nome público é demasiado longo (máximo 120 caracteres)."),
  ),
  bio: optionalBioField,
  serviceArea: optionalServiceAreaField,
  sportIds: z
    .array(sportIdField, { error: "Escolha pelo menos uma modalidade." })
    .min(1, "Escolha pelo menos uma modalidade.")
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Cada modalidade só pode ser escolhida uma vez.",
    }),
});

export type TeacherPublicProfileInput = z.infer<typeof teacherPublicProfileSchema>;

export const NOTIFICATION_PREFERENCE_KEYS = [
  "inAppEnabled",
  "emailEnabled",
  "lessonCreated",
  "lessonUpdated",
  "lessonCancelled",
  "lessonRescheduled",
  "participantChanged",
  "reminder24h",
  "reminder2h",
] as const;

/** Só inclui canais e eventos que já existem no MVP; WhatsApp fica excluído. */
export const notificationPreferencesSchema = z.strictObject({
  inAppEnabled: z.boolean({ error: "A preferência de avisos na aplicação é inválida." }),
  emailEnabled: z.boolean({ error: "A preferência de avisos por email é inválida." }),
  lessonCreated: z.boolean({ error: "A preferência de novas aulas é inválida." }),
  lessonUpdated: z.boolean({ error: "A preferência de alterações de aula é inválida." }),
  lessonCancelled: z.boolean({ error: "A preferência de cancelamentos é inválida." }),
  lessonRescheduled: z.boolean({ error: "A preferência de reagendamentos é inválida." }),
  participantChanged: z.boolean({ error: "A preferência de participantes é inválida." }),
  reminder24h: z.boolean({ error: "A preferência do lembrete de 24 horas é inválida." }),
  reminder2h: z.boolean({ error: "A preferência do lembrete de 2 horas é inválida." }),
});

export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

function stringValue(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

function checkedValue(formData: FormData, key: string): boolean {
  return formData.getAll(key).some((value) => {
    if (typeof value !== "string") return false;
    return ["on", "true", "1"].includes(value.trim().toLowerCase());
  });
}

/**
 * Projeta apenas os campos editáveis da própria conta.
 * IDs, papel, organização e estado enviados manualmente ficam de fora.
 */
export function readAccountProfileFormData(formData: FormData) {
  return {
    fullName: stringValue(formData, "fullName"),
    phone: stringValue(formData, "phone"),
    locale: stringValue(formData, "locale"),
    timezone: stringValue(formData, "timezone"),
    contactPreference: stringValue(formData, "contactPreference"),
  };
}

/** Projeta apenas a parte pública editável do perfil do professor. */
export function readTeacherPublicProfileFormData(formData: FormData) {
  return {
    publicName: stringValue(formData, "publicName"),
    bio: stringValue(formData, "bio"),
    serviceArea: stringValue(formData, "serviceArea"),
    sportIds: formData
      .getAll("sportIds")
      .filter((value): value is string => typeof value === "string"),
  };
}

/** Converte o comportamento próprio dos checkboxes HTML em booleanos reais. */
export function readNotificationPreferencesFormData(formData: FormData) {
  return {
    inAppEnabled: checkedValue(formData, "inAppEnabled"),
    emailEnabled: checkedValue(formData, "emailEnabled"),
    lessonCreated: checkedValue(formData, "lessonCreated"),
    lessonUpdated: checkedValue(formData, "lessonUpdated"),
    lessonCancelled: checkedValue(formData, "lessonCancelled"),
    lessonRescheduled: checkedValue(formData, "lessonRescheduled"),
    participantChanged: checkedValue(formData, "participantChanged"),
    reminder24h: checkedValue(formData, "reminder24h"),
    reminder2h: checkedValue(formData, "reminder2h"),
  };
}
