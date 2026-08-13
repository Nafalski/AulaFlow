import { describe, expect, it } from "vitest";

import {
  EDITABLE_LESSON_STATUSES,
  LESSON_CONFLICT_PROTECTION_NOTICE,
  LESSON_CONTEXT_KINDS,
  LESSON_CONTEXT_LABELS,
  LESSON_DURATION_LIMITS,
  LESSON_RECURRENCE_LABELS,
  LESSON_RECURRENCE_MODES,
  PARTICIPANT_MODE_LABELS,
  WEEKLY_RECURRENCE_LIMITS,
  addDurationToTime,
  durationChoices,
  isLessonEditable,
  lessonCalendarSlot,
  lessonDraftBlockedReason,
  lessonNotEditableReason,
  locationsForContext,
  minutesBetweenTimes,
  recurringLessonLabel,
  resourcesForLocation,
  suggestedLessonTitle,
  weeklyRecurrenceSummary,
  weeklyRecurrenceWindows,
  type LessonDraft,
  type SchedulableLocation,
  type SchedulableResource,
} from "./lesson-scheduling";
import type { LessonStatus } from "@/types/database";

const draft = (extra: Partial<LessonDraft> = {}): LessonDraft => ({
  mode: "student",
  studentId: "student-1",
  groupId: null,
  locationId: null,
  locationResourceId: null,
  contextKind: "personal",
  clubOrganizationId: null,
  ...extra,
});

describe("contexto da aula", () => {
  it("tem apenas pessoal e clube", () => {
    expect(LESSON_CONTEXT_KINDS).toEqual(["personal", "club"]);
  });

  it("dá rótulo a cada contexto", () => {
    for (const kind of LESSON_CONTEXT_KINDS) {
      expect(LESSON_CONTEXT_LABELS[kind]).toBeTruthy();
    }
  });

  it("nomeia os dois modos de participante", () => {
    expect(PARTICIPANT_MODE_LABELS.student).toBe("Aluno");
    expect(PARTICIPANT_MODE_LABELS.group).toBe("Turma");
  });

  it("limita a recorrência semanal a séries pequenas", () => {
    expect(LESSON_RECURRENCE_MODES).toEqual(["none", "weekly"]);
    expect(LESSON_RECURRENCE_LABELS.weekly).toBe("Semanalmente");
    expect(WEEKLY_RECURRENCE_LIMITS).toEqual({ min: 2, max: 12 });
  });
});

describe("durationChoices", () => {
  it("inclui a preferência do professor sem duplicar", () => {
    expect(durationChoices(50)).toEqual([30, 45, 50, 60, 75, 90, 120]);
    expect(durationChoices(60)).toEqual([30, 45, 60, 75, 90, 120]);
  });

  it("ignora preferências ausentes ou fora dos limites", () => {
    const base = [30, 45, 60, 75, 90, 120];
    expect(durationChoices(null)).toEqual(base);
    expect(durationChoices(undefined)).toEqual(base);
    expect(durationChoices(5)).toEqual(base);
    expect(durationChoices(900)).toEqual(base);
    expect(durationChoices(60.5)).toEqual(base);
  });

  it("aceita exatamente os limites", () => {
    expect(durationChoices(LESSON_DURATION_LIMITS.min)).toContain(10);
    expect(durationChoices(LESSON_DURATION_LIMITS.max)).toContain(720);
  });
});

describe("aritmética de horas civis", () => {
  it("soma uma duração a uma hora", () => {
    expect(addDurationToTime("18:00", 90)).toBe("19:30");
    expect(addDurationToTime("09:15", 45)).toBe("10:00");
  });

  it("não transborda para o dia seguinte", () => {
    expect(addDurationToTime("23:30", 120)).toBe("24:00");
  });

  it("mede a diferença entre duas horas", () => {
    expect(minutesBetweenTimes("18:00", "19:30")).toBe(90);
    expect(minutesBetweenTimes("19:00", "18:00")).toBe(-60);
  });
});

describe("lessonDraftBlockedReason", () => {
  it("aceita um rascunho individual completo", () => {
    expect(lessonDraftBlockedReason(draft())).toBeNull();
  });

  it("exige aluno no modo aluno", () => {
    expect(lessonDraftBlockedReason(draft({ studentId: null }))).toContain("aluno");
  });

  it("exige turma no modo turma", () => {
    expect(
      lessonDraftBlockedReason(draft({ mode: "group", studentId: null, groupId: null })),
    ).toContain("turma");
  });

  it("exige clube quando o contexto é de clube", () => {
    expect(lessonDraftBlockedReason(draft({ contextKind: "club" }))).toContain("clube");
  });

  it("exige local antes do campo ou sala", () => {
    expect(
      lessonDraftBlockedReason(draft({ locationResourceId: "resource-1" })),
    ).toContain("local");
  });

  it("aceita um rascunho de clube completo", () => {
    expect(
      lessonDraftBlockedReason(
        draft({ contextKind: "club", clubOrganizationId: "club-1" }),
      ),
    ).toBeNull();
  });
});

