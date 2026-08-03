import { describe, expect, it } from "vitest";

import {
  groupFiltersSchema,
  groupFormSchema,
  groupMembershipSchema,
  groupStatusSchema,
  readGroupFormData,
  unexpectedGroupFormFields,
} from "./groups";

const SPORT_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const STUDENT_ID = "33333333-3333-4333-8333-333333333333";

describe("groupFormSchema", () => {
  it("normaliza texto, vazios e a quantidade máxima", () => {
    expect(
      groupFormSchema.parse({
        name: "  Iniciação   sábado ",
        sportId: SPORT_ID.toUpperCase(),
        description: "  Informação para os alunos.  ",
        administrativeNotes: "  Linha 1\r\nLinha 2  ",
        maxParticipants: "8",
      }),
    ).toEqual({
      name: "Iniciação sábado",
      sportId: SPORT_ID,
      description: "Informação para os alunos.",
      administrativeNotes: "Linha 1\nLinha 2",
      maxParticipants: 8,
    });

    expect(
      groupFormSchema.parse({
        name: "Turma livre",
        sportId: "",
        description: "",
        administrativeNotes: "",
        maxParticipants: "",
      }),
    ).toMatchObject({
      sportId: null,
      description: null,
      administrativeNotes: null,
      maxParticipants: null,
    });
  });

  it("valida nome, UUID, limites e inteiros", () => {
    expect(groupFormSchema.safeParse({ name: "A", sportId: "", maxParticipants: "" }).success).toBe(false);
    expect(groupFormSchema.safeParse({ name: "A".repeat(121), sportId: "", maxParticipants: "" }).success).toBe(false);
    expect(groupFormSchema.safeParse({ name: "Turma", sportId: "x", maxParticipants: "" }).success).toBe(false);
    expect(groupFormSchema.safeParse({ name: "Turma", sportId: "", maxParticipants: "0" }).success).toBe(false);
    expect(groupFormSchema.safeParse({ name: "Turma", sportId: "", maxParticipants: "51" }).success).toBe(false);
    expect(groupFormSchema.safeParse({ name: "Turma", sportId: "", maxParticipants: "1.5" }).success).toBe(false);
  });

  it("é estrito e o leitor sinaliza campos protegidos", () => {
    expect(
      groupFormSchema.safeParse({
        name: "Turma",
        sportId: null,
        description: null,
        administrativeNotes: null,
        maxParticipants: null,
        teacherId: SPORT_ID,
      }).success,
    ).toBe(false);

    const formData = new FormData();
    formData.set("name", "Turma");
    formData.set("organizationId", SPORT_ID);
    formData.set("teacherId", SPORT_ID);

    expect(readGroupFormData(formData)).toMatchObject({ name: "Turma" });
    expect(unexpectedGroupFormFields(formData, false)).toEqual([
      "organizationId",
      "teacherId",
    ]);
  });
});

describe("group filters and membership", () => {
  it("normaliza filtros e recusa estados desconhecidos", () => {
    expect(groupFiltersSchema.parse({ search: "  manhã ", status: "active" })).toEqual({
      search: "manhã",
      status: "active",
    });
    expect(groupFiltersSchema.safeParse({ search: "", status: "archived" }).success).toBe(false);
  });

  it("valida os dois identificadores da relação", () => {
    expect(
      groupMembershipSchema.parse({ groupId: GROUP_ID, studentId: STUDENT_ID, confirmed: true }),
    ).toEqual({ groupId: GROUP_ID, studentId: STUDENT_ID, confirmed: true });
    expect(
      groupMembershipSchema.safeParse({ groupId: GROUP_ID, studentId: "x", confirmed: true }).success,
    ).toBe(false);
    expect(
      groupStatusSchema.parse({ groupId: GROUP_ID, isActive: "false", confirmed: true }),
    ).toEqual({ groupId: GROUP_ID, isActive: false, confirmed: true });
    expect(
      groupStatusSchema.safeParse({ groupId: GROUP_ID, isActive: "arquivada", confirmed: true })
        .success,
    ).toBe(false);
  });
});
