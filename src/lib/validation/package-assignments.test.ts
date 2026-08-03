import { describe, expect, it } from "vitest";

import {
  packageAssignmentFormSchema,
  readPackageAssignmentFormData,
  unexpectedPackageAssignmentFormFields,
} from "./package-assignments";

const STUDENT_ID = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";
const SPORT_ID = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";

function form(overrides: Partial<Record<string, string>> = {}) {
  return {
    assignmentMode: "template",
    studentId: STUDENT_ID,
    templateId: TEMPLATE_ID,
    name: " Pacote de 10 aulas ",
    credits: "10",
    sportId: SPORT_ID,
    startsOn: "2026-08-10",
    expiresOn: "2026-09-10",
    paidAmountCents: "75,00",
    origin: "purchased",
    notes: "  Pago por transferência.  ",
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

describe("packageAssignmentFormSchema", () => {
  it("normaliza uma atribuição por modelo e converte o valor para cêntimos", () => {
    const parsed = packageAssignmentFormSchema.parse(form());

    expect(parsed).toMatchObject({
      assignmentMode: "template",
      studentId: STUDENT_ID,
      templateId: TEMPLATE_ID,
      name: "Pacote de 10 aulas",
      credits: 10,
      sportId: SPORT_ID,
      startsOn: "2026-08-10",
      expiresOn: "2026-09-10",
      paidAmountCents: 7500,
      origin: "purchased",
      notes: "Pago por transferência.",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("aceita pacote personalizado sem modelo, sem modalidade e sem validade", () => {
    const parsed = packageAssignmentFormSchema.parse(
      form({
        assignmentMode: "custom",
        templateId: "",
        sportId: "",
        expiresOn: "",
        paidAmountCents: "",
        origin: "manual",
      }),
    );

    expect(parsed.templateId).toBeNull();
    expect(parsed.sportId).toBeNull();
    expect(parsed.expiresOn).toBeNull();
    expect(parsed.paidAmountCents).toBeNull();
  });

  it.each(["3", "4", "8", "10", "12", "20"])(
    "aceita quantidade livre de %s aulas",
    (credits) => {
      expect(packageAssignmentFormSchema.safeParse(form({ credits })).success).toBe(true);
    },
  );

  it.each(["0", "-1", "2.5", "abc", "1001"])("rejeita quantidade inválida %s", (credits) => {
    expect(packageAssignmentFormSchema.safeParse(form({ credits })).success).toBe(false);
  });

  it("rejeita validade anterior ao início", () => {
    const parsed = packageAssignmentFormSchema.safeParse(form({ expiresOn: "2026-08-09" }));
    expect(parsed.success).toBe(false);
  });

  it("rejeita validade demasiado distante", () => {
    const parsed = packageAssignmentFormSchema.safeParse(form({ expiresOn: "2037-08-11" }));
    expect(parsed.success).toBe(false);
  });

  it("rejeita valor negativo e origem inválida", () => {
    expect(packageAssignmentFormSchema.safeParse(form({ paidAmountCents: "-1" })).success).toBe(false);
    expect(packageAssignmentFormSchema.safeParse(form({ origin: "checkout" })).success).toBe(false);
  });

  it("rejeita modelo ausente quando o modo usa modelo", () => {
    expect(packageAssignmentFormSchema.safeParse(form({ templateId: "" })).success).toBe(false);
  });

  it("rejeita modelo em pacote personalizado", () => {
    expect(
      packageAssignmentFormSchema.safeParse(form({ assignmentMode: "custom", templateId: TEMPLATE_ID }))
        .success,
    ).toBe(false);
  });

  it("rejeita campos adicionais e duplicados no FormData", () => {
    const data = new FormData();
    for (const [key, value] of Object.entries(form())) data.set(key, value);
    data.set("organization_id", "forged");
    data.append("credits", "20");

    expect(unexpectedPackageAssignmentFormFields(data)).toEqual(
      expect.arrayContaining(["organization_id", "credits"]),
    );
  });

  it("lê apenas os campos esperados do FormData", () => {
    const data = new FormData();
    for (const [key, value] of Object.entries(form())) data.set(key, value);

    expect(readPackageAssignmentFormData(data)).toMatchObject({
      studentId: STUDENT_ID,
      templateId: TEMPLATE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });
});
