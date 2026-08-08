import { describe, expect, it } from "vitest";

import {
  LOCATION_RESOURCE_KINDS,
  RESOURCE_KIND_LABELS,
  RESOURCE_ORDER_LIMITS,
  nextDisplayOrder,
  normalizeResourceName,
  resourceCreationBlockedReason,
  resourceNameTaken,
  showsResourceSection,
  sortResources,
  splitResourcesByStatus,
  summarizeResources,
  type LocationResourceSummary,
} from "./location-resources";
import type { LocationResourceKind } from "@/types/database";

const resource = (
  id: string,
  name: string,
  extra: Partial<LocationResourceSummary> = {},
): LocationResourceSummary => ({
  id,
  name,
  kind: "court",
  isActive: true,
  displayOrder: 0,
  ...extra,
});

describe("tipos de recurso", () => {
  it("cobre todos os valores do enum com etiqueta", () => {
    for (const kind of LOCATION_RESOURCE_KINDS) {
      expect(RESOURCE_KIND_LABELS[kind]).toBeTruthy();
    }
  });

  it("mantém os tipos genéricos, sem termos de uma modalidade só", () => {
    const kinds: readonly LocationResourceKind[] = LOCATION_RESOURCE_KINDS;
    expect(kinds).toEqual(["court", "room", "area", "other"]);
  });

  it("não fala de ocupação, reserva ou conflito em nenhuma etiqueta", () => {
    const text = Object.values(RESOURCE_KIND_LABELS).join(" ").toLowerCase();
    for (const forbidden of ["ocupad", "reserv", "conflito", "lotad", "vaga"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("sortResources", () => {
  it("põe os ativos primeiro, depois por ordem e por nome", () => {
    const sorted = sortResources([
      resource("d", "Campo 4", { isActive: false, displayOrder: 0 }),
      resource("b", "Campo 2", { displayOrder: 2 }),
      resource("c", "Campo 3", { displayOrder: 1 }),
      resource("a", "Campo 1", { displayOrder: 1 }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("não altera o array recebido", () => {
    const original = [resource("b", "B", { displayOrder: 2 }), resource("a", "A")];
    sortResources(original);
    expect(original.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("desempata com nomes em português", () => {
    const sorted = sortResources([resource("b", "Ápice"), resource("a", "Alameda")]);
    expect(sorted.map((entry) => entry.name)).toEqual(["Alameda", "Ápice"]);
  });
});

describe("splitResourcesByStatus", () => {
  it("separa ativos de desativados mantendo a ordem", () => {
    const { active, inactive } = splitResourcesByStatus([
      resource("c", "Campo 3", { isActive: false }),
      resource("a", "Campo 1", { displayOrder: 1 }),
      resource("b", "Campo 2", { displayOrder: 2 }),
    ]);

    expect(active.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(inactive.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("aceita uma lista vazia", () => {
    expect(splitResourcesByStatus([])).toEqual({ active: [], inactive: [] });
  });
});

describe("nextDisplayOrder", () => {
  it("continua a sequência a partir do maior valor", () => {
    expect(nextDisplayOrder([resource("a", "A", { displayOrder: 3 })])).toBe(4);
  });

  it("começa em zero quando não há recursos", () => {
    expect(nextDisplayOrder([])).toBe(RESOURCE_ORDER_LIMITS.min);
  });

  it("conta também os recursos desativados, para não repetir a ordem", () => {
    expect(
      nextDisplayOrder([
        resource("a", "A", { displayOrder: 1 }),
        resource("b", "B", { displayOrder: 7, isActive: false }),
      ]),
    ).toBe(8);
  });

  it("não ultrapassa o máximo aceite pela base", () => {
    expect(nextDisplayOrder([resource("a", "A", { displayOrder: 999 })])).toBe(999);
  });
});

describe("resourceNameTaken", () => {
  const existing = [
    resource("a", " Campo 1 "),
    resource("b", "Campo 2", { isActive: false }),
  ];

  it("ignora espaços e maiúsculas, como o índice único", () => {
    expect(resourceNameTaken(existing, "campo 1")).toBe(true);
    expect(resourceNameTaken(existing, "  CAMPO 1  ")).toBe(true);
  });

  it("não considera ocupado o nome de um recurso desativado", () => {
    expect(resourceNameTaken(existing, "Campo 2")).toBe(false);
  });

  it("permite manter o próprio nome ao editar", () => {
    expect(resourceNameTaken(existing, "Campo 1", { ignoreId: "a" })).toBe(false);
  });

  it("trata um nome vazio como não colidente e deixa a validação ao schema", () => {
    expect(resourceNameTaken(existing, "   ")).toBe(false);
  });
});

describe("normalizeResourceName", () => {
  it("apara e passa a minúsculas", () => {
    expect(normalizeResourceName("  Sala A  ")).toBe("sala a");
  });
});

describe("resourceCreationBlockedReason", () => {
  it("permite criar num local privado ativo que o professor administra", () => {
    expect(
      resourceCreationBlockedReason({
        visibility: "private",
        isActive: true,
        canManage: true,
      }),
    ).toBeNull();
  });

  it("recusa locais públicos antes de qualquer outra razão", () => {
    const reason = resourceCreationBlockedReason({
      visibility: "public",
      isActive: false,
      canManage: false,
    });
    expect(reason).toContain("públicos");
  });

  it("recusa quem só consulta o local do clube", () => {
    const reason = resourceCreationBlockedReason({
      visibility: "club",
      isActive: true,
      canManage: false,
    });
    expect(reason).toContain("administra");
  });

  it("recusa um local desativado", () => {
    const reason = resourceCreationBlockedReason({
      visibility: "private",
      isActive: false,
      canManage: true,
    });
    expect(reason).toContain("Reative");
  });
});

describe("showsResourceSection", () => {
  it("mostra a secção em locais privados e de clube", () => {
    expect(showsResourceSection({ visibility: "private" })).toBe(true);
    expect(showsResourceSection({ visibility: "club" })).toBe(true);
  });

  it("esconde a secção em locais públicos", () => {
    expect(showsResourceSection({ visibility: "public" })).toBe(false);
  });
});

describe("summarizeResources", () => {
  it("descreve uma lista vazia", () => {
    expect(summarizeResources([])).toBe("Sem recursos definidos.");
  });

  it("usa o singular com um recurso", () => {
    expect(summarizeResources([resource("a", "A")])).toBe("1 recurso ativo.");
  });

  it("conta ativos e desativados", () => {
    expect(
      summarizeResources([
        resource("a", "A"),
        resource("b", "B"),
        resource("c", "C", { isActive: false }),
      ]),
    ).toBe("2 recursos ativos · 1 desativado.");
  });

  it("não afirma nada sobre ocupação", () => {
    const summary = summarizeResources([resource("a", "A")]).toLowerCase();
    for (const forbidden of ["ocupad", "livre", "reserv", "conflito"]) {
      expect(summary).not.toContain(forbidden);
    }
  });
});