describe("editabilidade", () => {
  it("permite editar aulas agendadas e confirmadas", () => {
    expect(EDITABLE_LESSON_STATUSES).toEqual(["scheduled", "confirmed"]);
    expect(isLessonEditable("scheduled")).toBe(true);
    expect(isLessonEditable("confirmed")).toBe(true);
    expect(lessonNotEditableReason("scheduled")).toBeNull();
  });

  it("recusa todos os estados terminais", () => {
    const terminal: LessonStatus[] = [
      "completed",
      "cancelled_by_teacher",
      "cancelled_by_student",
      "rescheduled",
      "no_show_student",
      "no_show_teacher",
    ];
    for (const status of terminal) {
      expect(isLessonEditable(status)).toBe(false);
      expect(lessonNotEditableReason(status)).toContain("histórico");
    }
  });
});

describe("suggestedLessonTitle", () => {
  it("junta modalidade e nome", () => {
    expect(suggestedLessonTitle("Beach Tennis", "Ana Marques")).toBe("Beach Tennis · Ana Marques");
  });

  it("usa só a modalidade quando não há nome", () => {
    expect(suggestedLessonTitle("Padel", null)).toBe("Padel");
    expect(suggestedLessonTitle("Padel", "   ")).toBe("Padel");
  });

  it("respeita o limite da base de dados", () => {
    expect(suggestedLessonTitle("Ténis", "a".repeat(200)).length).toBe(120);
  });
});

