import { describe, expect, it } from "vitest";

import {
  LOCATION_VISIBILITIES,
  MANUAL_ADDRESS_NOTE,
  MODERATION_LABELS,
  SCOPE_LABELS,
  VISIBILITY_LABELS,
  availableVisibilities,
  canEditLocation,
  canResubmitSuggestion,
  formatLocationAddress,
  groupLocationsByScope,
  locationScope,
  moderationTone,
  type LocationSummary,
} from "./locations";
import type { LocationModerationStatus, LocationVisibility } from "@/types/database";

const location = (
  id: string,
  name: string,
  visibility: LocationVisibility,
  moderationStatus: LocationModerationStatus = "not_required",
  extra: Partial<LocationSummary> = {},
): LocationSummary => ({
  id,
  name,
  visibility,
  moderationStatus,
  isActive: true,
  canManage: true,
  isMine: true,
  ...extra,
});

describe("morada manual", () => {
  it("junta os campos escritos pelo utilizador", () => {
    expect(
      formatLocationAddress({
        address: "Rua do Mar 1",
        postalCode: "2825-000",
        city: "Costa da Caparica",
        country: "Portugal",
      }),
    ).toBe("Rua do Mar 1, 2825-000 Costa da Caparica, Portugal");
  });

  it("omite as partes em falta sem deixar vírgulas soltas", () => {
    expect(formatLocationAddress({ city: "Lisboa" })).toBe("Lisboa");
    expect(formatLocationAddress({ address: "Rua A", country: "Portugal" })).toBe(
      "Rua A, Portugal",
    );
  });

  it("devolve null quando não há morada nenhuma", () => {
    expect(formatLocationAddress({})).toBeNull();
    expect(formatLocationAddress({ address: "   ", city: null })).toBeNull();
  });

  // Não existe integração externa nesta etapa: nada pode sugerir validação.
  it("a nota da morada diz explicitamente que não houve validação externa", () => {
    expect(MANUAL_ADDRESS_NOTE).toMatch(/sem validação externa/i);
    expect(MANUAL_ADDRESS_NOTE).not.toMatch(/verificad|confirmad|google/i);
  });

  it("nenhum rótulo de moderação sugere que a morada foi verificada", () => {
    const vocabulary = JSON.stringify(MODERATION_LABELS).toLowerCase();
    expect(vocabulary).not.toContain("morada");
    expect(vocabulary).not.toContain("verificad");
    expect(MODERATION_LABELS.approved).toBe("Aprovado");
  });
});

describe("âmbito", () => {
  it("distingue privado, clube, público aprovado e proposta", () => {
    expect(locationScope(location("1", "A", "private"))).toBe("mine");
    expect(locationScope(location("2", "B", "club"))).toBe("club");
    expect(locationScope(location("3", "C", "public", "approved"))).toBe("public");
    expect(locationScope(location("4", "D", "public", "pending"))).toBe("suggestion");
    expect(locationScope(location("5", "E", "public", "rejected"))).toBe("suggestion");
  });

  it("agrupa e ordena por nome dentro de cada âmbito", () => {
    const grouped = groupLocationsByScope([
      location("1", "Zeta", "private"),
      location("2", "Alfa", "private"),
      location("3", "Clube", "club"),
      location("4", "Proposta", "public", "pending"),
      location("5", "Aprovado", "public", "approved"),
    ]);

    expect(grouped.mine.map((entry) => entry.name)).toEqual(["Alfa", "Zeta"]);
    expect(grouped.club.map((entry) => entry.name)).toEqual(["Clube"]);
    expect(grouped.public.map((entry) => entry.name)).toEqual(["Aprovado"]);
    expect(grouped.suggestion.map((entry) => entry.name)).toEqual(["Proposta"]);
  });

  it("uma proposta pendente nunca é agrupada com os locais públicos", () => {
    const grouped = groupLocationsByScope([location("1", "X", "public", "pending")]);
    expect(grouped.public).toHaveLength(0);
    expect(grouped.suggestion).toHaveLength(1);
  });

  it("cada âmbito tem rótulo próprio em português", () => {
    expect(Object.values(SCOPE_LABELS)).toEqual([
      "Os meus locais",
      "Locais do clube",
      "Locais públicos",
      "As minhas propostas públicas",
    ]);
  });
});

describe("visibilidades disponíveis", () => {
  it("oferece «do clube» apenas a quem administra um clube", () => {
    expect(availableVisibilities({ managesAnyClub: false })).toEqual(["private", "public"]);
    expect(availableVisibilities({ managesAnyClub: true })).toEqual([
      "private",
      "club",
      "public",
    ]);
  });

  it("cobre exatamente as três visibilidades do domínio", () => {
    expect([...LOCATION_VISIBILITIES]).toEqual(["private", "club", "public"]);
    expect(Object.keys(VISIBILITY_LABELS).sort()).toEqual(["club", "private", "public"]);
  });
});

describe("permissões da interface", () => {
  it("só edita quem administra", () => {
    expect(canEditLocation(location("1", "A", "private"))).toBe(true);
    expect(canEditLocation(location("2", "B", "club", "not_required", { canManage: false }))).toBe(
      false,
    );
    expect(
      canEditLocation(location("3", "C", "public", "approved", { canManage: false, isMine: false })),
    ).toBe(false);
  });

  it("uma proposta rejeitada continua a pertencer a quem a propôs", () => {
    expect(canResubmitSuggestion(location("1", "A", "public", "rejected"))).toBe(true);
    expect(
      canResubmitSuggestion(location("2", "B", "public", "rejected", { isMine: false })),
    ).toBe(false);
    expect(canResubmitSuggestion(location("3", "C", "public", "approved"))).toBe(false);
    expect(canResubmitSuggestion(location("4", "D", "private"))).toBe(false);
  });
});

describe("tons de moderação", () => {
  it("distingue os quatro estados sem depender só da cor", () => {
    expect(moderationTone("approved")).toBe("success");
    expect(moderationTone("pending")).toBe("warning");
    expect(moderationTone("rejected")).toBe("danger");
    expect(moderationTone("not_required")).toBe("neutral");
  });
});

describe("serialização Server → Client", () => {
  it("os resumos de local são estruturas simples", () => {
    const grouped = groupLocationsByScope([location("1", "A", "private")]);
    expect(structuredClone(grouped)).toEqual(grouped);
  });
});
