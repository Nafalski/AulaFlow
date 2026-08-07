import { describe, expect, it } from "vitest";

import {
  LOCATION_FORM_FIELDS,
  locationCreateSchema,
  locationModerationSchema,
  locationFiltersSchema,
  locationFormSchema,
  locationStatusSchema,
  readLocationFormData,
  unexpectedLocationFields,
} from "./locations";

describe("locationFormSchema", () => {
  it("normaliza os dados e transforma vazios em null", () => {
    expect(
      locationFormSchema.parse({
        name: "  Clube   Praia ",
        address: "  Rua   do Mar 1 ",
        city: "  Costa   da Caparica ",
        internalReference: "  Campo   B ",
        notes: "  Entrada lateral\r\nPedir chave.  ",
      }),
    ).toEqual({
      name: "Clube Praia",
      country: null,
      postalCode: null,
      address: "Rua do Mar 1",
      city: "Costa da Caparica",
      internalReference: "Campo B",
      notes: "Entrada lateral\nPedir chave.",
    });

    expect(
      locationFormSchema.parse({
        name: "Clube Praia",
        address: "",
        city: "",
        internalReference: "",
        notes: "",
      }),
    ).toMatchObject({ address: null, city: null, internalReference: null, notes: null });
  });

  it("aplica limites de comprimento", () => {
    expect(locationFormSchema.safeParse({ name: "A" }).success).toBe(false);
    expect(locationFormSchema.safeParse({ name: "A".repeat(121) }).success).toBe(false);
    expect(locationFormSchema.safeParse({ name: "Local", address: "A".repeat(241) }).success).toBe(false);
    expect(locationFormSchema.safeParse({ name: "Local", city: "A".repeat(121) }).success).toBe(false);
    expect(locationFormSchema.safeParse({ name: "Local", internalReference: "A".repeat(81) }).success).toBe(false);
    expect(locationFormSchema.safeParse({ name: "Local", notes: "A".repeat(2_001) }).success).toBe(false);
  });

  it("recusa propriedades extra e deteta campos de proprietário forjados", () => {
    expect(locationFormSchema.safeParse({ name: "Local", organizationId: "x" }).success).toBe(false);

    const formData = new FormData();
    formData.set("name", "Local");
    formData.set("organizationId", "outra");
    formData.set("teacherId", "outro");
    formData.set("isActive", "false");

    expect(readLocationFormData(formData).name).toBe("Local");
    expect(unexpectedLocationFields(formData, LOCATION_FORM_FIELDS)).toEqual([
      "organizationId",
      "teacherId",
      "isActive",
    ]);
  });
});

describe("locationFiltersSchema", () => {
  it("normaliza a pesquisa e limita o estado", () => {
    expect(locationFiltersSchema.parse({ search: "  campo   azul ", status: "inactive" })).toEqual({
      search: "campo azul",
      status: "inactive",
      scope: "all",
    });
    expect(locationFiltersSchema.safeParse({ search: "", status: "deleted" }).success).toBe(false);
    expect(
      locationStatusSchema.parse({
        locationId: "44444444-4444-4444-8444-444444444444",
        isActive: "true",
        confirmed: true,
      }),
    ).toMatchObject({ isActive: true });
    expect(
      locationStatusSchema.safeParse({
        locationId: "44444444-4444-4444-8444-444444444444",
        isActive: "apagado",
        confirmed: true,
      }).success,
    ).toBe(false);
  });
});

describe("locationCreateSchema", () => {
  const KEY = "11111111-1111-4111-8111-111111111111";
  const CLUB = "22222222-2222-4222-8222-222222222222";

  it("aceita um local privado sem clube", () => {
    const parsed = locationCreateSchema.parse({
      name: "Campo A",
      visibility: "private",
      organizationId: "",
      idempotencyKey: KEY,
    });
    expect(parsed.visibility).toBe("private");
    expect(parsed.organizationId).toBeNull();
  });

  it("exige clube quando a visibilidade é «do clube»", () => {
    expect(
      locationCreateSchema.safeParse({
        name: "Campo A",
        visibility: "club",
        organizationId: "",
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);

    expect(
      locationCreateSchema.safeParse({
        name: "Campo A",
        visibility: "club",
        organizationId: CLUB,
        idempotencyKey: KEY,
      }).success,
    ).toBe(true);
  });

  it("exige chave de idempotência válida", () => {
    expect(
      locationCreateSchema.safeParse({ name: "Campo A", visibility: "private", idempotencyKey: "x" })
        .success,
    ).toBe(false);
  });

  it("recusa visibilidades inventadas", () => {
    expect(
      locationCreateSchema.safeParse({
        name: "Campo A",
        visibility: "secreto",
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);
  });

  // Autoria, moderação e proprietário são derivados no servidor.
  it("recusa campos protegidos vindos do formulário", () => {
    for (const extra of [
      { createdBy: KEY },
      { teacherId: KEY },
      { moderationStatus: "approved" },
      { moderatedBy: KEY },
      { addressSource: "google" },
      { isActive: "true" },
    ]) {
      expect(
        locationCreateSchema.safeParse({
          name: "Campo A",
          visibility: "private",
          idempotencyKey: KEY,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
});

describe("locationModerationSchema", () => {
  const ID = "33333333-3333-4333-8333-333333333333";

  it("aprova sem motivo", () => {
    expect(
      locationModerationSchema.safeParse({ locationId: ID, decision: "approved", confirmed: true })
        .success,
    ).toBe(true);
  });

  it("exige motivo ao rejeitar", () => {
    expect(
      locationModerationSchema.safeParse({
        locationId: ID,
        decision: "rejected",
        reason: "",
        confirmed: true,
      }).success,
    ).toBe(false);

    expect(
      locationModerationSchema.safeParse({
        locationId: ID,
        decision: "rejected",
        reason: "Morada insuficiente",
        confirmed: true,
      }).success,
    ).toBe(true);
  });

  it("exige confirmação explícita", () => {
    expect(
      locationModerationSchema.safeParse({ locationId: ID, decision: "approved", confirmed: false })
        .success,
    ).toBe(false);
  });

  it("só aceita aprovar ou rejeitar", () => {
    for (const decision of ["pending", "not_required", "verified"]) {
      expect(
        locationModerationSchema.safeParse({ locationId: ID, decision, confirmed: true }).success,
      ).toBe(false);
    }
  });
});
