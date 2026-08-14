import { describe, expect, it } from "vitest";

import {
  LESSON_CREATE_FIELDS,
  LESSON_ATTENDANCE_FIELDS,
  LESSON_CANCEL_FIELDS,
  LESSON_COMPLETE_FIELDS,
  LESSON_PARTICIPANT_CANCEL_FIELDS,
  lessonCancelSchema,
  lessonCreateSchema,
  lessonAttendanceSchema,
  lessonCompleteSchema,
  lessonIdSchema,
  lessonParticipantCancelSchema,
  lessonUpdateSchema,
  readLessonAttendanceFormData,
  readLessonCancelFormData,
  readLessonCompleteFormData,
  readLessonCreateFormData,
  readLessonParticipantCancelFormData,
  unexpectedLessonFields,
} from "./lessons";

const SPORT = "11111111-1111-4111-8111-111111111111";
const STUDENT = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const LOCATION = "44444444-4444-4444-8444-444444444444";
const RESOURCE = "55555555-5555-4555-8555-555555555555";
const CLUB = "66666666-6666-4666-8666-666666666666";
const LESSON = "77777777-7777-4777-8777-777777777777";
const KEY = "88888888-8888-4888-8888-888888888888";
const PARTICIPANT = "99999999-9999-4999-8999-999999999999";

const base = {
  sportId: SPORT,
  date: "2026-08-24",
  time: "18:00",
  durationMinutes: "60",
  title: "Beach Tennis · Ana",
  mode: "student",
  studentId: STUDENT,
  idempotencyKey: KEY,
};

describe("lessonCreateSchema", () => {
  it("normaliza e assume o contexto pessoal", () => {
    expect(lessonCreateSchema.parse(base)).toEqual({
      sportId: SPORT,
      date: "2026-08-24",
      time: "18:00",
      durationMinutes: 60,
      title: "Beach Tennis · Ana",
      contextKind: "personal",
      clubOrganizationId: null,
      mode: "student",
      studentId: STUDENT,
      groupId: null,
      locationId: null,
      locationResourceId: null,
      notesForStudents: null,
      privateNotes: null,
      idempotencyKey: KEY,
      recurrenceMode: "none",
      recurrenceCount: null,
    });
  });

  it("colapsa espaços do título", () => {
    expect(lessonCreateSchema.parse({ ...base, title: "  Aula   de   teste " })).toMatchObject({
      title: "Aula de teste",
    });
  });

  // ── XOR aluno/turma ───────────────────────────────────────────────────────

  it("aceita uma aula de turma", () => {
    expect(
      lessonCreateSchema.parse({ ...base, mode: "group", studentId: "", groupId: GROUP }),
    ).toMatchObject({ mode: "group", groupId: GROUP, studentId: null });
  });

  it("recusa aluno e turma ao mesmo tempo", () => {
    const result = lessonCreateSchema.safeParse({ ...base, groupId: GROUP });
    expect(result.success).toBe(false);
  });

  it("recusa o modo aluno sem aluno", () => {
    const result = lessonCreateSchema.safeParse({ ...base, studentId: "" });
    expect(result.success).toBe(false);
  });

  it("recusa o modo turma sem turma", () => {
    const result = lessonCreateSchema.safeParse({ ...base, mode: "group", studentId: "" });
    expect(result.success).toBe(false);
  });

  it("recusa um modo desconhecido", () => {
    expect(lessonCreateSchema.safeParse({ ...base, mode: "toda-a-gente" }).success).toBe(false);
  });

  // ── Contexto ──────────────────────────────────────────────────────────────

  it("aceita uma aula de clube com clube", () => {
    expect(
      lessonCreateSchema.parse({ ...base, contextKind: "club", clubOrganizationId: CLUB }),
    ).toMatchObject({ contextKind: "club", clubOrganizationId: CLUB });
  });

  it("recusa uma aula de clube sem clube", () => {
    expect(lessonCreateSchema.safeParse({ ...base, contextKind: "club" }).success).toBe(false);
  });

  it("recusa uma aula pessoal com clube", () => {
    const result = lessonCreateSchema.safeParse({ ...base, clubOrganizationId: CLUB });
    expect(result.success).toBe(false);
  });

  // ── Data, hora e duração ──────────────────────────────────────────────────

  it("recusa datas e horas malformadas", () => {
    for (const bad of ["24-08-2026", "2026/08/24", "2026-8-4", ""]) {
      expect(lessonCreateSchema.safeParse({ ...base, date: bad }).success).toBe(false);
    }
    for (const bad of ["18h", "25:00", "18:60", "8:00", ""]) {
      expect(lessonCreateSchema.safeParse({ ...base, time: bad }).success).toBe(false);
    }
  });

  it("aceita as fronteiras de hora válidas", () => {
    expect(lessonCreateSchema.safeParse({ ...base, time: "00:00" }).success).toBe(true);
    expect(lessonCreateSchema.safeParse({ ...base, time: "23:59" }).success).toBe(true);
  });

  it("recusa durações fora dos limites da base", () => {
    for (const bad of ["0", "9", "721", "-30", "60.5", "sessenta"]) {
      expect(lessonCreateSchema.safeParse({ ...base, durationMinutes: bad }).success).toBe(false);
    }
  });

  it("aceita as durações extremas", () => {
    expect(lessonCreateSchema.safeParse({ ...base, durationMinutes: "10" }).success).toBe(true);
    expect(lessonCreateSchema.safeParse({ ...base, durationMinutes: "720" }).success).toBe(true);
  });

  // ── Local e recurso ───────────────────────────────────────────────────────

  it("aceita local com campo", () => {
    expect(
      lessonCreateSchema.parse({ ...base, locationId: LOCATION, locationResourceId: RESOURCE }),
    ).toMatchObject({ locationId: LOCATION, locationResourceId: RESOURCE });
  });

  it("recusa campo sem local", () => {
    const result = lessonCreateSchema.safeParse({ ...base, locationResourceId: RESOURCE });
    expect(result.success).toBe(false);
  });

  it("aceita uma aula sem local", () => {
    expect(lessonCreateSchema.parse(base).locationId).toBeNull();
  });

  // ── Campos que o servidor deriva ──────────────────────────────────────────

  it("recusa campos derivados da sessão", () => {
    for (const field of [
      "teacherId",
      "organizationId",
      "createdBy",
      "status",
      "creditCost",
      "maxParticipants",
      "isRecurring",
    ]) {
      const result = lessonCreateSchema.safeParse({ ...base, [field]: "forjado" });
      expect(result.success).toBe(false);
    }
  });

  it("exige a chave de idempotência", () => {
    const withoutKey = { ...base, idempotencyKey: "" };
    expect(lessonCreateSchema.safeParse(withoutKey).success).toBe(false);
  });

  // ── Recorrência ──────────────────────────────────────────────────────────

  it("aceita uma série semanal entre 2 e 12 aulas", () => {
    expect(
      lessonCreateSchema.parse({
        ...base,
        recurrenceMode: "weekly",
        recurrenceCount: "8",
      }),
    ).toMatchObject({
      recurrenceMode: "weekly",
      recurrenceCount: 8,
    });
  });

  it("recusa repetição semanal sem quantidade", () => {
    expect(
      lessonCreateSchema.safeParse({ ...base, recurrenceMode: "weekly" }).success,
    ).toBe(false);
  });

  it("recusa séries semanais fora dos limites", () => {
    for (const bad of ["1", "13", "2.5", "muitas"]) {
      expect(
        lessonCreateSchema.safeParse({
          ...base,
          recurrenceMode: "weekly",
          recurrenceCount: bad,
        }).success,
      ).toBe(false);
    }
  });

  it("recusa quantidade de recorrência quando a aula não se repete", () => {
    expect(lessonCreateSchema.safeParse({ ...base, recurrenceCount: "4" }).success).toBe(false);
  });

  it("recusa identificadores que não são UUID", () => {
    expect(lessonCreateSchema.safeParse({ ...base, studentId: "ana" }).success).toBe(false);
    expect(lessonCreateSchema.safeParse({ ...base, sportId: "beach" }).success).toBe(false);
  });
});

