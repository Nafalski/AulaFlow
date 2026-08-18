/**
 * O worker, sem Deno e sem rede.
 *
 * Tudo o que decide alguma coisa vive aqui: autenticação da invocação, o que
 * fazer quando o fornecedor não está configurado, a ordem reclamar → enviar →
 * fechar, e o que a resposta pode e não pode conter. As dependências entram por
 * parâmetro, e é por isso que o `index.ts` fica com quatro linhas de ligação e
 * este ficheiro fica coberto por testes que correm em segundos.
 *
 * NÃO É UMA CÓPIA DO WORKER PARA TESTES. É o worker; o `index.ts` só lhe dá as
 * dependências reais. Duas implementações divergiriam, e divergiriam no ramo que
 * ninguém exercita.
 */

import { renderNotificationEmail } from "../_shared/email-render.ts";
import {
  providerIdempotencyKey,
  type ProviderResult,
} from "../_shared/email-transport.ts";

/** Uma entrega reclamada, tal como `claim_email_deliveries()` a devolve. */
export type ClaimedDelivery = {
  delivery_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  notified_at: string;
  attempts: number;
};

export type WorkerConfig = {
  workerToken: string;
  apiKey: string;
  from: string;
  siteUrl: string;
};

export type WorkerDependencies = {
  config: WorkerConfig;
  claim: (batchSize: number, leaseSeconds: number) => Promise<
    { data: ClaimedDelivery[] | null; error: unknown }
  >;
  send: (input: {
    to: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
  }) => Promise<ProviderResult>;
  finalize: (input: {
    deliveryId: string;
    outcome: ProviderResult["outcome"];
    providerMessageId: string | null;
    error: string | null;
  }) => Promise<{ data: string | null; error: unknown }>;
};

// Lote pequeno de propósito: uma invocação por minuto com 20 emails esvazia
// 1200 por hora, e um lote grande só serviria para uma invocação lenta segurar
// entregas que a seguinte podia já ter feito.
export const BATCH_SIZE = 20;

// O arrendamento tem de ser mais longo do que a pior invocação plausível, senão
// um worker lento vê o seu próprio trabalho ser reclamado por outro.
export const LEASE_SECONDS = 300;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleWorkerRequest(
  request: Request,
  deps: WorkerDependencies,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // ── Autenticação da invocação ──
  //
  // A função corre com `verify_jwt = false`, porque quem a chama é o `pg_cron`
  // através de `pg_net` e não uma pessoa com sessão. O que a protege é um token
  // dedicado, num cabeçalho próprio — nunca no URL, que ficaria em registos de
  // acesso e no histórico do browser.
  //
  // O segredo é confirmado ANTES da comparação: sem ele configurado, a função
  // recusa tudo em vez de aceitar tudo, que é o que um `"" === ""` faria.
  const presented = request.headers.get("x-aulaflow-worker-token") ?? "";
  if (deps.config.workerToken.length === 0 || presented !== deps.config.workerToken) {
    return json({ error: "unauthorized" }, 401);
  }

  // Sem fornecedor configurado a função não finge que enviou, e sobretudo NÃO
  // RECLAMA: reclamar sem poder enviar poria as entregas a passear pelo
  // arrendamento sem nunca saírem. Ficam pendentes até haver credencial.
  if (!deps.config.apiKey || !deps.config.from || !deps.config.siteUrl) {
    return json({ error: "provider_not_configured", claimed: 0 }, 503);
  }

  const claimed = await deps.claim(BATCH_SIZE, LEASE_SECONDS);
  if (claimed.error) {
    // A mensagem do erro não vai na resposta: quem chama é o cron, não precisa
    // dela, e um erro de base de dados pode conter fragmentos de consulta.
    console.error("claim failed");
    return json({ error: "claim_failed" }, 500);
  }

  const batch = Array.isArray(claimed.data) ? claimed.data : [];
  const summary = { claimed: batch.length, sent: 0, retried: 0, failed: 0 };

  for (const delivery of batch) {
    const rendered = renderNotificationEmail({
      subject: delivery.subject,
      body: delivery.body,
      notifiedAt: delivery.notified_at,
      siteUrl: deps.config.siteUrl,
    });

    let result: ProviderResult;
    try {
      result = await deps.send({
        to: delivery.recipient_email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        // A MESMA CHAVE EM TODAS AS TENTATIVAS desta entrega. É o que impede
        // uma segunda mensagem quando o fornecedor aceitou e a confirmação se
        // perdeu no caminho de volta.
        idempotencyKey: providerIdempotencyKey(delivery.delivery_id),
      });
    } catch (error) {
      result = { outcome: "retry", error: error instanceof Error ? error.message : "unknown" };
    }

    const finalized = await deps.finalize({
      deliveryId: delivery.delivery_id,
      outcome: result.outcome,
      providerMessageId: result.messageId ?? null,
      error: result.error ?? null,
    });

    // FALHAR A FECHAR NÃO É O FORNECEDOR TER FALHADO.
    //
    // Se a base de dados recusar o `finalize`, não se sabe o que aconteceu ao
    // envio — e contá-lo como `failed` seria inventar um desfecho. A entrega
    // fica protegida pelo arrendamento: quando ele expirar, outra passagem
    // retoma-a, com a mesma chave de idempotência. Não se repete aqui, porque
    // repetir imediatamente é a forma mais rápida de transformar um problema
    // passageiro num ciclo.
    if (finalized.error) {
      console.error("finalize failed");
      continue;
    }

    if (finalized.data === "sent") summary.sent += 1;
    else if (finalized.data === "retry") summary.retried += 1;
    else if (finalized.data === "failed") summary.failed += 1;
  }

  // A resposta é um resumo, e só. Nenhum endereço, nenhum corpo, nenhum
  // identificador de aviso ou de entrega, nenhum segredo — quem invoca é um
  // cron, e um resumo é tudo o que lhe serve.
  return json(summary);
}
