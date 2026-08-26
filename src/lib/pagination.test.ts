import { describe, expect, it } from "vitest";

import {
  buildPageHref,
  pageQueryRange,
  pageSlice,
  readPageNumber,
} from "./pagination";

describe("paginação por URL", () => {
  it("aceita páginas positivas e repõe parâmetros inválidos com segurança", () => {
    expect(readPageNumber("3")).toBe(3);
    expect(readPageNumber(["4", "5"])).toBe(4);
    expect(readPageNumber("0")).toBe(1);
    expect(readPageNumber("-1")).toBe(1);
    expect(readPageNumber("abc")).toBe(1);
    expect(readPageNumber("100001")).toBe(1);
  });

  it("calcula páginas adjacentes sem duplicar linhas", () => {
    const records = Array.from({ length: 11 }, (_, index) => `row-${index + 1}`);
    const firstRange = pageQueryRange(1, 5);
    const secondRange = pageQueryRange(2, 5);
    const first = pageSlice(records.slice(firstRange.from, firstRange.to + 1), 5);
    const second = pageSlice(records.slice(secondRange.from, secondRange.to + 1), 5);
    const final = pageSlice(records.slice(10, 16), 5);

    expect(first).toEqual({ rows: records.slice(0, 5), hasNext: true });
    expect(second).toEqual({ rows: records.slice(5, 10), hasNext: true });
    expect(final).toEqual({ rows: ["row-11"], hasNext: false });
    expect(first.rows.filter((row) => second.rows.includes(row))).toEqual([]);
  });

  it("preserva filtros e remove a página quando volta à primeira", () => {
    const params = { search: "Rita Silva", status: "active", tag: ["a", "b"], pagina: "9" };

    expect(buildPageHref("/professor/alunos", params, 2)).toBe(
      "/professor/alunos?search=Rita+Silva&status=active&tag=a&tag=b&pagina=2",
    );
    expect(buildPageHref("/professor/alunos", params, 1)).toBe(
      "/professor/alunos?search=Rita+Silva&status=active&tag=a&tag=b",
    );
  });

  it("preserva todos os filtros dos pacotes atribuídos sem duplicar a página", () => {
    const params = {
      tab: "assigned",
      search: "Pacote escola",
      status: "active",
      sportId: "00000000-0000-4000-8000-000000000001",
      balance: "low",
      expiry: "soon",
      pagina: ["7", "8"],
    };

    expect(buildPageHref("/professor/pacotes", params, 3)).toBe(
      "/professor/pacotes?tab=assigned&search=Pacote+escola&status=active&sportId=00000000-0000-4000-8000-000000000001&balance=low&expiry=soon&pagina=3",
    );
  });
});
