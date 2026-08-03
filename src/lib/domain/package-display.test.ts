import { describe, expect, it } from "vitest";

import {
  balanceAttention,
  daysBetweenDateOnly,
  expiryAttention,
  packageStatusLabel,
  sortPackageSnapshots,
  usagePercentage,
  type PackageDisplaySnapshot,
} from "./package-display";
import type { PackageStatus } from "@/types/database";

const pack = (overrides: Partial<PackageDisplaySnapshot> = {}): PackageDisplaySnapshot => ({
  status: "active",
  creditsAvailable: 8,
  creditsReserved: 1,
  creditsUsed: 1,
  initialCredits: 10,
  expiresOn: "2026-09-30",
  createdAt: "2026-08-01T10:00:00.000Z",
  ...overrides,
});

describe("package display", () => {
  it.each([
    ["not_started", "Ainda não iniciado"],
    ["active", "Ativo"],
    ["depleted", "Esgotado"],
    ["expired", "Expirado"],
    ["suspended", "Suspenso"],
    ["cancelled", "Cancelado"],
  ] as [PackageStatus, string][])("mostra o estado %s corretamente", (status, label) => {
    expect(packageStatusLabel(status)).toBe(label);
  });

  it("sinaliza saldo baixo apenas com 1 ou 2 créditos disponíveis", () => {
    expect(balanceAttention(3)).toBe("none");
    expect(balanceAttention(2)).toBe("low");
    expect(balanceAttention(1)).toBe("low");
  });

  it("sinaliza saldo zero separadamente", () => {
    expect(balanceAttention(0)).toBe("empty");
  });

  it("sinaliza validade próxima em até 7 dias", () => {
    expect(expiryAttention("2026-08-10", "2026-08-03")).toEqual({
      attention: "soon",
      daysLeft: 7,
    });
    expect(expiryAttention("2026-08-11", "2026-08-03").attention).toBe("none");
  });

  it("sinaliza data expirada quando já passou", () => {
    expect(expiryAttention("2026-08-02", "2026-08-03").attention).toBe("expired");
  });

  it("calcula datas civis sem depender do fuso do servidor", () => {
    expect(daysBetweenDateOnly("2026-03-28", "2026-03-29")).toBe(1);
    expect(daysBetweenDateOnly("2026-10-24", "2026-10-25")).toBe(1);
  });

  it("ordena pacotes utilizáveis primeiro, depois validade e criação", () => {
    const sorted = sortPackageSnapshots([
      pack({ status: "cancelled", createdAt: "2026-08-05T10:00:00.000Z" }),
      pack({ status: "active", expiresOn: "2026-10-01", createdAt: "2026-08-05T10:00:00.000Z" }),
      pack({ status: "active", expiresOn: "2026-09-01", createdAt: "2026-08-04T10:00:00.000Z" }),
      pack({ status: "not_started", expiresOn: "2026-08-20", createdAt: "2026-08-03T10:00:00.000Z" }),
    ]);

    expect(sorted.map((item) => `${item.status}:${item.expiresOn}`)).toEqual([
      "active:2026-09-01",
      "active:2026-10-01",
      "not_started:2026-08-20",
      "cancelled:2026-09-30",
    ]);
  });

  it("calcula percentagem simples de utilização", () => {
    expect(usagePercentage(pack({ creditsUsed: 3, initialCredits: 10 }))).toBe(30);
    expect(usagePercentage(pack({ creditsUsed: 0, initialCredits: 0 }))).toBe(0);
  });
});

