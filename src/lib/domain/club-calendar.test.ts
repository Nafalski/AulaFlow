import { describe, expect, it } from "vitest";

import {
  CLUB_CALENDAR_ALL_TEACHERS,
  CLUB_CALENDAR_STATES,
  CLUB_CALENDAR_STATE_LABELS,
  clubCalendarBasePath,
  clubCalendarStateFor,
  isClubCalendarEmpty,
  mergeClubPeriods,
  resolveClubCalendarFilter,
  sharingMembers,
  sharingState,
  sharingStateLabel,
  sharingStateTone,
  sortClubCalendarMembers,
  toClubCalendarItems,
  type ClubCalendarMember,
  type ClubCalendarPeriod,
} from "./club-calendar";

const member = (
  membershipId: string,
  teacherName: string,
  sharingEnabled: boolean,
  isSelf = false,
): ClubCalendarMember => ({ membershipId, teacherName, sharingEnabled, isSelf });

const period = (
  membershipId: string,
  date: string,
  startsAt: string | null,
  endsAt: string | null,
  status: "available" | "unavailable" = "available",
): ClubCalendarPeriod => ({
  membershipId,
  teacherName: `Prof ${membershipId}`,
  date,
  startsAt,
  endsAt,
  status,
});

describe("estado de partilha", () => {
  it("distingue partilhada de não partilhada", () => {
    expect(sharingState(true)).toBe("shared");
    expect(sharingState(false)).toBe("not_shared");
    expect(sharingStateLabel(false)).toBe("Disponibilidade não partilhada");
    expect(sharingStateLabel(true)).toBe("Disponibilidade partilhada");
  });

  it("não depende só da cor para transmitir o estado", () => {
    expect(sharingStateTone(true)).toBe("success");
    expect(sharingStateTone(false)).toBe("neutral");
    expect(sharingStateLabel(false)).not.toBe(sharingStateLabel(true));
  });
});

describe("lista de professores", () => {
  const members = [
    member("m3", "Zita", true),
    member("m1", "Marco", false, true),
    member("m2", "Ana", true),
  ];

  it("coloca o próprio em primeiro e ordena os restantes por nome", () => {
    expect(sortClubCalendarMembers(members).map((entry) => entry.teacherName)).toEqual([
      "Marco",
      "Ana",
      "Zita",
    ]);
  });

  it("não muta a lista recebida", () => {
    const original = [...members];
    sortClubCalendarMembers(members);
    expect(members).toEqual(original);
  });

  it("separa quem partilha de quem não partilha", () => {
    expect(sharingMembers(members).map((entry) => entry.teacherName)).toEqual(["Zita", "Ana"]);
    expect(isClubCalendarEmpty(members)).toBe(false);
    expect(isClubCalendarEmpty([member("m1", "Marco", false)])).toBe(true);
    expect(isClubCalendarEmpty([])).toBe(true);
  });
});

describe("filtro por professor", () => {
  const members = [member("m1", "Ana", true), member("m2", "Bruno", false)];

  it("trata ausência e “todos” como sem filtro", () => {
    expect(resolveClubCalendarFilter(members, undefined)).toBeNull();
    expect(resolveClubCalendarFilter(members, null)).toBeNull();
    expect(resolveClubCalendarFilter(members, "")).toBeNull();
    expect(resolveClubCalendarFilter(members, CLUB_CALENDAR_ALL_TEACHERS)).toBeNull();
  });

  it("aceita um membro conhecido do clube", () => {
    expect(resolveClubCalendarFilter(members, "m1")).toBe("m1");
  });

  it("descarta um identificador que não pertence a este clube", () => {
    expect(resolveClubCalendarFilter(members, "m-de-outro-clube")).toBeNull();
    expect(resolveClubCalendarFilter([], "m1")).toBeNull();
  });
});

