import { describe, expect, it } from "vitest";

import {
  accountProfileSchema,
  notificationPreferencesSchema,
  readAccountProfileFormData,
  readNotificationPreferencesFormData,
  readTeacherPublicProfileFormData,
  teacherPublicProfileSchema,
} from "./profile";

const SPORT_ONE = "11111111-1111-4111-8111-111111111111";
const SPORT_TWO = "22222222-2222-4222-8222-222222222222";

describe("accountProfileSchema", () => {
  it("normaliza o nome e aplica os valores por omissão do MVP", () => {
    const parsed = accountProfileSchema.parse({
      fullName: "  Ana   da\nSilva  ",
      phone: "",
    });

    expect(parsed).toEqual({
      fullName: "Ana da Silva",
      phone: null,
      locale: "pt-PT",
      timezone: "Europe/Lisbon",
      contactPreference: "email",
    });
  });

  it("aceita nomes entre 2 e 120 caracteres", () => {
    expect(accountProfileSchema.safeParse({ fullName: "A", phone: "" }).success).toBe(false);
    expect(accountProfileSchema.safeParse({ fullName: "A".repeat(121), phone: "" }).success).toBe(
      false,
    );
    expect(accountProfileSchema.safeParse({ fullName: "A".repeat(120), phone: "" }).success).toBe(
      true,
    );
  });

  it.each([
    ["912 345 678", "+351912345678"],
    ["351 912 345 678", "+351912345678"],
    ["00351 912 345 678", "+351912345678"],
    ["+34 612 345 678", "+34612345678"],
  ])("normaliza o telefone %s", (input, expected) => {
    const parsed = accountProfileSchema.parse({ fullName: "Ana Silva", phone: input });
    expect(parsed.phone).toBe(expected);
  });

  it("rejeita telefones inválidos", () => {
    const parsed = accountProfileSchema.safeParse({
      fullName: "Ana Silva",
      phone: "telefone",
    });
    expect(parsed.success).toBe(false);
  });

  it("exige telefone quando esse é o contacto preferencial", () => {
    const parsed = accountProfileSchema.safeParse({
      fullName: "Ana Silva",
      phone: "",
      contactPreference: "phone",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["phone"]);
      expect(parsed.error.issues[0]?.message).toContain("contacto preferencial");
    }
  });

  it("limita locale e timezone às opções suportadas", () => {
    expect(
      accountProfileSchema.safeParse({
        fullName: "Ana Silva",
        phone: "",
        locale: "en-US",
      }).success,
    ).toBe(false);

    expect(
      accountProfileSchema.safeParse({
        fullName: "Ana Silva",
        phone: "",
        timezone: "America/New_York",
      }).success,
    ).toBe(false);

    expect(
      accountProfileSchema.parse({
        fullName: "Ana Silva",
        phone: "",
        timezone: "Atlantic/Azores",
      }).timezone,
    ).toBe("Atlantic/Azores");
  });

  it("ignora campos protegidos através da projeção explícita de FormData", () => {
    const formData = new FormData();
    formData.set("fullName", " Ana Silva ");
    formData.set("phone", "912345678");
    formData.set("role", "admin");
    formData.set("organizationId", "outra-organizacao");
    formData.set("credits", "999");

    const raw = readAccountProfileFormData(formData);
    expect(raw).toEqual({
      fullName: " Ana Silva ",
      phone: "912345678",
      locale: undefined,
      timezone: undefined,
      contactPreference: undefined,
    });
    expect("role" in raw).toBe(false);
    expect("organizationId" in raw).toBe(false);
    expect(accountProfileSchema.parse(raw).fullName).toBe("Ana Silva");
  });
});

