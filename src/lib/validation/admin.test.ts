import { describe, expect, it } from "vitest";

import {
  adminAccountStatusSchema,
  adminUserFiltersSchema,
  readAdminAccountStatusFormData,
  readAdminUserFiltersFormData,
} from "./admin";

const PROFILE_ID = "33333333-3333-4333-8333-333333333333";

describe("adminUserFiltersSchema", () => {
  it("normaliza a pesquisa e aplica filtros por omissão", () => {
    expect(adminUserFiltersSchema.parse({ search: "  Ana   Silva  " })).toEqual({
      search: "Ana Silva",
      role: "all",
      status: "all",
    });
  });

  it("aceita funções e estados conhecidos", () => {
    expect(
      adminUserFiltersSchema.parse({ search: "", role: "teacher", status: "blocked" }),
    ).toEqual({ search: "", role: "teacher", status: "blocked" });
  });

  it("rejeita filtros desconhecidos e pesquisas demasiado longas", () => {
    expect(
      adminUserFiltersSchema.safeParse({ search: "A".repeat(121), role: "all", status: "all" })
        .success,
    ).toBe(false);
    expect(
      adminUserFiltersSchema.safeParse({ search: "", role: "owner", status: "all" }).success,
    ).toBe(false);
    expect(
      adminUserFiltersSchema.safeParse({ search: "", role: "all", status: "deleted" }).success,
    ).toBe(false);
  });

  it("ignora parâmetros extra através da projeção de FormData", () => {
    const formData = new FormData();
    formData.set("search", " Marta ");
    formData.set("role", "teacher");
    formData.set("status", "active");
    formData.set("organizationId", "outra-organizacao");
    formData.set("includePrivateNotes", "true");

    const raw = readAdminUserFiltersFormData(formData);
    expect(raw).toEqual({ search: " Marta ", role: "teacher", status: "active" });
    expect("organizationId" in raw).toBe(false);
    expect("includePrivateNotes" in raw).toBe(false);
    expect(adminUserFiltersSchema.parse(raw).search).toBe("Marta");
  });
});

describe("adminAccountStatusSchema", () => {
  it("normaliza e valida o motivo de bloqueio", () => {
    expect(
      adminAccountStatusSchema.parse({
        profileId: ` ${PROFILE_ID} `,
        status: "blocked",
        reason: "  Incumprimento   dos termos  ",
      }),
    ).toEqual({
      profileId: PROFILE_ID,
      status: "blocked",
      reason: "Incumprimento dos termos",
    });
  });

  it("exige um motivo útil para bloquear", () => {
    for (const reason of ["", "a", "ab"]) {
      const parsed = adminAccountStatusSchema.safeParse({
        profileId: PROFILE_ID,
        status: "blocked",
        reason,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("permite reativar sem motivo e recusa pending", () => {
    expect(
      adminAccountStatusSchema.parse({
        profileId: PROFILE_ID,
        status: "active",
        reason: "",
      }).reason,
    ).toBeNull();

    expect(
      adminAccountStatusSchema.safeParse({
        profileId: PROFILE_ID,
        status: "pending",
        reason: "Convite",
      }).success,
    ).toBe(false);
  });

  it("valida o identificador e o limite do motivo", () => {
    expect(
      adminAccountStatusSchema.safeParse({
        profileId: "não-é-uuid",
        status: "blocked",
        reason: "Motivo válido",
      }).success,
    ).toBe(false);
    expect(
      adminAccountStatusSchema.safeParse({
        profileId: PROFILE_ID,
        status: "blocked",
        reason: "A".repeat(501),
      }).success,
    ).toBe(false);
  });

  it("não projeta alterações de papel, organização ou email", () => {
    const formData = new FormData();
    formData.set("profileId", PROFILE_ID);
    formData.set("status", "blocked");
    formData.set("reason", "Pedido administrativo");
    formData.set("role", "admin");
    formData.set("organizationId", "outra-organizacao");
    formData.set("email", "intruso@exemplo.pt");

    const raw = readAdminAccountStatusFormData(formData);
    expect(raw).toEqual({
      profileId: PROFILE_ID,
      status: "blocked",
      reason: "Pedido administrativo",
    });
    expect("role" in raw).toBe(false);
    expect("organizationId" in raw).toBe(false);
    expect("email" in raw).toBe(false);
    expect(adminAccountStatusSchema.safeParse(raw).success).toBe(true);
  });
});
