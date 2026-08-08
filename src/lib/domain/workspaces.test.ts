import { describe, expect, it } from "vitest";

import {
  ASSIGNABLE_MEMBER_ROLES,
  MEMBER_ROLE_LABELS,
  PERSONAL_ONLY_MODULES,
  canChangeMemberRole,
  canCreateClub,
  canInviteRole,
  canManageMembers,
  canRemoveMember,
  invitableRoles,
  isWorkspaceOperational,
  sortWorkspaceContexts,
  toWorkspaceSwitcherEntries,
  workspaceContextLabel,
  workspaceStatusTone,
} from "./workspaces";
import type { WorkspaceMemberRole, WorkspaceStatus } from "@/types/database";

const activeMember = (role: WorkspaceMemberRole, isSelf = false) =>
  ({ role, status: "active" as const, isSelf });

describe("permissões de gestão", () => {
  it("só proprietário e gestor gerem membros", () => {
    expect(canManageMembers("owner", "active")).toBe(true);
    expect(canManageMembers("manager", "active")).toBe(true);
    expect(canManageMembers("teacher", "active")).toBe(false);
  });

  it("clube suspenso bloqueia a gestão de membros sem apagar nada", () => {
    expect(isWorkspaceOperational("suspended")).toBe(false);
    expect(canManageMembers("owner", "suspended")).toBe(false);
    expect(canManageMembers("manager", "suspended")).toBe(false);
    expect(canManageMembers("owner", "archived")).toBe(false);
  });

  it("professor comum não convida", () => {
    expect(canInviteRole("teacher", "teacher", "active")).toBe(false);
    expect(invitableRoles("teacher", "active")).toEqual([]);
  });

  it("gestor convida professores, proprietário convida também gestores", () => {
    expect(canInviteRole("manager", "teacher", "active")).toBe(true);
    expect(canInviteRole("manager", "manager", "active")).toBe(false);
    expect(canInviteRole("owner", "manager", "active")).toBe(true);

    expect(invitableRoles("manager", "active")).toEqual(["teacher"]);
    expect(invitableRoles("owner", "active")).toEqual(["manager", "teacher"]);
  });

  it("ninguém é convidado para proprietário", () => {
    expect(canInviteRole("owner", "owner", "active")).toBe(false);
    expect(ASSIGNABLE_MEMBER_ROLES).not.toContain("owner");
  });
});

describe("alteração de papel", () => {
  it("gestor promove professor a gestor", () => {
    expect(canChangeMemberRole("manager", activeMember("teacher"), "active")).toBe(true);
  });

  it("ninguém altera o próprio papel", () => {
    expect(canChangeMemberRole("owner", activeMember("manager", true), "active")).toBe(false);
    expect(canChangeMemberRole("manager", activeMember("manager", true), "active")).toBe(false);
  });

  it("o papel do proprietário não é alterado por aqui", () => {
    expect(canChangeMemberRole("owner", activeMember("owner"), "active")).toBe(false);
    expect(canChangeMemberRole("manager", activeMember("owner"), "active")).toBe(false);
  });

  it("professor comum não altera papéis", () => {
    expect(canChangeMemberRole("teacher", activeMember("teacher"), "active")).toBe(false);
  });

  it("um vínculo não ativo não muda de papel", () => {
    expect(
      canChangeMemberRole("owner", { role: "teacher", status: "revoked", isSelf: false }, "active"),
    ).toBe(false);
  });
});

describe("remoção de membros", () => {
  it("proprietário remove professor", () => {
    expect(canRemoveMember("owner", activeMember("teacher"), 1, "active")).toBe(true);
  });

  it("gestor remove professor", () => {
    expect(canRemoveMember("manager", activeMember("teacher"), 1, "active")).toBe(true);
  });

  it("o último proprietário não pode ser removido", () => {
    expect(canRemoveMember("owner", activeMember("owner"), 1, "active")).toBe(false);
    expect(canRemoveMember("owner", activeMember("owner"), 2, "active")).toBe(true);
  });

  it("gestor não remove proprietário", () => {
    expect(canRemoveMember("manager", activeMember("owner"), 2, "active")).toBe(false);
  });

  it("ninguém se remove a si próprio por esta via", () => {
    expect(canRemoveMember("owner", activeMember("manager", true), 2, "active")).toBe(false);
  });

  it("clube suspenso bloqueia remoções", () => {
    expect(canRemoveMember("owner", activeMember("teacher"), 1, "suspended")).toBe(false);
  });
});

