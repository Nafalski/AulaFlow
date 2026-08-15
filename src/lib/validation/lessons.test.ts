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
  LESSON_RESCHEDULE_FIELDS,
  LESSON_CONFIRM_PARTICIPATION_FIELDS,
  lessonConfirmParticipationSchema,
  lessonRescheduleSchema,
  lessonUpdateSchema,
  readLessonAttendanceFormData,
  readLessonCancelFormData,
  readLessonCompleteFormData,
  readLessonCreateFormData,
  readLessonParticipantCancelFormData,
  readLessonRescheduleFormData,
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
  requiresConfirmation: false,
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
      requiresConfirmation: false,
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
    title: "Aula com novo título",
  };

  it("aceita apenas conteúdo", () => {
    expect(lessonUpdateSchema.parse(update)).toEqual({
      lessonId: LESSON,
      title: "Aula com novo título",
      notesForStudents: null,
      privateNotes: null,
    });
  });

  it("aceita as observações", () => {
    expect(
      lessonUpdateSchema.parse({
        ...update,
        notesForStudents: "Trazer duas raquetes",
        privateNotes: "Rever o serviço",
      }),
    ).toEqual({
      lessonId: LESSON,
      title: "Aula com novo título",
      notesForStudents: "Trazer duas raquetes",
      privateNotes: "Rever o serviço",
    });
  });

  // A fronteira da 6C.2: mover a aula é reagendar, e reagendar tem contrato
  // próprio. A edição nem sequer aceita os campos de colocação.
  it("não aceita mudar horário, duração, local nem campo", () => {
    for (const field of [
      "date",
      "time",
      "durationMinutes",
      "locationId",
      "locationResourceId",
    ]) {
      expect(lessonUpdateSchema.safeParse({ ...update, [field]: "2026-08-24" }).success).toBe(
        false,
      );
    }
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
});

describe("lessonCreateSchema · pedido de confirmação", () => {
  it("aceita pedir e não pedir confirmação", () => {
    expect(lessonCreateSchema.parse({ ...base, requiresConfirmation: true }).requiresConfirmation).toBe(
      true,
    );
    expect(
      lessonCreateSchema.parse({ ...base, requiresConfirmation: false }).requiresConfirmation,
    ).toBe(false);
  });

  // Uma checkbox ausente não envia campo. `readLessonCreateFormData` traduz a
  // ausência em `false` antes do schema, e é isso que este teste fixa.
  it("uma checkbox ausente vale false", () => {
    const formData = new FormData();
    formData.set("sportId", SPORT);
    formData.set("date", "2026-08-24");
    formData.set("time", "18:00");
    formData.set("durationMinutes", "60");
    formData.set("title", "Beach Tennis · Ana");
    formData.set("mode", "student");
    formData.set("studentId", STUDENT);
    formData.set("idempotencyKey", KEY);

    const read = readLessonCreateFormData(formData);
    expect(read.requiresConfirmation).toBe(false);
    expect(lessonCreateSchema.parse(read).requiresConfirmation).toBe(false);
  });

  it("uma checkbox marcada vale true", () => {
    const formData = new FormData();
    formData.set("requiresConfirmation", "on");
    expect(readLessonCreateFormData(formData).requiresConfirmation).toBe(true);
  });

  // O que o browser envia numa checkbox é `on`. Qualquer outra coisa é lixo, e
  // lixo nunca pode virar `true` em silêncio — seria pedir confirmação a alunos
  // sem o professor ter escolhido isso.
  it("um valor malformado não vira true", () => {
    for (const value of ["", "yes", "sim", "0", "off", "verdadeiro"]) {
      const formData = new FormData();
      formData.set("requiresConfirmation", value);
      expect(readLessonCreateFormData(formData).requiresConfirmation).toBe(false);
    }
  });

  it("não aceita um booleano fora do formato", () => {
    expect(
      lessonCreateSchema.safeParse({ ...base, requiresConfirmation: "talvez" }).success,
    ).toBe(false);
  });
});

describe("lessonConfirmParticipationSchema", () => {
  it("aceita apenas a aula", () => {
    expect(lessonConfirmParticipationSchema.parse({ lessonId: LESSON })).toEqual({
      lessonId: LESSON,
    });
  });

  it("recusa um identificador inválido", () => {
    expect(lessonConfirmParticipationSchema.safeParse({ lessonId: "aula-1" }).success).toBe(false);
  });

  // O aluno e a participação saem da sessão dentro do PostgreSQL. Aceitá-los
  // daqui deixaria alguém responder pela pessoa ao lado.
  it("não aceita aluno, participação, estado nem presença", () => {
    for (const field of [
      "studentId",
      "participationId",
      "participantId",
      "status",
      "confirmedAt",
      "attendanceStatus",
      "studentPackageId",
      "teacherId",
      "organizationId",
    ]) {
      expect(
        lessonConfirmParticipationSchema.safeParse({ lessonId: LESSON, [field]: STUDENT }).success,
      ).toBe(false);
    }
  });

  it("assinala campos que o formulário não devia enviar", () => {
    const formData = new FormData();
    formData.set("lessonId", LESSON);
    formData.set("studentId", STUDENT);
    formData.set("attendanceStatus", "present");

    expect(unexpectedLessonFields(formData, LESSON_CONFIRM_PARTICIPATION_FIELDS).sort()).toEqual([
      "attendanceStatus",
      "studentId",
    ]);
  });
});