describe("DTO do calendário", () => {
  it("devolve apenas data, início, fim e estado", () => {
    const items = toClubCalendarItems([period("m1", "2026-09-07", "09:00:00", "12:00:00")]);

    expect(items).toHaveLength(1);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(["date", "endsAt", "startsAt", "status"]);
  });

  it("não transporta motivo, categoria, origem nem identificadores internos", () => {
    const items = toClubCalendarItems([period("m1", "2026-09-07", "09:00:00", "12:00:00")]);
    const serialized = JSON.stringify(items);

    for (const forbidden of [
      "reason",
      "category",
      "source",
      "sourceId",
      "allDay",
      "membershipId",
      "teacherName",
      "teacherId",
      "organizationId",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("produz apenas estados de disponibilidade, nunca estados de aula", () => {
    const items = toClubCalendarItems([
      period("m1", "2026-09-07", "09:00:00", "12:00:00"),
      period("m1", "2026-09-08", null, null, "unavailable"),
    ]);

    expect([...new Set(items.map((item) => item.status))].sort()).toEqual([
      "available",
      "unavailable",
    ]);
    const serialized = JSON.stringify(items);
    for (const fake of ["ocupado", "reservado", "lotado", "vagas", "conflito", "aula"]) {
      expect(serialized.toLowerCase()).not.toContain(fake);
    }
  });

  it("é serializável para atravessar a fronteira Server → Client", () => {
    const items = toClubCalendarItems([period("m1", "2026-09-07", "09:00:00", "12:00:00")]);
    expect(structuredClone(items)).toEqual(items);
  });
});

describe("sobreposição em “Todos”", () => {
  it("une períodos que se tocam ou sobrepõem", () => {
    const merged = mergeClubPeriods([
      period("m1", "2026-09-07", "09:00:00", "11:00:00"),
      period("m2", "2026-09-07", "10:00:00", "12:00:00"),
    ]);

    expect(merged.filter((item) => item.status === "available")).toEqual([
      { date: "2026-09-07", startsAt: "09:00:00", endsAt: "12:00:00", status: "available" },
    ]);
  });

  it("mantém separados os períodos que não se tocam", () => {
    const merged = mergeClubPeriods([
      period("m1", "2026-09-07", "09:00:00", "10:00:00"),
      period("m2", "2026-09-07", "11:00:00", "12:00:00"),
    ]);

    expect(merged.filter((item) => item.status === "available")).toHaveLength(2);
  });

  // Um dia sem janela positiva é "fora do horário", não "indisponível": marcá-lo
  // como indisponível diria que o professor está ocupado num dia em que apenas
  // não trabalha.
  it("um dia sem janela positiva não produz linha nenhuma", () => {
    expect(mergeClubPeriods([period("m1", "2026-09-08", null, null, "unavailable")])).toEqual([]);
  });

  it("não inventa disponibilidade quando não há períodos", () => {
    expect(mergeClubPeriods([])).toEqual([]);
  });

  // O bloqueio de um professor não pode escurecer uma hora em que um colega
  // está livre: em "Todos", a pergunta é se ALGUÉM está disponível.
  it("não marca como indisponível um horário em que outro professor está livre", () => {
    const merged = mergeClubPeriods([
      period("m1", "2026-09-07", "10:00:00", "11:00:00", "unavailable"),
      period("m2", "2026-09-07", "09:00:00", "12:00:00"),
    ]);

    expect(merged).toEqual([
      { date: "2026-09-07", startsAt: "09:00:00", endsAt: "12:00:00", status: "available" },
    ]);
  });

  it("mantém indisponível a parte do bloqueio que ninguém cobre", () => {
    const merged = mergeClubPeriods([
      period("m1", "2026-09-07", "10:00:00", "12:00:00", "unavailable"),
      period("m2", "2026-09-07", "11:00:00", "13:00:00"),
    ]);

    expect(merged).toEqual([
      { date: "2026-09-07", startsAt: "10:00:00", endsAt: "11:00:00", status: "unavailable" },
      { date: "2026-09-07", startsAt: "11:00:00", endsAt: "13:00:00", status: "available" },
    ]);
  });

  it("parte o bloqueio em dois quando a disponibilidade cobre o meio", () => {
    const merged = mergeClubPeriods([
      period("m1", "2026-09-07", "09:00:00", "13:00:00", "unavailable"),
      period("m2", "2026-09-07", "10:00:00", "11:00:00"),
    ]);

    expect(merged.filter((item) => item.status === "unavailable")).toEqual([
      { date: "2026-09-07", startsAt: "09:00:00", endsAt: "10:00:00", status: "unavailable" },
      { date: "2026-09-07", startsAt: "11:00:00", endsAt: "13:00:00", status: "unavailable" },
    ]);
  });

  it("um dia com janela bloqueada devolve só a faixa, sem dia inteiro", () => {
    const merged = mergeClubPeriods([
      period("m1", "2026-09-14", "09:00:00", "13:00:00", "unavailable"),
    ]);

    expect(merged).toEqual([
      { date: "2026-09-14", startsAt: "09:00:00", endsAt: "13:00:00", status: "unavailable" },
    ]);
    expect(merged.some((item) => item.startsAt === null)).toBe(false);
  });

  it("nunca devolve faixas sem horas", () => {
    const merged = mergeClubPeriods([
      period("m1", "2026-09-07", "09:00:00", "10:00:00"),
      period("m1", "2026-09-08", null, null, "unavailable"),
      period("m2", "2026-09-09", null, null, "unavailable"),
    ]);

    expect(merged.every((item) => item.startsAt !== null && item.endsAt !== null)).toBe(true);
  });
});

describe("estados genéricos da etapa", () => {
  it("declara exatamente quatro estados, e nenhum é uma aula", () => {
    expect([...CLUB_CALENDAR_STATES]).toEqual([
      "available",
      "unavailable",
      "outside_hours",
      "not_shared",
    ]);

    const vocabulary = JSON.stringify(CLUB_CALENDAR_STATE_LABELS).toLowerCase();
    for (const fake of ["ocupado com", "reservad", "lotad", "vaga", "conflito", "aula"]) {
      expect(vocabulary).not.toContain(fake);
    }
  });

  it("rotula cada estado em português", () => {
    expect(CLUB_CALENDAR_STATE_LABELS.available).toBe("Disponível");
    expect(CLUB_CALENDAR_STATE_LABELS.unavailable).toBe("Indisponível");
    expect(CLUB_CALENDAR_STATE_LABELS.outside_hours).toBe("Fora do horário");
    expect(CLUB_CALENDAR_STATE_LABELS.not_shared).toBe("Disponibilidade não partilhada");
  });

  it("traduz as linhas da projeção nos dois estados que o servidor devolve", () => {
    expect(clubCalendarStateFor("available")).toBe("available");
    expect(clubCalendarStateFor("unavailable")).toBe("unavailable");
  });

  // "Fora do horário" é ausência de linha: nunca chega do servidor.
  it("fora do horário nunca é um estado devolvido pela projeção", () => {
    const statuses = toClubCalendarItems([
      period("m1", "2026-09-07", "09:00:00", "10:00:00"),
      period("m1", "2026-09-07", "10:00:00", "11:00:00", "unavailable"),
    ]).map((item) => item.status);

    expect(statuses).not.toContain("outside_hours");
    expect(statuses).not.toContain("not_shared");
  });
});

describe("endereço do calendário do clube", () => {
  it("aponta para a rota do clube", () => {
    expect(clubCalendarBasePath("clube-1")).toBe("/professor/clubes/clube-1/calendario");
  });

  it("inclui o filtro quando existe", () => {
    expect(clubCalendarBasePath("clube-1", "m1")).toBe(
      "/professor/clubes/clube-1/calendario?professor=m1",
    );
  });

  it("omite o filtro em “todos”", () => {
    expect(clubCalendarBasePath("clube-1", null)).toBe("/professor/clubes/clube-1/calendario");
  });
});
