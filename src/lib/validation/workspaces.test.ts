import { describe, expect, it } from "vitest";

import {
  ACTIVE_WORKSPACE_FIELDS,
  CLUB_CALENDAR_SHARING_FIELDS,
  CLUB_FORM_FIELDS,
  WORKSPACE_INVITATION_FIELDS,
  WORKSPACE_MEMBER_ROLE_FIELDS,
  WORKSPACE_STATUS_FIELDS,
  activeWorkspaceSchema,
  clubCalendarSharingSchema,
  clubFormSchema,
  unexpectedWorkspaceFields,
  workspaceInvitationSchema,
  workspaceMemberRemovalSchema,
  workspaceMemberRoleSchema,
  workspaceStatusSchema,
} from "./workspaces";

const KEY = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";

function formDataFrom(entries: Record<string, string | string[]>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) formData.append(key, item);
  }
  return formData;
}

describe("clubFormSchema", () => {
  it("normaliza o nome e aceita o fuso por omissão", () => {
    const parsed = clubFormSchema.parse({
      name: "  Clube   Central  ",
      timezone: undefined,
      idempotencyKey: KEY,
    });

    expect(parsed.name).toBe("Clube Central");
    expect(parsed.timezone).toBe("Europe/Lisbon");
  });

  it("recusa nomes demasiado curtos ou demasiado longos", () => {
    expect(clubFormSchema.safeParse({ name: "C", idempotencyKey: KEY }).success).toBe(false);
    expect(
      clubFormSchema.safeParse({ name: "C".repeat(121), idempotencyKey: KEY }).success,
    ).toBe(false);
  });

  it("recusa nome vazio depois da normalização", () => {
    expect(clubFormSchema.safeParse({ name: "   ", idempotencyKey: KEY }).success).toBe(false);
  });

  it("recusa fusos fora dos suportados", () => {
    expect(
      clubFormSchema.safeParse({
        name: "Clube",
        timezone: "America/Sao_Paulo",
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);
  });

  it("exige uma chave de idempotência válida", () => {
    expect(clubFormSchema.safeParse({ name: "Clube", idempotencyKey: "abc" }).success).toBe(false);
  });

  it("recusa campos adicionais, incluindo tentativas de forjar autoria", () => {
    const parsed = clubFormSchema.safeParse({
      name: "Clube",
      idempotencyKey: KEY,
      created_by: ORG,
    });

    expect(parsed.success).toBe(false);
  });
});

describe("workspaceInvitationSchema", () => {
  it("normaliza o email para minúsculas", () => {
    const parsed = workspaceInvitationSchema.parse({
      organizationId: ORG,
      email: "  Ana.Silva@Exemplo.PT ",
      role: "teacher",
      idempotencyKey: KEY,
    });

    expect(parsed.email).toBe("ana.silva@exemplo.pt");
  });

  it("recusa emails inválidos", () => {
    for (const email of ["ana", "ana@", "@exemplo.pt", "ana exemplo.pt", ""]) {
      expect(
        workspaceInvitationSchema.safeParse({
          organizationId: ORG,
          email,
          role: "teacher",
          idempotencyKey: KEY,
        }).success,
      ).toBe(false);
    }
  });

  it("recusa o papel de proprietário", () => {
    expect(
      workspaceInvitationSchema.safeParse({
        organizationId: ORG,
        email: "ana@exemplo.pt",
        role: "owner",
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);
  });

  it("recusa um clube que não seja UUID", () => {
    expect(
      workspaceInvitationSchema.safeParse({
        organizationId: "clube-1",
        email: "ana@exemplo.pt",
        role: "teacher",
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);
  });

  it("recusa campos adicionais", () => {
    expect(
      workspaceInvitationSchema.safeParse({
        organizationId: ORG,
        email: "ana@exemplo.pt",
        role: "teacher",
        idempotencyKey: KEY,
        invited_by: ORG,
      }).success,
    ).toBe(false);
  });
});

describe("workspaceMemberRoleSchema", () => {
  it("exige confirmação explícita", () => {
    expect(
      workspaceMemberRoleSchema.safeParse({
        membershipId: MEMBERSHIP,
        role: "manager",
        confirmed: false,
      }).success,
    ).toBe(false);
  });

  it("aceita promoção confirmada entre gestor e professor", () => {
    expect(
      workspaceMemberRoleSchema.parse({
        membershipId: MEMBERSHIP,
        role: "manager",
        confirmed: true,
      }).role,
    ).toBe("manager");
  });

  it("recusa a atribuição de proprietário", () => {
    expect(
      workspaceMemberRoleSchema.safeParse({
        membershipId: MEMBERSHIP,
        role: "owner",
        confirmed: true,
      }).success,
    ).toBe(false);
  });
});

describe("workspaceMemberRemovalSchema", () => {
  it("exige confirmação", () => {
    expect(
      workspaceMemberRemovalSchema.safeParse({ membershipId: MEMBERSHIP, confirmed: false }).success,
    ).toBe(false);
    expect(
      workspaceMemberRemovalSchema.safeParse({ membershipId: MEMBERSHIP, confirmed: true }).success,
    ).toBe(true);
  });
});

describe("workspaceStatusSchema", () => {
  it("exige motivo ao suspender", () => {
    const parsed = workspaceStatusSchema.safeParse({
      organizationId: ORG,
      status: "suspended",
      reason: "",
      confirmed: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("aceita suspensão com motivo", () => {
    const parsed = workspaceStatusSchema.parse({
      organizationId: ORG,
      status: "suspended",
      reason: "  Denúncia   confirmada ",
      confirmed: true,
    });

    expect(parsed.reason).toBe("Denúncia confirmada");
  });

  it("aceita reativação sem motivo", () => {
    expect(
      workspaceStatusSchema.safeParse({
        organizationId: ORG,
        status: "active",
        reason: "",
        confirmed: true,
      }).success,
    ).toBe(true);
  });

  it("recusa estados fora de ativo/suspenso", () => {
    expect(
      workspaceStatusSchema.safeParse({
        organizationId: ORG,
        status: "archived",
        reason: "Motivo",
        confirmed: true,
      }).success,
    ).toBe(false);
  });

  it("recusa motivos demasiado longos", () => {
    expect(
      workspaceStatusSchema.safeParse({
        organizationId: ORG,
        status: "suspended",
        reason: "x".repeat(501),
        confirmed: true,
      }).success,
    ).toBe(false);
  });
});

describe("activeWorkspaceSchema", () => {
  it("aceita valor vazio como regresso ao workspace pessoal", () => {
    expect(activeWorkspaceSchema.parse({ organizationId: "" }).organizationId).toBeNull();
  });

  it("recusa um contexto que não seja UUID", () => {
    expect(activeWorkspaceSchema.safeParse({ organizationId: "clube" }).success).toBe(false);
  });

  it("normaliza o UUID para minúsculas", () => {
    expect(
      activeWorkspaceSchema.parse({ organizationId: ORG.toUpperCase() }).organizationId,
    ).toBe(ORG);
  });
});

describe("clubCalendarSharingSchema", () => {
  it("aceita ativar e desativar", () => {
    expect(clubCalendarSharingSchema.parse({ organizationId: ORG, enabled: "true" }).enabled).toBe(
      true,
    );
    expect(clubCalendarSharingSchema.parse({ organizationId: ORG, enabled: "false" }).enabled).toBe(
      false,
    );
  });

  it("recusa um clube que não seja UUID", () => {
    expect(
      clubCalendarSharingSchema.safeParse({ organizationId: "clube", enabled: "true" }).success,
    ).toBe(false);
  });

  it("recusa um estado que não seja booleano", () => {
    expect(
      clubCalendarSharingSchema.safeParse({ organizationId: ORG, enabled: "talvez" }).success,
    ).toBe(false);
    expect(clubCalendarSharingSchema.safeParse({ organizationId: ORG, enabled: "" }).success).toBe(
      false,
    );
  });

  // O alvo nunca vem do formulário: a RPC deriva a membership da sessão.
  it("recusa qualquer tentativa de indicar outro membro ou forjar autoria", () => {
    for (const extra of [
      { membershipId: MEMBERSHIP },
      { profileId: MEMBERSHIP },
      { teacherId: MEMBERSHIP },
      { updatedBy: MEMBERSHIP },
      { role: "owner" },
    ]) {
      expect(
        clubCalendarSharingSchema.safeParse({ organizationId: ORG, enabled: "true", ...extra })
          .success,
      ).toBe(false);
    }
  });

  it("o contrato do formulário tem apenas o clube e o estado", () => {
    expect([...CLUB_CALENDAR_SHARING_FIELDS]).toEqual(["organizationId", "enabled"]);
    expect(
      unexpectedWorkspaceFields(
        formDataFrom({ organizationId: ORG, enabled: "true" }),
        CLUB_CALENDAR_SHARING_FIELDS,
      ),
    ).toEqual([]);
    expect(
      unexpectedWorkspaceFields(
        formDataFrom({ organizationId: ORG, enabled: "true", membershipId: MEMBERSHIP }),
        CLUB_CALENDAR_SHARING_FIELDS,
      ),
    ).toEqual(["membershipId"]);
  });
});

describe("unexpectedWorkspaceFields", () => {
  it("assinala campos fora do contrato", () => {
    const formData = formDataFrom({ name: "Clube", idempotencyKey: KEY, role: "owner" });
    expect(unexpectedWorkspaceFields(formData, CLUB_FORM_FIELDS)).toEqual(["role"]);
  });

  it("assinala campos repetidos", () => {
    const formData = formDataFrom({ organizationId: [ORG, ORG] });
    expect(unexpectedWorkspaceFields(formData, ACTIVE_WORKSPACE_FIELDS)).toEqual([
      "organizationId",
    ]);
  });

  it("ignora os campos internos do Next", () => {
    const formData = formDataFrom({ name: "Clube", idempotencyKey: KEY, $ACTION_ID_x: "1" });
    expect(unexpectedWorkspaceFields(formData, CLUB_FORM_FIELDS)).toEqual([]);
  });

  it("aceita exatamente os contratos declarados", () => {
    expect(
      unexpectedWorkspaceFields(
        formDataFrom({ organizationId: ORG, email: "a@b.pt", role: "teacher", idempotencyKey: KEY }),
        WORKSPACE_INVITATION_FIELDS,
      ),
    ).toEqual([]);

    expect(
      unexpectedWorkspaceFields(
        formDataFrom({ membershipId: MEMBERSHIP, role: "manager", confirmed: "on" }),
        WORKSPACE_MEMBER_ROLE_FIELDS,
      ),
    ).toEqual([]);

    expect(
      unexpectedWorkspaceFields(
        formDataFrom({ organizationId: ORG, status: "suspended", reason: "x", confirmed: "on" }),
        WORKSPACE_STATUS_FIELDS,
      ),
    ).toEqual([]);
  });
});
