import { z } from "zod";

import { ASSIGNABLE_MEMBER_ROLES, WORKSPACE_TIMEZONES } from "@/lib/domain/workspaces";
import {
  formChecked,
  formString,
  normalizeOptionalUuid,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

export const WORKSPACE_LIMITS = {
  name: 120,
  email: 254,
  reason: 500,
} as const;

const requiredUuid = (message: string) => z.preprocess(normalizeRequiredUuid, z.uuid(message));

/**
 * Emails são comparados em minúsculas, tal como na base: é a correspondência
 * de email confirmado que faz o trabalho de um token de convite, e
 * `Ana@Exemplo.pt` tem de ser a mesma pessoa que `ana@exemplo.pt`.
 */
const emailField = z.preprocess(
  (value) => {
    const normalized = normalizeSingleLine(value);
    return typeof normalized === "string" ? normalized.toLowerCase() : normalized;
  },
  z
    .string({ error: "Escreva o email do professor." })
    .min(3, "Escreva um email válido.")
    .max(WORKSPACE_LIMITS.email, "O email é demasiado longo.")
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Escreva um email válido."),
);

const clubNameField = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escreva o nome do clube." })
    .min(2, "O nome tem de ter pelo menos 2 caracteres.")
    .max(WORKSPACE_LIMITS.name, "O nome é demasiado longo (máximo 120 caracteres)."),
);

const timezoneField = z.preprocess(
  (value) => normalizeSingleLine(value) || undefined,
  z.enum(WORKSPACE_TIMEZONES, { error: "Escolha um fuso horário válido." }).default("Europe/Lisbon"),
);

/**
 * `owner` não é aceite em nenhum formulário: a propriedade nasce com o clube.
 * Sem esta restrição, bastaria trocar o valor de um `select` para pedir a
 * propriedade de um clube alheio — e o servidor teria de ser o único a dizer
 * que não.
 */
const assignableRoleField = z.preprocess(
  (value) => normalizeSingleLine(value) || undefined,
  z.enum(ASSIGNABLE_MEMBER_ROLES, { error: "Escolha um papel válido." }),
);

const idempotencyKeyField = requiredUuid(
  "Atualize a página antes de voltar a submeter este formulário.",
);

const suspensionReasonField = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escreva um motivo administrativo." })
    .min(3, "O motivo tem de ter pelo menos 3 caracteres.")
    .max(WORKSPACE_LIMITS.reason, "O motivo é demasiado longo (máximo 500 caracteres)."),
);

export const clubFormSchema = z.strictObject({
  name: clubNameField,
  timezone: timezoneField,
  idempotencyKey: idempotencyKeyField,
});

export const workspaceInvitationSchema = z.strictObject({
  organizationId: requiredUuid("O clube selecionado é inválido."),
  email: emailField,
  role: assignableRoleField,
  idempotencyKey: idempotencyKeyField,
});

export const workspaceInvitationIdSchema = z.strictObject({
  invitationId: requiredUuid("O convite selecionado é inválido."),
});

export const workspaceInvitationRevokeSchema = z.strictObject({
  invitationId: requiredUuid("O convite selecionado é inválido."),
  confirmed: z.literal(true, { error: "Confirme a revogação do convite." }),
});

export const workspaceMemberRoleSchema = z.strictObject({
  membershipId: requiredUuid("O membro selecionado é inválido."),
  role: assignableRoleField,
  confirmed: z.literal(true, { error: "Confirme a alteração de papel." }),
});

export const workspaceMemberRemovalSchema = z.strictObject({
  membershipId: requiredUuid("O membro selecionado é inválido."),
  confirmed: z.literal(true, { error: "Confirme a remoção do membro." }),
});

export const workspaceStatusSchema = z
  .strictObject({
    organizationId: requiredUuid("O clube selecionado é inválido."),
    status: z.preprocess(
      (value) => normalizeSingleLine(value) || undefined,
      z.enum(["active", "suspended"], { error: "Escolha um estado válido." }),
    ),
    reason: z.preprocess(
      (value) => {
        const normalized = normalizeSingleLine(value);
        return normalized === "" ? undefined : normalized;
      },
      suspensionReasonField.optional(),
    ),
    confirmed: z.literal(true, { error: "Confirme a alteração do estado do clube." }),
  })
  .refine((value) => value.status !== "suspended" || Boolean(value.reason), {
    error: "Escreva o motivo da suspensão.",
    path: ["reason"],
  });

/**
 * Contexto ativo.
 *
 * Um valor vazio significa "voltar ao workspace pessoal" — é o fallback e tem
 * de ser sempre alcançável, mesmo quando um clube deixou de estar disponível.
 */
export const activeWorkspaceSchema = z.strictObject({
  organizationId: z.preprocess(
    normalizeOptionalUuid,
    z.uuid("O contexto selecionado é inválido.").nullable(),
  ),
});

export type ClubFormInput = z.infer<typeof clubFormSchema>;
export type WorkspaceInvitationInput = z.infer<typeof workspaceInvitationSchema>;
export type WorkspaceStatusInput = z.infer<typeof workspaceStatusSchema>;

export const CLUB_FORM_FIELDS = ["name", "timezone", "idempotencyKey"] as const;
export const WORKSPACE_INVITATION_FIELDS = [
  "organizationId",
  "email",
  "role",
  "idempotencyKey",
] as const;
export const WORKSPACE_INVITATION_ID_FIELDS = ["invitationId"] as const;
export const WORKSPACE_INVITATION_REVOKE_FIELDS = ["invitationId", "confirmed"] as const;
export const WORKSPACE_MEMBER_ROLE_FIELDS = ["membershipId", "role", "confirmed"] as const;
export const WORKSPACE_MEMBER_REMOVAL_FIELDS = ["membershipId", "confirmed"] as const;
export const WORKSPACE_STATUS_FIELDS = [
  "organizationId",
  "status",
  "reason",
  "confirmed",
] as const;
export const ACTIVE_WORKSPACE_FIELDS = ["organizationId"] as const;

export function readClubFormData(formData: FormData) {
  return {
    name: formString(formData, "name"),
    timezone: formString(formData, "timezone"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readWorkspaceInvitationFormData(formData: FormData) {
  return {
    organizationId: formString(formData, "organizationId"),
    email: formString(formData, "email"),
    role: formString(formData, "role"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readWorkspaceInvitationIdFormData(formData: FormData) {
  return { invitationId: formString(formData, "invitationId") };
}

export function readWorkspaceInvitationRevokeFormData(formData: FormData) {
  return {
    invitationId: formString(formData, "invitationId"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function readWorkspaceMemberRoleFormData(formData: FormData) {
  return {
    membershipId: formString(formData, "membershipId"),
    role: formString(formData, "role"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function readWorkspaceMemberRemovalFormData(formData: FormData) {
  return {
    membershipId: formString(formData, "membershipId"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function readWorkspaceStatusFormData(formData: FormData) {
  return {
    organizationId: formString(formData, "organizationId"),
    status: formString(formData, "status"),
    reason: formString(formData, "reason"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function readActiveWorkspaceFormData(formData: FormData) {
  return { organizationId: formString(formData, "organizationId") };
}

export function unexpectedWorkspaceFields(
  formData: FormData,
  allowedFields: readonly string[],
): string[] {
  return unexpectedFormFields(formData, allowedFields);
}
