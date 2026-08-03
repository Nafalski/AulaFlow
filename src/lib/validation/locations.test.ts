import { describe, expect, it } from "vitest";

import {
  locationFiltersSchema,
  locationFormSchema,
  locationStatusSchema,
  readLocationFormData,
  unexpectedLocationFormFields,
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
    expect(unexpectedLocationFormFields(formData, false)).toEqual([
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
