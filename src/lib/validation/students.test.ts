import { describe, expect, it } from "vitest";

import {
  STUDENT_CREATE_FORM_FIELDS,
  readStudentCreateFormData,
  readStudentFilters,
  readStudentInvitationFormData,
  readStudentStatusFormData,
  readStudentUpdateFormData,
  studentCreateSchema,
  studentFiltersSchema,
  studentInvitationSchema,
  studentStatusSchema,
  studentUpdateSchema,
  unexpectedStudentFormFields,
} from "./students";

const STUDENT_ID = "44444444-4444-4444-8444-444444444444";

describe("studentFiltersSchema", () => {
  it("normaliza a pesquisa e aplica o estado por omissão", () => {
    expect(
      studentFiltersSchema.parse(readStudentFilters({ search: "  Ana   Silva  " })),
    ).toEqual({ search: "Ana Silva", status: "all" });
  });

  it("aceita todos os filtros funcionais e recusa valores desconhecidos", () => {
    for (const status of [
      "all",
      "active",
      "inactive",
      "linked",
      "unlinked",
      "prepared",
      "blocked",
    ]) {
      expect(studentFiltersSchema.safeParse({ search: "", status }).success).toBe(true);
    }

    expect(studentFiltersSchema.safeParse({ search: "", status: "deleted" }).success).toBe(false);
    expect(
      studentFiltersSchema.safeParse({ search: "A".repeat(121), status: "all" }).success,
    ).toBe(false);
  });
});

describe("studentCreateSchema", () => {
  it("normaliza contacto e campos opcionais", () => {
    expect(
      studentCreateSchema.parse({
        fullName: "  Ana   Martins ",
        email: " ANA@EXEMPLO.PT ",
        phone: "912 345 678",
        birthDate: "",
        skillLevel: "  Intermédio  ",
        notes: "  Prefere treinar de manhã.\r\nSem lesões.  ",
      }),
    ).toEqual({
      fullName: "Ana Martins",
      email: "ana@exemplo.pt",
      phone: "+351912345678",
      birthDate: null,
      skillLevel: "Intermédio",
      notes: "Prefere treinar de manhã.\nSem lesões.",
    });
  });

  it("aceita uma ficha sem conta, email ou telefone", () => {
    expect(
      studentCreateSchema.parse({
        fullName: "Marta Sousa",
        email: "",
        phone: "",
        birthDate: "",
        skillLevel: "",
        notes: "",
      }),
    ).toEqual({
      fullName: "Marta Sousa",
      email: null,
      phone: null,
      birthDate: null,
      skillLevel: null,
      notes: null,
    });
  });

  it("recusa contactos, datas e limites inválidos", () => {
    const valid = {
      fullName: "Marta Sousa",
      email: "marta@exemplo.pt",
      phone: "+351912345678",
      birthDate: "2000-02-29",
      skillLevel: "Iniciação",
      notes: "Observações",
    };

    expect(studentCreateSchema.safeParse({ ...valid, email: "marta@" }).success).toBe(false);
    expect(studentCreateSchema.safeParse({ ...valid, phone: "123" }).success).toBe(false);
    expect(studentCreateSchema.safeParse({ ...valid, birthDate: "2023-02-29" }).success).toBe(false);
    expect(studentCreateSchema.safeParse({ ...valid, birthDate: "2999-01-01" }).success).toBe(false);
    expect(studentCreateSchema.safeParse({ ...valid, notes: "A".repeat(2_001) }).success).toBe(false);
  });

  it("é estrito e recusa campos protegidos", () => {
    const parsed = studentCreateSchema.safeParse({
      fullName: "Ana Martins",
      email: "ana@exemplo.pt",
      phone: "",
      birthDate: "",
      skillLevel: "",
      notes: "",
      organizationId: "outra-organizacao",
      createdByTeacherId: STUDENT_ID,
      creditsAvailable: 999,
    });

    expect(parsed.success).toBe(false);
  });
});

describe("projeções seguras de FormData", () => {
  it("deteta campos extra, protegidos e valores duplicados", () => {
    const formData = new FormData();
    formData.set("fullName", "Ana Martins");
    formData.set("email", "ana@exemplo.pt");
    formData.set("phone", "");
    formData.set("birthDate", "");
    formData.set("skillLevel", "");
    formData.set("notes", "");
    formData.set("organizationId", "outra-organizacao");
    formData.set("role", "admin");
    formData.append("email", "segundo@exemplo.pt");
    formData.set("$ACTION_FAKE", "marcador interno");

    expect(unexpectedStudentFormFields(formData, STUDENT_CREATE_FORM_FIELDS).sort()).toEqual(
      ["email", "organizationId", "role"].sort(),
    );
    expect(readStudentCreateFormData(formData)).not.toHaveProperty("organizationId");
  });

  it("não projeta email na edição de uma ficha ligada quando o campo não existe", () => {
    const formData = new FormData();
    formData.set("studentId", STUDENT_ID);
    formData.set("fullName", "Ana Martins");
    formData.set("phone", "");
    formData.set("birthDate", "");
    formData.set("skillLevel", "");
    formData.set("notes", "");

    const raw = readStudentUpdateFormData(formData);
    expect(raw).not.toHaveProperty("email");
    expect(studentUpdateSchema.safeParse(raw).success).toBe(true);
  });
});

describe("operações de estado e ligação", () => {
  it("exige UUID e confirmação para alterar o estado", () => {
    const formData = new FormData();
    formData.set("studentId", STUDENT_ID);
    formData.set("status", "inactive");

    expect(studentStatusSchema.safeParse(readStudentStatusFormData(formData)).success).toBe(false);
    formData.set("confirmation", "on");
    expect(studentStatusSchema.safeParse(readStudentStatusFormData(formData)).success).toBe(true);
  });

  it("permite preparar sem fingir envio e exige confirmação para revogar", () => {
    const prepare = new FormData();
    prepare.set("studentId", STUDENT_ID);
    prepare.set("operation", "prepare");
    expect(studentInvitationSchema.safeParse(readStudentInvitationFormData(prepare)).success).toBe(true);

    const revoke = new FormData();
    revoke.set("studentId", STUDENT_ID);
    revoke.set("operation", "revoke");
    expect(studentInvitationSchema.safeParse(readStudentInvitationFormData(revoke)).success).toBe(false);
    revoke.set("confirmation", "on");
    expect(studentInvitationSchema.safeParse(readStudentInvitationFormData(revoke)).success).toBe(true);
  });
});
