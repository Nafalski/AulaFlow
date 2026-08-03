import { describe, expect, it } from "vitest";

import {
  packageCreditAdjustmentFormSchema,
  packageHistoryFiltersSchema,
  packageStartDateFormSchema,
  packageStatusActionFormSchema,
  packageTransactionCorrectionFormSchema,
  packageValidityFormSchema,
  readCreditAdjustmentFormData,
  readPackageHistoryFilters,
  readStatusActionFormData,
  unexpectedPackageAdminFields,
} from "./package-admin";

const PACKAGE_ID = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";

function creditForm(overrides: Partial<Record<string, string>> = {}) {
  return {
    packageId: PACKAGE_ID,
    quantity: "3",
    reason: "  Erro no lançamento anterior  ",
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

describe("packageCreditAdjustmentFormSchema", () => {
  it("normaliza ajuste de créditos com motivo e chave idempotente", () => {
    expect(packageCreditAdjustmentFormSchema.parse(creditForm())).toMatchObject({
      packageId: PACKAGE_ID,
      quantity: 3,
      reason: "Erro no lançamento anterior",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it.each(["0", "-1", "1.5", "abc", "1001"])("rejeita quantidade inválida %s", (quantity) => {
    expect(packageCreditAdjustmentFormSchema.safeParse(creditForm({ quantity })).success).toBe(false);
  });

  it("rejeita motivo curto e chave idempotente inválida", () => {
    expect(packageCreditAdjustmentFormSchema.safeParse(creditForm({ reason: "ok" })).success).toBe(false);
    expect(
      packageCreditAdjustmentFormSchema.safeParse(creditForm({ idempotencyKey: "not-a-uuid" })).success,
    ).toBe(false);
  });
});

describe("packageStatusActionFormSchema", () => {
  it("exige confirmação explícita para estado administrativo", () => {
    expect(
      packageStatusActionFormSchema.safeParse({
        packageId: PACKAGE_ID,
        reason: "Pausa solicitada pelo aluno",
        confirmed: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      }).success,
    ).toBe(false);
  });

  it("aceita ação confirmada com motivo", () => {
    expect(
      packageStatusActionFormSchema.safeParse({
        packageId: PACKAGE_ID,
        reason: "Pausa solicitada pelo aluno",
        confirmed: true,
        idempotencyKey: IDEMPOTENCY_KEY,
      }).success,
    ).toBe(true);
  });
});

describe("package date schemas", () => {
  it("aceita validade vazia para remover prazo", () => {
    const parsed = packageValidityFormSchema.parse({
      packageId: PACKAGE_ID,
      expiresOn: "",
      reason: "Condição sem prazo definida por acordo",
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(parsed.expiresOn).toBeNull();
  });

  it("rejeita data impossível", () => {
    expect(
      packageValidityFormSchema.safeParse({
        packageId: PACKAGE_ID,
        expiresOn: "2026-02-31",
        reason: "Correção da validade",
        idempotencyKey: IDEMPOTENCY_KEY,
      }).success,
    ).toBe(false);
  });

  it("exige confirmação para alterar a data de início", () => {
    expect(
      packageStartDateFormSchema.safeParse({
        packageId: PACKAGE_ID,
        startsOn: "2026-08-10",
        reason: "Aluno só começou na semana seguinte",
        confirmed: true,
        idempotencyKey: IDEMPOTENCY_KEY,
      }).success,
    ).toBe(true);
  });
});

describe("packageTransactionCorrectionFormSchema", () => {
  it("normaliza correção compensatória", () => {
    const parsed = packageTransactionCorrectionFormSchema.parse({
      packageId: PACKAGE_ID,
      transactionId: TRANSACTION_ID,
      direction: "remove",
      quantity: "2",
      reason: "Quantidade inicial foi lançada acima do combinado",
      confirmed: true,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(parsed).toMatchObject({ direction: "remove", quantity: 2 });
  });

  it("rejeita direção e confirmação inválidas", () => {
    expect(
      packageTransactionCorrectionFormSchema.safeParse({
        packageId: PACKAGE_ID,
        transactionId: TRANSACTION_ID,
        direction: "transfer",
        quantity: "2",
        reason: "Correção",
        confirmed: true,
        idempotencyKey: IDEMPOTENCY_KEY,
      }).success,
    ).toBe(false);

    expect(
      packageTransactionCorrectionFormSchema.safeParse({
        packageId: PACKAGE_ID,
        transactionId: TRANSACTION_ID,
        direction: "add",
        quantity: "2",
        reason: "Correção",
        confirmed: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      }).success,
    ).toBe(false);
  });
});

describe("packageHistoryFiltersSchema", () => {
  it("normaliza filtros de histórico", () => {
    const parsed = packageHistoryFiltersSchema.parse({
      search: "  Maria  Silva ",
      source: "admin",
      eventType: "package_suspended",
      responsible: " Professor ",
      from: "2026-08-01",
      to: "2026-08-31",
    });

    expect(parsed).toMatchObject({
      search: "Maria Silva",
      source: "admin",
      eventType: "package_suspended",
      responsible: "Professor",
    });
  });

  it("rejeita período invertido", () => {
    expect(
      packageHistoryFiltersSchema.safeParse({
        search: "",
        source: "all",
        eventType: "",
        responsible: "",
        from: "2026-08-31",
        to: "2026-08-01",
      }).success,
    ).toBe(false);
  });
});

describe("package admin FormData helpers", () => {
  it("lê apenas os campos de ajuste", () => {
    const data = new FormData();
    for (const [key, value] of Object.entries(creditForm())) data.set(key, value);

    expect(readCreditAdjustmentFormData(data)).toMatchObject({
      packageId: PACKAGE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("lê checkbox de confirmação como booleano", () => {
    const data = new FormData();
    data.set("packageId", PACKAGE_ID);
    data.set("reason", "Pausa temporária");
    data.set("confirmed", "on");
    data.set("idempotencyKey", IDEMPOTENCY_KEY);

    expect(readStatusActionFormData(data).confirmed).toBe(true);
  });

  it("rejeita campos extras e duplicados", () => {
    const data = new FormData();
    for (const [key, value] of Object.entries(creditForm())) data.set(key, value);
    data.set("credits_available", "999");
    data.append("quantity", "4");

    expect(unexpectedPackageAdminFields(data, ["packageId", "quantity", "reason", "idempotencyKey"])).toEqual(
      expect.arrayContaining(["credits_available", "quantity"]),
    );
  });

  it("lê filtros de URL sem aceitar arrays", () => {
    expect(
      readPackageHistoryFilters({
        search: "Maria",
        source: "credit",
        type: "credit_added_manually",
        responsible: ["não usado"],
      }),
    ).toMatchObject({
      search: "Maria",
      source: "credit",
      eventType: "credit_added_manually",
      responsible: undefined,
    });
  });
});