describe("criação de clube", () => {
  it("só um professor cria clubes", () => {
    expect(canCreateClub("teacher")).toBe(true);
    expect(canCreateClub("student")).toBe(false);
    expect(canCreateClub("admin")).toBe(false);
  });
});

describe("contextos", () => {
  const contexts = [
    { organizationName: "Arena Lisboa", isPersonal: false },
    { organizationName: "Marco", isPersonal: true },
    { organizationName: "Clube Central", isPersonal: false },
  ];

  it("o workspace pessoal vem sempre primeiro", () => {
    expect(sortWorkspaceContexts(contexts).map((context) => context.organizationName)).toEqual([
      "Marco",
      "Arena Lisboa",
      "Clube Central",
    ]);
  });

  it("não muta a lista recebida", () => {
    const original = [...contexts];
    sortWorkspaceContexts(contexts);
    expect(contexts).toEqual(original);
  });

  it("rotula o contexto pessoal com o nome do professor", () => {
    expect(workspaceContextLabel({ organizationName: "Marco", isPersonal: true }, "Marco")).toBe(
      "Marco — Pessoal",
    );
    expect(workspaceContextLabel({ organizationName: "Marco", isPersonal: true }, null)).toBe(
      "Pessoal",
    );
    expect(
      workspaceContextLabel({ organizationName: "Clube Central", isPersonal: false }, "Marco"),
    ).toBe("Clube Central");
  });
});

describe("opções do seletor de contexto", () => {
  const contexts = [
    {
      organizationId: "b2",
      organizationName: "Clube Central",
      kind: "club" as const,
      workspaceStatus: "active" as const,
      role: "manager" as const,
      isPersonal: false,
      isActiveContext: true,
      activeMemberCount: 3,
    },
    {
      organizationId: "a1",
      organizationName: "Marco",
      kind: "personal" as const,
      workspaceStatus: "active" as const,
      role: "owner" as const,
      isPersonal: true,
      isActiveContext: false,
      activeMemberCount: 1,
    },
  ];

  it("devolve apenas dados simples serializáveis", () => {
    const entries = toWorkspaceSwitcherEntries(contexts, "Marco");

    for (const entry of entries) {
      for (const value of Object.values(entry)) {
        expect(typeof value).not.toBe("function");
        expect(typeof value).not.toBe("symbol");
        expect(typeof value).not.toBe("bigint");
        expect(value === null || typeof value !== "object").toBe(true);
      }

      expect(structuredClone(entry)).toEqual(entry);
    }
  });

  it("mantém o contexto pessoal em primeiro e assinala o atual", () => {
    const entries = toWorkspaceSwitcherEntries(contexts, "Marco");

    expect(entries.map((entry) => entry.label)).toEqual(["Marco — Pessoal", "Clube Central"]);
    expect(entries.map((entry) => entry.isActive)).toEqual([false, true]);
  });

  it("não expõe contagens, estados internos nem identificadores de membership", () => {
    const [entry] = toWorkspaceSwitcherEntries(contexts, "Marco");

    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "isActive",
      "isPersonal",
      "kind",
      "label",
      "organizationId",
      "role",
    ]);
  });
});

describe("apresentação", () => {
  it("cada estado de workspace tem um tom próprio", () => {
    const statuses: WorkspaceStatus[] = ["active", "suspended", "archived"];
    expect(statuses.map(workspaceStatusTone)).toEqual(["success", "warning", "neutral"]);
  });

  it("cada papel interno tem rótulo em português", () => {
    expect(Object.values(MEMBER_ROLE_LABELS)).toEqual(["Proprietário", "Gestor", "Professor"]);
  });

  it("declara explicitamente os módulos que continuam só no contexto pessoal", () => {
    expect(PERSONAL_ONLY_MODULES).toContain("Alunos");
    expect(PERSONAL_ONLY_MODULES).toContain("Pacotes e créditos");
    expect(PERSONAL_ONLY_MODULES).toContain("Disponibilidade");
  });

  // Um local pode pertencer a um clube desde a 5B.3A, e os seus campos e salas
  // herdam esse contexto na 5B.3B. Continuar a anunciá-lo como pessoal seria
  // desinformar na direção oposta à do resto desta lista.
  it("já não afirma que os locais são apenas pessoais", () => {
    expect(PERSONAL_ONLY_MODULES).not.toContain("Locais");
  });
});
