import { describe, expect, it, vi } from "vitest";

import { PROVIDER_TIMEOUT_MS } from "../_shared/email-transport.ts";
import {
  BATCH_SIZE,
  handleWorkerRequest,
  LEASE_RUNTIME_MARGIN_SECONDS,
  LEASE_SECONDS,
  MAX_SEQUENTIAL_PROVIDER_SECONDS,
  type ClaimedDelivery,
  type WorkerDependencies,
} from "./handler.ts";

const TOKEN = "token-de-teste";

const DELIVERY: ClaimedDelivery = {
  delivery_id: "11111111-1111-4111-8111-111111111111",
  lease_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  recipient_email: "aluno@example.com",
  subject: "Aula marcada",
  body: 'Tem a aula "Treino" em 20/08 às 18:00.',
  notified_at: "2026-08-18T10:00:00Z",
  attempts: 0,
};

function deps(overrides: Partial<WorkerDependencies> = {}): WorkerDependencies {
  return {
    config: {
      workerToken: TOKEN,
      apiKey: "re_chave",
      from: "avisos@aulaflow.example",
      siteUrl: "https://aulaflow.example",
    },
    claim: vi.fn().mockResolvedValue({ data: [], error: null }),
    send: vi.fn().mockResolvedValue({ outcome: "sent", messageId: "msg_1" }),
    finalize: vi.fn().mockResolvedValue({ data: "sent", error: null }),
    ...overrides,
  };
}

function post(headers: Record<string, string> = { "x-aulaflow-worker-token": TOKEN }) {
  return new Request("https://worker.example", { method: "POST", headers });
}

describe("autenticação da invocação", () => {
  it("um pedido que não é POST é recusado", async () => {
    const response = await handleWorkerRequest(
      new Request("https://worker.example", { method: "GET" }),
      deps(),
    );
    expect(response.status).toBe(405);
  });

  it("sem token, recusa", async () => {
    const response = await handleWorkerRequest(post({}), deps());
    expect(response.status).toBe(401);
  });

  it("com o token errado, recusa", async () => {
    const response = await handleWorkerRequest(
      post({ "x-aulaflow-worker-token": "outro" }),
      deps(),
    );
    expect(response.status).toBe(401);
  });

  it("sem o segredo configurado recusa TUDO, em vez de aceitar tudo", async () => {
    // O caso perigoso: se a comparação fosse feita sem verificar que o segredo
    // existe, um pedido sem cabeçalho apresentaria "" e passaria.
    const dependencies = deps();
    dependencies.config.workerToken = "";
    const response = await handleWorkerRequest(post({}), dependencies);
    expect(response.status).toBe(401);
  });

  it("um pedido recusado nunca chega a reclamar trabalho", async () => {
    const dependencies = deps();
    await handleWorkerRequest(post({}), dependencies);
    expect(dependencies.claim).not.toHaveBeenCalled();
  });
});

describe("fornecedor por configurar", () => {
  it("responde 503 e não reclama nada", async () => {
    const dependencies = deps();
    dependencies.config.apiKey = "";

    const response = await handleWorkerRequest(post(), dependencies);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "provider_not_configured", claimed: 0 });
    // Reclamar sem poder enviar poria as entregas a passear pelo arrendamento
    // sem nunca saírem.
    expect(dependencies.claim).not.toHaveBeenCalled();
  });

  it("o mesmo quando falta o remetente ou o URL do site", async () => {
    const semRemetente = deps();
    semRemetente.config.from = "";
    expect((await handleWorkerRequest(post(), semRemetente)).status).toBe(503);

    const semSite = deps();
    semSite.config.siteUrl = "";
    expect((await handleWorkerRequest(post(), semSite)).status).toBe(503);
  });
});