describe("teacherPublicProfileSchema", () => {
  it("normaliza texto e aceita várias modalidades únicas", () => {
    const parsed = teacherPublicProfileSchema.parse({
      publicName: "  Professora   Marta ",
      bio: "  Primeira linha\r\nSegunda linha  ",
      serviceArea: "  Lisboa   e Oeiras ",
      sportIds: [SPORT_ONE.toUpperCase(), SPORT_TWO],
    });

    expect(parsed).toEqual({
      publicName: "Professora Marta",
      bio: "Primeira linha\nSegunda linha",
      serviceArea: "Lisboa e Oeiras",
      sportIds: [SPORT_ONE, SPORT_TWO],
    });
  });

  it("exige pelo menos uma modalidade e rejeita duplicados", () => {
    expect(
      teacherPublicProfileSchema.safeParse({
        publicName: "Professora Marta",
        bio: "",
        serviceArea: "",
        sportIds: [],
      }).success,
    ).toBe(false);

    expect(
      teacherPublicProfileSchema.safeParse({
        publicName: "Professora Marta",
        bio: "",
        serviceArea: "",
        sportIds: [SPORT_ONE, SPORT_ONE.toUpperCase()],
      }).success,
    ).toBe(false);
  });

  it("aplica limites a nome público, apresentação e zona", () => {
    expect(
      teacherPublicProfileSchema.safeParse({
        publicName: "A".repeat(121),
        bio: "",
        serviceArea: "",
        sportIds: [SPORT_ONE],
      }).success,
    ).toBe(false);
    expect(
      teacherPublicProfileSchema.safeParse({
        publicName: "Professora Marta",
        bio: "A",
        serviceArea: "Lisboa",
        sportIds: [SPORT_ONE],
      }).success,
    ).toBe(false);
    expect(
      teacherPublicProfileSchema.safeParse({
        publicName: "Professora Marta",
        bio: "Apresentação",
        serviceArea: "A",
        sportIds: [SPORT_ONE],
      }).success,
    ).toBe(false);
    expect(
      teacherPublicProfileSchema.safeParse({
        publicName: "Professora Marta",
        bio: "A".repeat(1_001),
        serviceArea: "",
        sportIds: [SPORT_ONE],
      }).success,
    ).toBe(false);
    expect(
      teacherPublicProfileSchema.safeParse({
        publicName: "Professora Marta",
        bio: "",
        serviceArea: "A".repeat(161),
        sportIds: [SPORT_ONE],
      }).success,
    ).toBe(false);
  });

  it("lê apenas os campos públicos permitidos", () => {
    const formData = new FormData();
    formData.set("publicName", "Professora Marta");
    formData.set("bio", "Apresentação");
    formData.set("serviceArea", "Lisboa");
    formData.append("sportIds", SPORT_ONE);
    formData.append("sportIds", SPORT_TWO);
    formData.set("profileId", "não-permitido");
    formData.set("privateNotes", "segredo");

    const raw = readTeacherPublicProfileFormData(formData);
    expect(raw.sportIds).toEqual([SPORT_ONE, SPORT_TWO]);
    expect("profileId" in raw).toBe(false);
    expect("privateNotes" in raw).toBe(false);
    expect(teacherPublicProfileSchema.safeParse(raw).success).toBe(true);
  });
});

describe("notificationPreferencesSchema", () => {
  it("converte checkboxes presentes e ausentes em booleanos", () => {
    const formData = new FormData();
    formData.set("inAppEnabled", "on");
    formData.set("emailEnabled", "true");
    formData.set("lessonCreated", "1");
    formData.set("whatsappEnabled", "on");

    const raw = readNotificationPreferencesFormData(formData);
    expect(raw).toEqual({
      inAppEnabled: true,
      emailEnabled: true,
      lessonCreated: true,
      lessonUpdated: false,
      lessonCancelled: false,
      lessonRescheduled: false,
      participantChanged: false,
      reminder24h: false,
      reminder2h: false,
    });
    expect("whatsappEnabled" in raw).toBe(false);
    expect(notificationPreferencesSchema.safeParse(raw).success).toBe(true);
  });
});