describe("resourcesForLocation", () => {
  const resources: SchedulableResource[] = [
    { id: "b", locationId: "loc-1", name: "Campo 2", kind: "court", displayOrder: 2 },
    { id: "a", locationId: "loc-1", name: "Campo 1", kind: "court", displayOrder: 1 },
    { id: "c", locationId: "loc-2", name: "Sala", kind: "room", displayOrder: 1 },
  ];

  it("devolve só os do local escolhido, por ordem", () => {
    expect(resourcesForLocation(resources, "loc-1").map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("devolve vazio sem local escolhido", () => {
    expect(resourcesForLocation(resources, null)).toEqual([]);
  });

  it("desempata pelo nome quando a ordem coincide", () => {
    const same: SchedulableResource[] = [
      { id: "b", locationId: "l", name: "Beta", kind: "area", displayOrder: 1 },
      { id: "a", locationId: "l", name: "Alfa", kind: "area", displayOrder: 1 },
    ];
    expect(resourcesForLocation(same, "l").map((entry) => entry.name)).toEqual(["Alfa", "Beta"]);
  });
});

describe("locationsForContext", () => {
  const locations: SchedulableLocation[] = [
    {
      id: "private",
      name: "Meu campo",
      visibility: "private",
      organizationId: "org-pessoal",
      isActive: true,
      moderationStatus: "not_required",
    },
    {
      id: "club",
      name: "Pavilhão",
      visibility: "club",
      organizationId: "club-1",
      isActive: true,
      moderationStatus: "not_required",
    },
    {
      id: "other-club",
      name: "Outro pavilhão",
      visibility: "club",
      organizationId: "club-2",
      isActive: true,
      moderationStatus: "not_required",
    },
    {
      id: "public",
      name: "Parque",
      visibility: "public",
      organizationId: "org-pessoal",
      isActive: true,
      moderationStatus: "approved",
    },
    {
      id: "pending",
      name: "Proposta",
      visibility: "public",
      organizationId: "org-pessoal",
      isActive: true,
      moderationStatus: "pending",
    },
    {
      id: "inactive",
      name: "Desativado",
      visibility: "private",
      organizationId: "org-pessoal",
      isActive: false,
      moderationStatus: "not_required",
    },
  ];

  it("no contexto pessoal oferece privados e públicos aprovados", () => {
    expect(locationsForContext(locations, "personal", null).map((entry) => entry.id)).toEqual([
      "private",
      "public",
    ]);
  });

  it("no contexto de clube oferece o local desse clube e os públicos aprovados", () => {
    expect(locationsForContext(locations, "club", "club-1").map((entry) => entry.id)).toEqual([
      "club",
      "public",
    ]);
  });

  it("nunca oferece o local de outro clube", () => {
    expect(
      locationsForContext(locations, "club", "club-1").some((entry) => entry.id === "other-club"),
    ).toBe(false);
  });

  it("nunca oferece propostas por aprovar nem locais desativados", () => {
    const ids = locationsForContext(locations, "personal", null).map((entry) => entry.id);
    expect(ids).not.toContain("pending");
    expect(ids).not.toContain("inactive");
  });
});

describe("lessonCalendarSlot", () => {
  it("converte instantes UTC para dia civil e horas de Lisboa", () => {
    // Agosto: Lisboa está em WEST (UTC+1).
    expect(lessonCalendarSlot("2026-08-24T17:00:00Z", "2026-08-24T18:00:00Z")).toEqual({
      date: "2026-08-24",
      startTime: "18:00:00",
      endTime: "19:00:00",
    });
  });

  it("respeita o inverno, em que Lisboa está em UTC", () => {
    expect(lessonCalendarSlot("2026-01-15T18:00:00Z", "2026-01-15T19:30:00Z")).toEqual({
      date: "2026-01-15",
      startTime: "18:00:00",
      endTime: "19:30:00",
    });
  });

  it("usa o dia de Lisboa, e não o de UTC, perto da meia-noite", () => {
    // 23:30 em Lisboa no verão é 22:30 UTC — o mesmo dia civil em Lisboa.
    expect(lessonCalendarSlot("2026-08-24T22:30:00Z", "2026-08-24T23:30:00Z").date).toBe(
      "2026-08-24",
    );
    // 00:30 de dia 25 em Lisboa é 23:30 de dia 24 em UTC.
    expect(lessonCalendarSlot("2026-08-24T23:30:00Z", "2026-08-25T00:30:00Z").date).toBe(
      "2026-08-25",
    );
  });
});

describe("recorrência semanal", () => {
  it("resume a série sem prometer disponibilidade futura", () => {
    expect(
      weeklyRecurrenceSummary({
        date: "2026-08-24",
        time: "18:00",
        occurrenceCount: 8,
      }),
    ).toBe("8 aulas semanais a partir de 24/08/2026, sempre às 18:00.");
  });

  it("mantém a mesma hora civil de Lisboa quando atravessa a mudança da hora", () => {
    const windows = weeklyRecurrenceWindows({
      date: "2026-10-19",
      time: "18:00",
      durationMinutes: 60,
      occurrenceCount: 2,
    });

    expect(windows.map((window) => window.date)).toEqual(["2026-10-19", "2026-10-26"]);
    expect(windows.map((window) => window.startsAt)).toEqual([
      "2026-10-19T18:00:00.000+01:00",
      "2026-10-26T18:00:00.000+00:00",
    ]);
    expect(
      new Date(windows[1]?.startsAt ?? "").getTime() -
        new Date(windows[0]?.startsAt ?? "").getTime(),
    ).toBe(169 * 60 * 60 * 1000);
  });

  it("nomeia uma ocorrência concreta quando tem índice e total", () => {
    expect(
      recurringLessonLabel({
        isRecurring: true,
        frequency: "weekly",
        occurrenceIndex: 3,
        occurrenceCount: 8,
      }),
    ).toBe("Aula recorrente 3 de 8");
  });

  it("cai para série semanal quando a regra está incompleta", () => {
    expect(
      recurringLessonLabel({
        isRecurring: true,
        frequency: null,
        occurrenceIndex: null,
        occurrenceCount: null,
      }),
    ).toBe("Série semanal");
    expect(
      recurringLessonLabel({
        isRecurring: false,
      }),
    ).toBeNull();
  });
});

describe("honestidade sobre o que existe e o que ainda não existe", () => {
  it("o aviso diz que conflitos e créditos são revalidados no banco", () => {
    expect(LESSON_CONFLICT_PROTECTION_NOTICE).toContain("sobreposição");
    expect(LESSON_CONFLICT_PROTECTION_NOTICE).toContain("intervalo mínimo");
    expect(LESSON_CONFLICT_PROTECTION_NOTICE).toContain("créditos");
    expect(LESSON_CONFLICT_PROTECTION_NOTICE).toContain("revalidação final");
  });

  it("nada no módulo promete disponibilidade absoluta de um campo", () => {
    const text = [
      ...Object.values(LESSON_CONTEXT_LABELS),
      ...Object.values(PARTICIPANT_MODE_LABELS),
      LESSON_CONFLICT_PROTECTION_NOTICE,
    ]
      .join(" ")
      .toLowerCase();
    expect(text).not.toContain("sem conflito");
    expect(text).not.toContain("livre");
    expect(text).not.toContain("ocupado");
  });
});
