import { describe, expect, it } from "vitest";

import {
  availabilityExceptionSchema,
  availabilityPreferencesSchema,
  availabilityRuleSchema,
  readScheduleBlockFormData,
  scheduleBlockSchema,
  unexpectedAvailabilityFields,
} from "./availability";

const ID = "11111111-1111-4111-8111-111111111111";

describe("availability validation", () => {
  it("normaliza preferências de duração e intervalo mínimo", () => {
    expect(
      availabilityPreferencesSchema.parse({
        defaultLessonDurationMinutes: "60",
        minimumBreakMinutes: "15",
      }),
    ).toEqual({
      defaultLessonDurationMinutes: 60,
      minimumBreakMinutes: 15,
    });

    expect(
      availabilityPreferencesSchema.safeParse({
        defaultLessonDurationMinutes: "10",
        minimumBreakMinutes: "15",
      }).success,
    ).toBe(false);
    expect(
      availabilityPreferencesSchema.safeParse({
        defaultLessonDurationMinutes: "60",
        minimumBreakMinutes: "12",
      }).success,
    ).toBe(false);
  });

  it("valida períodos semanais em hora civil local", () => {
    expect(
      availabilityRuleSchema.parse({
        ruleId: "",
        weekday: "1",
        startsAt: "09:15",
        endsAt: "13:45",
        locationId: "",
        idempotencyKey: ID,
      }),
    ).toMatchObject({
      ruleId: null,
      weekday: 1,
      startsAt: "09:15",
      endsAt: "13:45",
      locationId: null,
    });

    expect(
      availabilityRuleSchema.safeParse({
        ruleId: "",
        weekday: "1",
        startsAt: "13:00",
        endsAt: "13:00",
        locationId: "",
        idempotencyKey: ID,
      }).success,
    ).toBe(false);
  });

  it("valida exceções por data específica", () => {
    expect(
      availabilityExceptionSchema.parse({
        exceptionId: "",
        exceptionDate: "2026-08-15",
        mode: "add",
        startsAt: "10:00",
        endsAt: "12:00",
        locationId: "",
        notes: "  Sábado   especial ",
        idempotencyKey: ID,
      }),
    ).toMatchObject({
      exceptionId: null,
      exceptionDate: "2026-08-15",
      mode: "add",
      notes: "Sábado   especial",
    });

    expect(
      availabilityExceptionSchema.safeParse({
        exceptionId: "",
        exceptionDate: "2026-02-30",
        mode: "replace",
        startsAt: "10:00",
        endsAt: "12:00",
        locationId: "",
        notes: "",
        idempotencyKey: ID,
      }).success,
    ).toBe(false);
  });

  it("valida bloqueios parciais e de dia inteiro", () => {
    expect(
      scheduleBlockSchema.safeParse({
        blockId: "",
        startsOn: "2026-08-10",
        startsAt: "14:00",
        endsOn: "2026-08-10",
        endsAt: "17:00",
        allDay: false,
        reason: "Compromisso pessoal",
        category: "personal",
        locationId: "",
        idempotencyKey: ID,
      }).success,
    ).toBe(true);

    expect(
      scheduleBlockSchema.safeParse({
        blockId: "",
        startsOn: "2026-08-15",
        startsAt: "09:00",
        endsOn: "2026-08-20",
        endsAt: "17:00",
        allDay: true,
        reason: "Férias de verão",
        category: "vacation",
        locationId: "",
        idempotencyKey: ID,
      }).success,
    ).toBe(true);

    expect(
      scheduleBlockSchema.safeParse({
        blockId: "",
        startsOn: "2026-08-10",
        startsAt: "17:00",
        endsOn: "2026-08-10",
        endsAt: "14:00",
        allDay: false,
        reason: "Compromisso pessoal",
        category: "personal",
        locationId: "",
        idempotencyKey: ID,
      }).success,
    ).toBe(false);
  });

  it("lê apenas campos permitidos do formulário de bloqueio", () => {
    const formData = new FormData();
    formData.set("startsOn", "2026-08-10");
    formData.set("startsAt", "14:00");
    formData.set("endsOn", "2026-08-10");
    formData.set("endsAt", "17:00");
    formData.set("reason", "Compromisso pessoal");
    formData.set("category", "personal");
    formData.set("locationId", "");
    formData.set("idempotencyKey", ID);
    formData.set("teacherId", "forjado");
    formData.set("organizationId", "forjado");

    expect(readScheduleBlockFormData(formData)).toMatchObject({
      startsOn: "2026-08-10",
      allDay: false,
      reason: "Compromisso pessoal",
    });
    expect(
      unexpectedAvailabilityFields(formData, [
        "blockId",
        "startsOn",
        "startsAt",
        "endsOn",
        "endsAt",
        "allDay",
        "reason",
        "category",
        "locationId",
        "idempotencyKey",
      ]),
    ).toEqual(["teacherId", "organizationId"]);
  });
});
