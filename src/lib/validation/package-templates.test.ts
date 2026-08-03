import { describe, expect, it } from "vitest";

import {
  formatEuroCentsForInput,
  packageTemplateFiltersSchema,
  packageTemplateFormSchema,
  readPackageTemplateFormData,
  unexpectedPackageTemplateFormFields,
} from "./package-templates";

const SPORT_ID = "44444444-4444-4444-8444-444444444444";

describe("packageTemplateFormSchema", () => {
  it("normaliza modelos com quantidades livres e valor em cêntimos", () => {
    expect(
      packageTemplateFormSchema.parse({
        name: "  Pacote   de 10 aulas ",
        defaultCredits: "10",
        sportId: SPORT_ID,
        description: "  Válido para treinos semanais.\r\nSem pagamentos nesta fase. ",
        validityDays: "60",
        referencePriceCents: "120,50",
        isActive: true,
        confirmDeactivation: false,
      }),
    ).toEqual({
      name: "Pacote de 10 aulas",
      defaultCredits: 10,
      sportId: SPORT_ID,
      description: "Válido para treinos semanais.\nSem pagamentos nesta fase.",
      validityDays: 60,
      referencePriceCents: 12050,
      isActive: true,
      confirmDeactivation: false,
    });

    expect(
      packageTemplateFormSchema.parse({
        name: "Pacote livre",
        defaultCredits: "37",
        sportId: "",
        description: "",
        validityDays: "",
        referencePriceCents: "",
        isActive: false,
        confirmDeactivation: true,
      }),
    ).toMatchObject({
      defaultCredits: 37,
      sportId: null,
      description: null,
      validityDays: null,
      referencePriceCents: null,
      isActive: false,
    });
  });

  it("aceita pacotes comuns de 3 e 10 aulas", () => {
    expect(packageTemplateFormSchema.parse({
      name: "Pacote de 3 aulas",
      defaultCredits: "3",
      sportId: "",
      description: "",
      validityDays: "",
      referencePriceCents: "",
      isActive: true,
      confirmDeactivation: false,
    }).defaultCredits).toBe(3);

    expect(packageTemplateFormSchema.parse({
      name: "Pacote de 10 aulas",
      defaultCredits: "10",
      sportId: "",
      description: "",
      validityDays: "",
      referencePriceCents: "",
      isActive: true,
      confirmDeactivation: false,
    }).defaultCredits).toBe(10);
  });

  it("recusa quantidades zero, negativas ou decimais", () => {
    for (const value of ["0", "-1", "1.5", "2,5"]) {
      expect(packageTemplateFormSchema.safeParse({
        name: "Pacote inválido",
        defaultCredits: value,
        sportId: "",
        description: "",
        validityDays: "",
        referencePriceCents: "",
        isActive: true,
        confirmDeactivation: false,
      }).success).toBe(false);
    }
  });

  it("recusa nome vazio, preço negativo, validade inválida e campos extra", () => {
    expect(packageTemplateFormSchema.safeParse({
      name: " ",
      defaultCredits: "3",
      sportId: "",
      description: "",
      validityDays: "",
      referencePriceCents: "",
      isActive: true,
      confirmDeactivation: false,
    }).success).toBe(false);

    expect(packageTemplateFormSchema.safeParse({
      name: "Pacote",
      defaultCredits: "3",
      sportId: "",
      description: "",
      validityDays: "",
      referencePriceCents: "-1",
      isActive: true,
      confirmDeactivation: false,
    }).success).toBe(false);

    expect(packageTemplateFormSchema.safeParse({
      name: "Pacote",
      defaultCredits: "3",
      sportId: "",
      description: "",
      validityDays: "0",
      referencePriceCents: "",
      isActive: true,
      confirmDeactivation: false,
    }).success).toBe(false);

    expect(packageTemplateFormSchema.safeParse({
      name: "Pacote",
      defaultCredits: "3",
      organizationId: "forjado",
      isActive: true,
      confirmDeactivation: false,
    }).success).toBe(false);
  });

  it("deteta campos de organização, proprietário e auditoria forjados", () => {
    const formData = new FormData();
    formData.set("name", "Pacote");
    formData.set("defaultCredits", "8");
    formData.set("organizationId", "outra");
    formData.set("teacherId", "outro");
    formData.set("createdAt", "2026-08-03");

    expect(readPackageTemplateFormData(formData)).toMatchObject({
      name: "Pacote",
      defaultCredits: "8",
    });
    expect(unexpectedPackageTemplateFormFields(formData, false)).toEqual([
      "organizationId",
      "teacherId",
      "createdAt",
    ]);
  });

  it("normaliza filtros e formata valores monetários para inputs", () => {
    expect(packageTemplateFiltersSchema.parse({
      search: "  pacote   praia ",
      status: "inactive",
      sportId: SPORT_ID,
    })).toEqual({
      search: "pacote praia",
      status: "inactive",
      sportId: SPORT_ID,
    });
    expect(packageTemplateFiltersSchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(formatEuroCentsForInput(12345)).toBe("123,45");
    expect(formatEuroCentsForInput(null)).toBe("");
  });
});