describe("lessonUpdateSchema", () => {
  const update = {
    lessonId: LESSON,
    date: "2026-08-24",
    time: "19:00",
    durationMinutes: "90",
    title: "Aula reagendada",
  };

  it("aceita os campos editáveis", () => {
    expect(lessonUpdateSchema.parse(update)).toEqual({
      lessonId: LESSON,
      date: "2026-08-24",
      time: "19:00",
      durationMinutes: 90,
      title: "Aula reagendada",
      locationId: null,
      locationResourceId: null,
      notesForStudents: null,
      privateNotes: null,
    });
  });

  it("não aceita trocar o participante pela edição", () => {
    for (const field of ["studentId", "groupId", "mode"]) {
      expect(lessonUpdateSchema.safeParse({ ...update, [field]: STUDENT }).success).toBe(false);
    }
  });

  it("não aceita mudar contexto, modalidade nem estado pela edição", () => {
    for (const field of ["contextKind", "clubOrganizationId", "sportId", "status"]) {
      expect(lessonUpdateSchema.safeParse({ ...update, [field]: "club" }).success).toBe(false);
    }
  });

  it("mantém a exigência de local para o campo", () => {
    expect(
      lessonUpdateSchema.safeParse({ ...update, locationResourceId: RESOURCE }).success,
    ).toBe(false);
  });
});

describe("lessonIdSchema", () => {
  it("aceita um identificador válido e recusa lixo", () => {
    expect(lessonIdSchema.parse({ lessonId: LESSON })).toEqual({ lessonId: LESSON });
    expect(lessonIdSchema.safeParse({ lessonId: "aula-1" }).success).toBe(false);
  });
});

