import { describe, expect, it } from "vitest";

import {
  cancellationPolicySchema,
  readCancellationPolicyFormData,
  unexpectedCancellationPolicyFields,
} from "./cancellation-policies";

const VALID = {
  name: "Política do professor",
  minHoursBeforeCancel: "24",
  lateCancellation: "charge",
  studentNoShow: "teacher_decides",
  allowManualExceptions: true,
  isActive: true,
};

describe("cancellationPolicySchema", () => {
  it("normaliza nome e prazo em horas", () => {
    expect(
      cancellationPolicySchema.parse({
        ...VALID,
        name: "  Regra   principal ",
        minHoursBeforeCancel: "48",
      }),
    ).toEqual({ ...VALID, name: "Regra principal", minHoursBeforeCancel: 48 });
  });

  it("aceita apenas as três decisões suportadas", () => {
    for (const rule of ["charge", "refund", "teacher_decides"]) {
      expect(
        cancellationPolicySchema.safeParse({ ...VALID, lateCancellation: rule }).success,
      ).toBe(true);
    }

    expect(
      cancellationPolicySchema.safeParse({ ...VALID, lateCancellation: "ignore" }).success,
    ).toBe(false);
  });

  it("recusa nomes e prazos inválidos", () => {
    expect(cancellationPolicySchema.safeParse({ ...VALID, name: "A" }).success).toBe(false);
    expect(cancellationPolicySchema.safeParse({ ...VALID, name: "A".repeat(121) }).success).toBe(false);
    expect(cancellationPolicySchema.safeParse({ ...VALID, minHoursBeforeCancel: "-1" }).success).toBe(false);
    expect(cancellationPolicySchema.safeParse({ ...VALID, minHoursBeforeCancel: "337" }).success).toBe(false);
    expect(cancellationPolicySchema.safeParse({ ...VALID, minHoursBeforeCancel: "1.5" }).success).toBe(false);
  });

  it("não torna configurável o desfecho provocado pelo professor", () => {
    expect(
      cancellationPolicySchema.safeParse({ ...VALID, teacherCancellation: "charge" }).success,
    ).toBe(false);

    const formData = new FormData();
    formData.set("name", VALID.name);
    formData.set("minHoursBeforeCancel", "24");
    formData.set("lateCancellation", "charge");
    formData.set("studentNoShow", "refund");
    formData.set("allowManualExceptions", "on");
    formData.set("isActive", "on");
    formData.set("teacherCancellation", "charge");
    formData.set("organizationId", "outra");

    expect(readCancellationPolicyFormData(formData)).toEqual({
      name: VALID.name,
      minHoursBeforeCancel: "24",
      lateCancellation: "charge",
      studentNoShow: "refund",
      allowManualExceptions: true,
      isActive: true,
    });
    expect(unexpectedCancellationPolicyFields(formData)).toEqual([
      "teacherCancellation",
      "organizationId",
    ]);
  });
});