describe("lessonRescheduleSchema", () => {
  const reschedule = {
    lessonId: LESSON,
    date: "2026-08-24",
    time: "19:00",
    reason: "Aluno pediu para trocar de dia",
    idempotencyKey: KEY,
  };

  it("aceita a intenção completa", () => {
    expect(lessonRescheduleSchema.parse(reschedule)).toEqual({
      lessonId: LESSON,
      date: "2026-08-24",
      time: "19:00",
      reason: "Aluno pediu para trocar de dia",
      locationId: null,
      locationResourceId: null,
      idempotencyKey: KEY,
    });
  });

  it("aceita local e campo", () => {
    expect(
      lessonRescheduleSchema.parse({
        ...reschedule,
        locationId: LOCATION,
        locationResourceId: RESOURCE,
      }).locationResourceId,
    ).toBe(RESOURCE);
  });

  it("exige um motivo com conteúdo", () => {
    expect(lessonRescheduleSchema.safeParse({ ...reschedule, reason: "" }).success).toBe(false);
    expect(lessonRescheduleSchema.safeParse({ ...reschedule, reason: "  " }).success).toBe(false);
    expect(lessonRescheduleSchema.safeParse({ ...reschedule, reason: "ok" }).success).toBe(false);
    expect(
      lessonRescheduleSchema.safeParse({ ...reschedule, reason: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("apara o motivo antes de o validar", () => {
    expect(
      lessonRescheduleSchema.parse({ ...reschedule, reason: "  Lesão do aluno  " }).reason,
    ).toBe("Lesão do aluno");
  });

  it("recusa identificador, data e hora inválidos", () => {
    expect(lessonRescheduleSchema.safeParse({ ...reschedule, lessonId: "aula-1" }).success).toBe(
      false,
    );
    expect(lessonRescheduleSchema.safeParse({ ...reschedule, date: "24-08-2026" }).success).toBe(
      false,
    );
    expect(lessonRescheduleSchema.safeParse({ ...reschedule, time: "25:00" }).success).toBe(false);
  });

  it("exige uma chave de idempotência válida", () => {
    expect(
      lessonRescheduleSchema.safeParse({ ...reschedule, idempotencyKey: undefined }).success,
    ).toBe(false);
    expect(
      lessonRescheduleSchema.safeParse({ ...reschedule, idempotencyKey: "repetir" }).success,
    ).toBe(false);
  });

  it("recusa um campo sem local", () => {
    expect(
      lessonRescheduleSchema.safeParse({ ...reschedule, locationResourceId: RESOURCE }).success,
    ).toBe(false);
  });

  // A duração é derivada da aula real pelo servidor. Aceitá-la aqui deixaria
  // encurtar uma aula por um formulário que nem sequer a mostra.
  it("não aceita duração, participante, pacote nem estado", () => {
    for (const field of [
      "durationMinutes",
      "studentId",
      "groupId",
      "sportId",
      "contextKind",
      "clubOrganizationId",
      "status",
      "creditCost",
      "studentPackageId",
      "teacherId",
      "organizationId",
      "createdBy",
      "startsAt",
      "endsAt",
      "rescheduledFromId",
      "rescheduledToId",
    ]) {
      expect(lessonRescheduleSchema.safeParse({ ...reschedule, [field]: "60" }).success).toBe(
        false,
      );
    }
  });

  it("lê apenas os campos previstos do formulário", () => {
    const formData = new FormData();
    formData.set("lessonId", LESSON);
    formData.set("date", "2026-08-24");
    formData.set("time", "19:00");
    formData.set("locationId", LOCATION);
    formData.set("locationResourceId", RESOURCE);
    formData.set("reason", "Aluno pediu para trocar de dia");
    formData.set("idempotencyKey", KEY);

    expect(readLessonRescheduleFormData(formData)).toEqual({
      lessonId: LESSON,
      date: "2026-08-24",
      time: "19:00",
      locationId: LOCATION,
      locationResourceId: RESOURCE,
      reason: "Aluno pediu para trocar de dia",
      idempotencyKey: KEY,
    });
  });

  it("assinala campos que o formulário não devia enviar", () => {
    const formData = new FormData();
    formData.set("lessonId", LESSON);
    formData.set("durationMinutes", "30");
    formData.set("teacherId", STUDENT);

    expect(unexpectedLessonFields(formData, LESSON_RESCHEDULE_FIELDS).sort()).toEqual([
      "durationMinutes",
      "teacherId",
    ]);
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