describe("lessonAttendanceSchema", () => {
  it("aceita presente, falta e não confirmado", () => {
    expect(
      lessonAttendanceSchema.parse({
        lessonId: LESSON,
        participantId: PARTICIPANT,
        attendanceStatus: "present",
      }),
    ).toEqual({ lessonId: LESSON, participantId: PARTICIPANT, attendanceStatus: "present" });
    expect(
      lessonAttendanceSchema.parse({
        lessonId: LESSON,
        participantId: PARTICIPANT,
        attendanceStatus: "absent",
      }),
    ).toEqual({ lessonId: LESSON, participantId: PARTICIPANT, attendanceStatus: "absent" });
    expect(
      lessonAttendanceSchema.parse({
        lessonId: LESSON,
        participantId: PARTICIPANT,
        attendanceStatus: "unconfirmed",
      }),
    ).toEqual({ lessonId: LESSON, participantId: PARTICIPANT, attendanceStatus: null });
  });

  it("recusa participantes e estados forjados", () => {
    expect(
      lessonAttendanceSchema.safeParse({
        lessonId: LESSON,
        participantId: "participante",
        attendanceStatus: "present",
      }).success,
    ).toBe(false);
    expect(
      lessonAttendanceSchema.safeParse({
        lessonId: LESSON,
        participantId: PARTICIPANT,
        attendanceStatus: "late",
      }).success,
    ).toBe(false);
  });
});

describe("lessonCompleteSchema", () => {
  it("aceita apenas o identificador da aula", () => {
    expect(lessonCompleteSchema.parse({ lessonId: LESSON })).toEqual({ lessonId: LESSON });
    expect(lessonCompleteSchema.safeParse({ lessonId: "aula-1" }).success).toBe(false);
  });
});

describe("lessonCancelSchema", () => {
  it("aceita apenas o identificador da aula", () => {
    expect(lessonCancelSchema.parse({ lessonId: LESSON })).toEqual({ lessonId: LESSON });
    expect(lessonCancelSchema.safeParse({ lessonId: "aula-1" }).success).toBe(false);
  });
});

describe("lessonParticipantCancelSchema", () => {
  it("aceita apenas aula e participante", () => {
    expect(
      lessonParticipantCancelSchema.parse({ lessonId: LESSON, participantId: PARTICIPANT }),
    ).toEqual({ lessonId: LESSON, participantId: PARTICIPANT });
    expect(
      lessonParticipantCancelSchema.safeParse({
        lessonId: LESSON,
        participantId: PARTICIPANT,
        credits: "10",
      }).success,
    ).toBe(false);
  });
});

describe("leitura do FormData", () => {
  it("lê apenas os campos do contrato", () => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(base)) formData.set(key, String(value));

    expect(readLessonCreateFormData(formData)).toMatchObject({
      sportId: SPORT,
      studentId: STUDENT,
      mode: "student",
    });
    expect(unexpectedLessonFields(formData, LESSON_CREATE_FIELDS)).toEqual([]);
  });

  it("denuncia um campo forjado fora do browser", () => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(base)) formData.set(key, String(value));
    formData.set("teacher_id", "outro-professor");

    expect(unexpectedLessonFields(formData, LESSON_CREATE_FIELDS)).toEqual(["teacher_id"]);
  });

  it("lê presença apenas pelo contrato seguro", () => {
    const formData = new FormData();
    formData.set("lessonId", LESSON);
    formData.set("participantId", PARTICIPANT);
    formData.set("attendanceStatus", "absent");
    formData.set("studentPackageId", "forjado");

    expect(readLessonAttendanceFormData(formData)).toEqual({
      lessonId: LESSON,
      participantId: PARTICIPANT,
      attendanceStatus: "absent",
    });
    expect(unexpectedLessonFields(formData, LESSON_ATTENDANCE_FIELDS)).toEqual([
      "studentPackageId",
    ]);
  });

  it("lê conclusão sem aceitar campos financeiros do browser", () => {
    const formData = new FormData();
    formData.set("lessonId", LESSON);
    formData.set("studentPackageId", "forjado");
    formData.set("creditsConsumed", "99");

    expect(readLessonCompleteFormData(formData)).toEqual({ lessonId: LESSON });
    expect(unexpectedLessonFields(formData, LESSON_COMPLETE_FIELDS)).toEqual([
      "studentPackageId",
      "creditsConsumed",
    ]);
  });

  it("lê cancelamento de aula sem aceitar estado ou créditos do browser", () => {
    const formData = new FormData();
    formData.set("lessonId", LESSON);
    formData.set("status", "cancelled_by_teacher");
    formData.set("creditsReleased", "99");

    expect(readLessonCancelFormData(formData)).toEqual({ lessonId: LESSON });
    expect(unexpectedLessonFields(formData, LESSON_CANCEL_FIELDS)).toEqual([
      "status",
      "creditsReleased",
    ]);
  });

  it("lê cancelamento de participação sem aceitar pacote ou quantidade", () => {
    const formData = new FormData();
    formData.set("lessonId", LESSON);
    formData.set("participantId", PARTICIPANT);
    formData.set("studentPackageId", "forjado");
    formData.set("credits", "99");

    expect(readLessonParticipantCancelFormData(formData)).toEqual({
      lessonId: LESSON,
      participantId: PARTICIPANT,
    });
    expect(unexpectedLessonFields(formData, LESSON_PARTICIPANT_CANCEL_FIELDS)).toEqual([
      "studentPackageId",
      "credits",
    ]);
  });
});
