import { describe, expect, it } from "vitest";

import {
  LOCATION_RESOURCE_CREATE_FIELDS,
  locationResourceCreateSchema,
  locationResourceStatusSchema,
  locationResourceUpdateSchema,
  readLocationResourceCreateFormData,
  unexpectedLocationResourceFields,
} from "./location-resources";

const LOCATION_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

describe("locationResourceCreateSchema", () => {
  it("normaliza o nome e assume valores por omissão", () => {
    expect(
      locationResourceCreateSchema.parse({
        locationId: LOCATION_ID,
        name: "  Campo   1 ",
        idempotencyKey: KEY,
      }),
    ).toEqual({
      locationId: LOCATION_ID,
      name: "Campo 1",
      kind: "court",
      displayOrder: 0,
      idempotencyKey: KEY,
    });
  });

  it("aceita ordem vazia como fim da lista", () => {
    expect(
      locationResourceCreateSchema.parse({
        locationId: LOCATION_ID,
        name: "Sala A",
        kind: "room",
        displayOrder: "",
        idempotencyKey: KEY,
      }),
    ).toMatchObject({ kind: "room", displayOrder: 0 });
  });

  it("converte a ordem enviada como texto", () => {
    expect(
      locationResourceCreateSchema.parse({
        locationId: LOCATION_ID,
        name: "Campo 2",
        displayOrder: "7",
        idempotencyKey: KEY,
      }),
    ).toMatchObject({ displayOrder: 7 });
  });

  it("recusa um nome vazio", () => {
    const result = locationResourceCreateSchema.safeParse({
      locationId: LOCATION_ID,
      name: "   ",
      idempotencyKey: KEY,
    });
    expect(result.success).toBe(false);
  });

  it("recusa um nome demasiado longo", () => {
    const result = locationResourceCreateSchema.safeParse({
      locationId: LOCATION_ID,
      name: "a".repeat(81),
      idempotencyKey: KEY,
    });
    expect(result.success).toBe(false);
  });

  it("recusa uma ordem fora dos limites da base", () => {
    for (const displayOrder of ["-1", "1000"]) {
      const result = locationResourceCreateSchema.safeParse({
        locationId: LOCATION_ID,
        name: "Campo 1",
        displayOrder,
        idempotencyKey: KEY,
      });
      expect(result.success).toBe(false);
    }
  });

  it("recusa uma ordem decimal", () => {
    const result = locationResourceCreateSchema.safeParse({
      locationId: LOCATION_ID,
      name: "Campo 1",
      displayOrder: "1.5",
      idempotencyKey: KEY,
    });
    expect(result.success).toBe(false);
  });

  it("recusa um tipo desconhecido", () => {
    const result = locationResourceCreateSchema.safeParse({
      locationId: LOCATION_ID,
      name: "Campo 1",
      kind: "beach_tennis",
      idempotencyKey: KEY,
    });
    expect(result.success).toBe(false);
  });

  it("exige a chave de idempotência", () => {
    const result = locationResourceCreateSchema.safeParse({
      locationId: LOCATION_ID,
      name: "Campo 1",
    });
    expect(result.success).toBe(false);
  });

  it("recusa campos que o servidor deriva", () => {
    for (const field of ["organizationId", "teacherId", "createdBy", "isActive", "visibility"]) {
      const result = locationResourceCreateSchema.safeParse({
        locationId: LOCATION_ID,
        name: "Campo 1",
        idempotencyKey: KEY,
        [field]: "qualquer coisa",
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("locationResourceUpdateSchema", () => {
  it("aceita o recurso e os campos editáveis", () => {
    expect(
      locationResourceUpdateSchema.parse({
        resourceId: RESOURCE_ID,
        name: " Campo Coberto ",
        kind: "area",
        displayOrder: "3",
      }),
    ).toEqual({
      resourceId: RESOURCE_ID,
      name: "Campo Coberto",
      kind: "area",
      displayOrder: 3,
    });
  });

  it("não aceita mudar de local pela edição", () => {
    const result = locationResourceUpdateSchema.safeParse({
      resourceId: RESOURCE_ID,
      name: "Campo Coberto",
      locationId: LOCATION_ID,
    });
    expect(result.success).toBe(false);
  });

  it("não aceita alterar o estado pela edição", () => {
    const result = locationResourceUpdateSchema.safeParse({
      resourceId: RESOURCE_ID,
      name: "Campo Coberto",
      isActive: "false",
    });
    expect(result.success).toBe(false);
  });
});

describe("locationResourceStatusSchema", () => {
  it("exige confirmação explícita", () => {
    expect(
      locationResourceStatusSchema.safeParse({
        resourceId: RESOURCE_ID,
        isActive: "false",
      }).success,
    ).toBe(false);

    expect(
      locationResourceStatusSchema.parse({
        resourceId: RESOURCE_ID,
        isActive: "false",
        confirmed: true,
      }),
    ).toEqual({ resourceId: RESOURCE_ID, isActive: false, confirmed: true });
  });

  it("recusa um estado que não seja booleano", () => {
    const result = locationResourceStatusSchema.safeParse({
      resourceId: RESOURCE_ID,
      isActive: "talvez",
      confirmed: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("leitura do FormData", () => {
  it("lê apenas os campos do contrato", () => {
    const formData = new FormData();
    formData.set("locationId", LOCATION_ID);
    formData.set("name", "Campo 1");
    formData.set("kind", "court");
    formData.set("displayOrder", "1");
    formData.set("idempotencyKey", KEY);

    expect(readLocationResourceCreateFormData(formData)).toEqual({
      locationId: LOCATION_ID,
      name: "Campo 1",
      kind: "court",
      displayOrder: "1",
      idempotencyKey: KEY,
    });
    expect(unexpectedLocationResourceFields(formData, LOCATION_RESOURCE_CREATE_FIELDS)).toEqual([]);
  });

  it("denuncia um campo forjado fora do browser", () => {
    const formData = new FormData();
    formData.set("locationId", LOCATION_ID);
    formData.set("name", "Campo 1");
    formData.set("idempotencyKey", KEY);
    formData.set("created_by", "outro-professor");

    expect(unexpectedLocationResourceFields(formData, LOCATION_RESOURCE_CREATE_FIELDS)).toEqual([
      "created_by",
    ]);
  });
});
