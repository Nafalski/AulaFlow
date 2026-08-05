import { describe, expect, it } from "vitest";

import {
  CLUB_CALENDAR_ALL_TEACHERS,
  clubCalendarBasePath,
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

  it("marca como indisponível um dia sem qualquer disponibilidade", () => {
    const merged = mergeClubPeriods([period("m1", "2026-09-08", null, null, "unavailable")]);

    expect(merged).toEqual([
      { date: "2026-09-08", startsAt: null, endsAt: null, status: "unavailable" },
    ]);
  });

  it("não inventa disponibilidade quando não há períodos", () => {
    expect(mergeClubPeriods([])).toEqual([]);
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