describe("o ciclo do worker", () => {
  it("lote vazio devolve um resumo a zeros", async () => {
    const response = await handleWorkerRequest(post(), deps());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      stale: 0,
    });
  });

  it("uma entrega aceite pelo fornecedor é fechada como enviada", async () => {
    const dependencies = deps({
      claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }),
    });

    const response = await handleWorkerRequest(post(), dependencies);

    expect(await response.json()).toEqual({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      stale: 0,
    });
    expect(dependencies.finalize).toHaveBeenCalledWith({
      deliveryId: DELIVERY.delivery_id,
      leaseToken: DELIVERY.lease_token,
      outcome: "sent",
      providerMessageId: "msg_1",
      error: null,
    });
  });

  it("o corpo enviado vem do aviso histórico, escapado, com os links certos", async () => {
    const send = vi.fn().mockResolvedValue({ outcome: "sent", messageId: "msg_1" });
    await handleWorkerRequest(
      post(),
      deps({
        claim: vi.fn().mockResolvedValue({
          data: [{ ...DELIVERY, subject: "Treino <script>x</script>" }],
          error: null,
        }),
        send,
      }),
    );

    const sent = send.mock.calls[0]?.[0];
    expect(sent.subject).toBe("[AulaFlow] Treino <script>x</script>");
    expect(sent.html).not.toContain("<script>");
    expect(sent.html).toContain("https://aulaflow.example/aluno/notificacoes");
    expect(sent.idempotencyKey).toBe(`aulaflow-email/${DELIVERY.delivery_id}`);
  });

  it("uma falha temporária é fechada como nova tentativa", async () => {
    const dependencies = deps({
      claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }),
      send: vi.fn().mockResolvedValue({ outcome: "retry", error: "HTTP 500" }),
      finalize: vi.fn().mockResolvedValue({ data: "retry", error: null }),
    });

    const response = await handleWorkerRequest(post(), dependencies);

    expect(await response.json()).toEqual({
      claimed: 1,
      sent: 0,
      retried: 1,
      failed: 0,
      stale: 0,
    });
    expect(dependencies.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "retry", error: "HTTP 500" }),
    );
  });

  it("uma falha definitiva é contada como falhada", async () => {
    const response = await handleWorkerRequest(
      post(),
      deps({
        claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }),
        send: vi.fn().mockResolvedValue({ outcome: "failed", error: "invalid recipient" }),
        finalize: vi.fn().mockResolvedValue({ data: "failed", error: null }),
      }),
    );
    expect(await response.json()).toEqual({
      claimed: 1,
      sent: 0,
      retried: 0,
      failed: 1,
      stale: 0,
    });
  });

  it("uma exceção no transporte não derruba o lote", async () => {
    const dependencies = deps({
      claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }),
      send: vi.fn().mockRejectedValue(new Error("boom")),
      finalize: vi.fn().mockResolvedValue({ data: "retry", error: null }),
    });

    const response = await handleWorkerRequest(post(), dependencies);

    expect(response.status).toBe(200);
    expect(dependencies.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "retry" }),
    );
  });

  it("uma entrega falhada não impede a seguinte de ser processada", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "failed", error: "invalid" })
      .mockResolvedValueOnce({ outcome: "sent", messageId: "msg_2" });
    const finalize = vi
      .fn()
      .mockResolvedValueOnce({ data: "failed", error: null })
      .mockResolvedValueOnce({ data: "sent", error: null });

    const response = await handleWorkerRequest(
      post(),
      deps({
        claim: vi.fn().mockResolvedValue({
          data: [DELIVERY, { ...DELIVERY, delivery_id: "22222222-2222-4222-8222-222222222222" }],
          error: null,
        }),
        send,
        finalize,
      }),
    );

    expect(await response.json()).toEqual({
      claimed: 2,
      sent: 1,
      retried: 0,
      failed: 1,
      stale: 0,
    });
  });

  it("um erro a reclamar responde 500 sem detalhes", async () => {
    const response = await handleWorkerRequest(
      post(),
      deps({
        claim: vi.fn().mockResolvedValue({ data: null, error: { message: "relation ... denied" } }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("relation");
  });
});

describe("falhar a FECHAR não é o fornecedor ter falhado", () => {
  it("não conta como enviada, nem como falhada", async () => {
    // Não se sabe o que aconteceu ao envio. Contá-lo como `failed` inventaria um
    // desfecho; a entrega fica protegida pelo arrendamento e é retomada depois.
    const response = await handleWorkerRequest(
      post(),
      deps({
        claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }),
        send: vi.fn().mockResolvedValue({ outcome: "sent", messageId: "msg_1" }),
        finalize: vi.fn().mockResolvedValue({ data: null, error: { message: "deadlock" } }),
      }),
    );

    expect(await response.json()).toEqual({
      claimed: 1,
      sent: 0,
      retried: 0,
      failed: 0,
      stale: 0,
    });
  });

  it("e não repete imediatamente o envio", async () => {
    const send = vi.fn().mockResolvedValue({ outcome: "sent", messageId: "msg_1" });
    await handleWorkerRequest(
      post(),
      deps({
        claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }),
        send,
        finalize: vi.fn().mockResolvedValue({ data: null, error: { message: "deadlock" } }),
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("a resposta nunca leva nada de privado", () => {
  it("não contém endereço, corpo, identificadores nem segredos", async () => {
    const response = await handleWorkerRequest(
      post(),
      deps({ claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }) }),
    );

    const text = await response.text();

    expect(text).not.toContain(DELIVERY.recipient_email);
    expect(text).not.toContain(DELIVERY.delivery_id);
    expect(text).not.toContain(DELIVERY.lease_token);
    expect(text).not.toContain(DELIVERY.subject);
    expect(text).not.toContain(DELIVERY.body);
    expect(text).not.toContain("re_chave");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("msg_1");
    expect(JSON.parse(text)).toEqual({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      stale: 0,
    });
  });

  it("nem sequer quando o fornecedor devolve um erro descritivo", async () => {
    const response = await handleWorkerRequest(
      post(),
      deps({
        claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }),
        send: vi.fn().mockResolvedValue({
          outcome: "failed",
          error: `endereço ${DELIVERY.recipient_email} inválido`,
        }),
        finalize: vi.fn().mockResolvedValue({ data: "failed", error: null }),
      }),
    );

    const text = await response.text();
    expect(text).not.toContain(DELIVERY.recipient_email);
    expect(text).not.toContain("inválido");
  });
});

describe("ownership do claim", () => {
  it("propaga exatamente o token que o PostgreSQL devolveu", async () => {
    const dependencies = deps({
      claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }),
    });

    await handleWorkerRequest(post(), dependencies);

    expect(dependencies.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: DELIVERY.delivery_id,
        leaseToken: DELIVERY.lease_token,
      }),
    );
  });

  it("mantém o token individual de duas deliveries", async () => {
    const second = {
      ...DELIVERY,
      delivery_id: "22222222-2222-4222-8222-222222222222",
      lease_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    const finalize = vi.fn().mockResolvedValue({ data: "sent", error: null });

    await handleWorkerRequest(
      post(),
      deps({
        claim: vi.fn().mockResolvedValue({ data: [DELIVERY, second], error: null }),
        finalize,
      }),
    );

    expect(finalize.mock.calls.map(([input]) => [input.deliveryId, input.leaseToken])).toEqual([
      [DELIVERY.delivery_id, DELIVERY.lease_token],
      [second.delivery_id, second.lease_token],
    ]);
  });

  it("trata stale_claim como concorrência normal e não inventa outcome", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleWorkerRequest(
      post(),
      deps({
        claim: vi.fn().mockResolvedValue({ data: [DELIVERY], error: null }),
        finalize: vi.fn().mockResolvedValue({ data: "stale_claim", error: null }),
      }),
    );

    expect(await response.json()).toEqual({
      claimed: 1,
      sent: 0,
      retried: 0,
      failed: 0,
      stale: 1,
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("limite temporal do lote", () => {
  it("mantém o pior I/O sequencial muito abaixo do lease", () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(10_000);
    expect(BATCH_SIZE).toBe(5);
    expect(LEASE_SECONDS).toBe(300);
    expect(MAX_SEQUENTIAL_PROVIDER_SECONDS).toBe(50);
    expect(LEASE_RUNTIME_MARGIN_SECONDS).toBe(250);
    expect(MAX_SEQUENTIAL_PROVIDER_SECONDS).toBeLessThan(LEASE_SECONDS);
  });
});
