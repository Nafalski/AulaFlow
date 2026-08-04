import { describe, expect, it } from "vitest";

import {
  addCivilDays,
  categoryLabel,
  hasAnyOverlap,
  timeRangeLabel,
  weekdayLabel,
} from "./availability";

describe("availability domain", () => {
  it("mantém dias civis estáveis nas mudanças de hora em Lisboa", () => {
    expect(addCivilDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addCivilDays("2026-10-24", 1)).toBe("2026-10-25");
  });

  it("identifica sobreposição de períodos locais", () => {
    expect(
      hasAnyOverlap([
        { startsAt: "09:00", endsAt: "13:00" },
        { startsAt: "12:45", endsAt: "15:00" },
      ]),
    ).toBe(true);

    expect(
      hasAnyOverlap([
        { startsAt: "09:00", endsAt: "13:00" },
        { startsAt: "15:00", endsAt: "20:00" },
      ]),
    ).toBe(false);
  });

  it("gera rótulos simples para interface", () => {
    expect(weekdayLabel(1)).toBe("Segunda-feira");
    expect(categoryLabel("vacation")).toBe("Férias");
    expect(timeRangeLabel("09:00:00", "13:30:00")).toBe("09:00 - 13:30");
    expect(timeRangeLabel(null, null)).toBe("Dia inteiro");
  });
});
