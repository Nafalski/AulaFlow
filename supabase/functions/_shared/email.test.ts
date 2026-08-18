import { describe, expect, it, vi } from "vitest";

import {
  emailSubject,
  escapeHtml,
  normalizeSiteUrl,
  renderNotificationEmail,
} from "./email-render.ts";
import {
  classifyProviderResult,
  networkFailureResult,
  providerIdempotencyKey,
  sanitizeProviderError,
  sendEmailViaResend,
} from "./email-transport.ts";

describe("escapeHtml", () => {
  it("escapa os cinco caracteres com significado em HTML", () => {
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  it("escapa o & primeiro, senão as entidades voltavam a ser escapadas", () => {
    // A ordem errada daria "&amp;lt;" — visível como texto "&lt;" em vez de "<".
    expect(escapeHtml("<")).not.toContain("&amp;lt;");
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
  });
});

describe("renderNotificationEmail", () => {
  const base = {
    subject: "Aula marcada",
    body: 'Tem a aula "Treino" em 20/08 às 18:00.',
    notifiedAt: "2026-08-18T10:00:00Z",
    siteUrl: "https://aulaflow.example",
  };

  it("um título com script chega como texto, nunca como código", () => {
    const rendered = renderNotificationEmail({
      ...base,
      subject: "Treino <script>alert(1)</script>",
    });

    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // A versão de texto não é HTML: não precisa de fuga, e escapá-la faria
    // aparecer "&lt;" a quem lê o email em texto simples.
    expect(rendered.text).toContain("<script>alert(1)</script>");
  });

  it("um corpo com aspas e & não parte o atributo nem a entidade", () => {
    const rendered = renderNotificationEmail({
      ...base,
      body: `Aula "Padel & Ténis" do 'Clube' <b>hoje</b>`,
    });

    expect(rendered.html).toContain("&quot;Padel &amp; T");
    expect(rendered.html).toContain("&#39;Clube&#39;");
    expect(rendered.html).toContain("&lt;b&gt;hoje&lt;/b&gt;");
    expect(rendered.html).not.toContain("<b>hoje</b>");
  });

  it("o assunto leva o prefixo e mais nada", () => {
    expect(emailSubject("Aula cancelada")).toBe("[AulaFlow] Aula cancelada");
  });

  it("os links apontam para rotas que existem e não levam token", () => {
    const rendered = renderNotificationEmail(base);

    expect(rendered.html).toContain("https://aulaflow.example/aluno/notificacoes");
    expect(rendered.html).toContain("https://aulaflow.example/aluno/perfil");
    expect(rendered.text).toContain("https://aulaflow.example/aluno/notificacoes");
    expect(rendered.html).not.toMatch(/token|secret|key=/i);
  });

  it("a barra final da base do site não produz um duplo //", () => {
    expect(normalizeSiteUrl("https://aulaflow.example/")).toBe("https://aulaflow.example");
    const rendered = renderNotificationEmail({ ...base, siteUrl: "https://aulaflow.example///" });
    expect(rendered.text).toContain("https://aulaflow.example/aluno/perfil");
    expect(rendered.text).not.toContain("example//aluno");
  });

  it("não traz imagens remotas, pixel de rastreio nem scripts", () => {
    const rendered = renderNotificationEmail(base);
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).not.toContain("<script");
    expect(rendered.html).not.toContain("http://");
  });
});

describe("classifyProviderResult", () => {
  it("2xx é aceite", () => {
    expect(classifyProviderResult(200)).toBe("sent");
    expect(classifyProviderResult(201)).toBe("sent");
  });

  it("limite de ritmo e indisponibilidade voltam a ser tentados", () => {
    expect(classifyProviderResult(408)).toBe("retry");
    expect(classifyProviderResult(429)).toBe("retry");
    expect(classifyProviderResult(500)).toBe("retry");
    expect(classifyProviderResult(503)).toBe("retry");
  });

  it("um pedido inequivocamente errado não melhora com repetição", () => {
    expect(classifyProviderResult(400)).toBe("failed");
    expect(classifyProviderResult(401)).toBe("failed");
    expect(classifyProviderResult(422)).toBe("failed");
  });
});

describe("sanitizeProviderError", () => {
  it("nunca deixa uma chave do fornecedor ficar gravada", () => {
    const clean = sanitizeProviderError("bad key re_abc123DEF456ghi used");
    expect(clean).not.toContain("re_abc123DEF456ghi");
    expect(clean).toContain("[redacted]");
  });

  it("nunca deixa um cabeçalho de autorização ficar gravado", () => {
    const clean = sanitizeProviderError("Authorization: Bearer sk-super-secret-value");
    expect(clean).not.toContain("sk-super-secret-value");
  });

  it("é curto: a coluna serve para diagnosticar, não para arquivar", () => {
    expect(sanitizeProviderError("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});

describe("providerIdempotencyKey", () => {
  it("é estável para a mesma entrega", () => {
    const id = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    expect(providerIdempotencyKey(id)).toBe(providerIdempotencyKey(id));
    expect(providerIdempotencyKey(id)).toBe(`aulaflow-email/${id}`);
  });

  it("distingue entregas diferentes", () => {
    expect(providerIdempotencyKey("a")).not.toBe(providerIdempotencyKey("b"));
  });
});

describe("sendEmailViaResend", () => {
  const request = {
    apiKey: "re_test_key",
    from: "avisos@aulaflow.example",
    to: "aluno@example.com",
    subject: "[AulaFlow] Aula marcada",
    text: "corpo",
    html: "<p>corpo</p>",
    idempotencyKey: "aulaflow-email/abc",
  };

  it("aceite: guarda o identificador devolvido", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }),
    );

    const result = await sendEmailViaResend(request, fetchImpl);

    expect(result.outcome).toBe("sent");
    expect(result.messageId).toBe("msg_123");
  });

  it("envia a chave de idempotência no cabeçalho", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );

    await sendEmailViaResend(request, fetchImpl);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "aulaflow-email/abc",
    );
  });

  it("429 volta a ser tentado", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    const result = await sendEmailViaResend(request, fetchImpl);
    expect(result.outcome).toBe("retry");
  });

  it("500 volta a ser tentado", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const result = await sendEmailViaResend(request, fetchImpl);
    expect(result.outcome).toBe("retry");
  });

  it("uma falha de rede volta a ser tentada, porque não se sabe se chegou", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const result = await sendEmailViaResend(request, fetchImpl);
    expect(result.outcome).toBe("retry");
    expect(result.error).toContain("ECONNRESET");
  });

  it("422 é definitivo", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid recipient" }), { status: 422 }),
    );
    const result = await sendEmailViaResend(request, fetchImpl);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("invalid recipient");
  });

  it("um erro do fornecedor com a chave lá dentro não é gravado em bruto", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("invalid key re_live_ABCDEFGH1234", { status: 401 }),
    );
    const result = await sendEmailViaResend(request, fetchImpl);
    expect(result.error).not.toContain("re_live_ABCDEFGH1234");
  });

  it("uma resposta 200 sem JSON válido continua a ser um envio aceite", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const result = await sendEmailViaResend(request, fetchImpl);
    expect(result.outcome).toBe("sent");
    expect(result.messageId).toBeUndefined();
  });

  it("networkFailureResult sanitiza a mensagem", () => {
    const result = networkFailureResult("Bearer abcdefghijk failed");
    expect(result.outcome).toBe("retry");
    expect(result.error).not.toContain("abcdefghijk");
  });
});
