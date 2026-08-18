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

/**
 * Hora civil no formato que um `<input type="time">` produz.
 *
 * O campo vazio é a ausência de silêncio, e não uma hora inválida — por isso
 * chega como `null` em vez de falhar a validação.
 */
const quietHourField = z
  .string({ error: "A hora de silêncio é inválida." })
  .trim()
  .transform((value) => (value === "" ? null : value))
  .refine((value) => value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value), {
    error: "Use uma hora entre 00:00 e 23:59.",
  });

/**
 * As preferências que os dois papéis partilham.
 *
 * `inAppEnabled` NÃO está aqui, e a ausência é deliberada. A Etapa 8A decidiu
 * que a notificação dentro da aplicação é o histórico do facto e é sempre
 * escrita; um interruptor que não desliga nada seria uma promessa falsa. A
 * coluna continua na base de dados por compatibilidade, mas nenhum formulário
 * lhe toca.
 */
const notificationPreferencesBase = {
  emailEnabled: z.boolean({ error: "A preferência de avisos por email é inválida." }),
  lessonCreated: z.boolean({ error: "A preferência de novas aulas é inválida." }),
  lessonUpdated: z.boolean({ error: "A preferência de alterações de aula é inválida." }),
  lessonCancelled: z.boolean({ error: "A preferência de cancelamentos é inválida." }),
  lessonRescheduled: z.boolean({ error: "A preferência de reagendamentos é inválida." }),
  participantChanged: z.boolean({ error: "A preferência de participantes é inválida." }),
  reminder24h: z.boolean({ error: "A preferência do lembrete de 24 horas é inválida." }),
  reminder2h: z.boolean({ error: "A preferência do lembrete de 2 horas é inválida." }),
  quietHoursStart: quietHourField,
  quietHoursEnd: quietHourField,
};

/**
 * Uma hora sozinha não descreve intervalo nenhum, e início igual a fim é
 * ambíguo de uma forma perigosa: tanto se lê como "nunca há silêncio" como
 * "silêncio o dia inteiro". Recusar é a única leitura que não adivinha.
 *
 * A mesma regra está imposta por uma constraint no PostgreSQL — isto é a
 * mensagem legível, não a garantia.
 */
function refineQuietHours(
  value: { quietHoursStart: string | null; quietHoursEnd: string | null },
  ctx: z.RefinementCtx,
) {
  const { quietHoursStart: start, quietHoursEnd: end } = value;

  if ((start === null) !== (end === null)) {
    ctx.addIssue({
      code: "custom",
      path: [start === null ? "quietHoursStart" : "quietHoursEnd"],
      message: "Indique a hora de início e a de fim, ou deixe as duas vazias.",
    });
    return;
  }

  if (start !== null && end !== null && start === end) {
    ctx.addIssue({
      code: "custom",
      path: ["quietHoursEnd"],
      message: "A hora de fim tem de ser diferente da de início.",
    });
  }
}

export const notificationPreferencesSchema = z
  .strictObject(notificationPreferencesBase)
  .superRefine(refineQuietHours);

/**
 * O aluno é quem recebe os avisos de pacote da Etapa 8B, e por isso é o único
 * que os configura. Um formulário partilhado que enviasse estes campos para o
 * professor faria o parser estrito gravá-los como `false` — desligando em
 * silêncio preferências que ninguém pediu para desligar.
 */
export const studentNotificationPreferencesSchema = z
  .strictObject({
    ...notificationPreferencesBase,
    packageExpiring: z.boolean({ error: "A preferência de pacote a terminar é inválida." }),
    packageExpired: z.boolean({ error: "A preferência de pacote expirado é inválida." }),
    packageLowBalance: z.boolean({ error: "A preferência de poucas aulas é inválida." }),
  })
  .superRefine(refineQuietHours);

export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;
export type StudentNotificationPreferencesInput = z.infer<
  typeof studentNotificationPreferencesSchema
>;

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
    emailEnabled: checkedValue(formData, "emailEnabled"),
    lessonCreated: checkedValue(formData, "lessonCreated"),
    lessonUpdated: checkedValue(formData, "lessonUpdated"),
    lessonCancelled: checkedValue(formData, "lessonCancelled"),
    lessonRescheduled: checkedValue(formData, "lessonRescheduled"),
    participantChanged: checkedValue(formData, "participantChanged"),
    reminder24h: checkedValue(formData, "reminder24h"),
    reminder2h: checkedValue(formData, "reminder2h"),
    quietHoursStart: stringValue(formData, "quietHoursStart") ?? "",
    quietHoursEnd: stringValue(formData, "quietHoursEnd") ?? "",
  };
}

/** Os campos do aluno: os partilhados mais os três avisos de pacote. */
export function readStudentNotificationPreferencesFormData(formData: FormData) {
  return {
    ...readNotificationPreferencesFormData(formData),
    packageExpiring: checkedValue(formData, "packageExpiring"),
    packageExpired: checkedValue(formData, "packageExpired"),
    packageLowBalance: checkedValue(formData, "packageLowBalance"),
  };
}
