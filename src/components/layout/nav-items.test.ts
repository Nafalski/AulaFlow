import { describe, expect, it } from "vitest";

import { NAV_ICON_KEYS, navItemsForRole } from "./nav-items";
import type { NavItem } from "./nav-items";
import type { UserRole } from "@/types/database";

const ROLES: UserRole[] = ["teacher", "student", "admin"];
const NAV_ICON_KEY_SET = new Set<string>(NAV_ICON_KEYS);

function assertSerializableValue(value: unknown, path: string): void {
  const valueType = typeof value;

  expect(valueType, `${path} nao pode ser funcao`).not.toBe("function");
  expect(valueType, `${path} nao pode ser symbol`).not.toBe("symbol");
  expect(valueType, `${path} nao pode ser bigint`).not.toBe("bigint");

  if (value === null || value === undefined || valueType !== "object") return;

  expect(Object.getPrototypeOf(value), `${path} deve ser um objeto simples`).toBe(
    Object.prototype,
  );

  for (const [key, nestedValue] of Object.entries(value)) {
    assertSerializableValue(nestedValue, `${path}.${key}`);
  }
}

function expectNavItems(role: UserRole): readonly NavItem[] {
  const items = navItemsForRole(role);

  expect(items.length).toBeGreaterThan(0);
  return items;
}

describe("navItemsForRole", () => {
  it("devolve apenas dados simples serializaveis", () => {
    for (const role of ROLES) {
      const items = expectNavItems(role);

      for (const item of items) {
        expect(item).not.toHaveProperty("icon");
        assertSerializableValue(item, `${role}.${item.href}`);
        expect(structuredClone(item)).toEqual(item);
      }
    }
  });

  it("usa apenas chaves de icone conhecidas", () => {
    for (const role of ROLES) {
      const items = expectNavItems(role);

      for (const item of items) {
        expect(NAV_ICON_KEY_SET.has(item.iconKey), item.href).toBe(true);
      }
    }
  });

  it("mantem os destinos principais por area", () => {
    expect(navItemsForRole("teacher").map((item) => item.href)).toEqual([
      "/professor",
      "/professor/calendario",
      "/professor/alunos",
      "/professor/pacotes",
      "/professor/grupos",
      "/professor/locais",
      "/professor/clubes",
      "/professor/convites",
      "/professor/historico",
      "/professor/definicoes",
    ]);

    expect(navItemsForRole("student").map((item) => item.href)).toEqual([
      "/aluno",
      "/aluno/calendario",
      "/aluno/pacotes",
      "/aluno/notificacoes",
      "/aluno/perfil",
      "/aluno/historico",
    ]);

    expect(navItemsForRole("admin").map((item) => item.href)).toEqual([
      "/admin",
      "/admin/professores",
      "/admin/utilizadores",
      "/admin/clubes",
      "/admin/locais",
    ]);
  });
});
