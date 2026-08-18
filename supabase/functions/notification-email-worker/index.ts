/**
 * AulaFlow — o worker que esvazia o outbox de email (Etapa 8C).
 *
 * É AQUI QUE VIVE A ÚNICA REDE DESTA FUNCIONALIDADE. O trigger que materializa a
 * entrega escreve uma linha e acaba; o agendador da 8B escreve linhas e acaba.
 * Nenhuma operação de domínio espera pelo fornecedor de email, e é por isso que
 * cancelar uma aula continua a funcionar com o Resend em baixo.
 *
 * O ciclo é sempre o mesmo: reclamar um lote, enviar, fechar o resultado. Cada
 * passo é uma transação curta, e o estado vive todo na base de dados — se este
 * processo morrer a meio, o arrendamento expira e outro worker continua.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

import { renderNotificationEmail } from "../_shared/email-render.ts";
import {
  providerIdempotencyKey,
  sendEmailViaResend,
  type ProviderResult,
} from "../_shared/email-transport.ts";

// Lote pequeno de propósito: uma invocação por minuto com 20 emails esvazia
// 1200 por hora, e um lote grande só serviria para uma invocação lenta segurar
// entregas que a seguinte podia já ter feito.
const BATCH_SIZE = 20;

// O arrendamento tem de ser mais longo do que a pior invocação plausível, senão
// um worker lento vê o seu próprio trabalho ser reclamado por outro. Cinco
// minutos para um lote de 20 é folgado.
const LEASE_SECONDS = 300;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
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
  // A comparação é feita depois de confirmar que o segredo existe: sem ele
  // configurado, a função recusa tudo em vez de aceitar tudo.
  const expectedToken = Deno.env.get("AULAFLOW_EMAIL_WORKER_TOKEN") ?? "";
  const presentedToken = request.headers.get("x-aulaflow-worker-token") ?? "";

  if (expectedToken.length === 0 || presentedToken !== expectedToken) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("AULAFLOW_EMAIL_FROM") ?? "";
  const siteUrl = Deno.env.get("AULAFLOW_SITE_URL") ?? "";

  if (!supabaseUrl || !serviceKey) {
    return json({ error: "worker_not_configured" }, 500);
  }

  // Sem fornecedor configurado a função não finge que enviou: não reclama nada,
  // e as entregas ficam pendentes até haver credencial. Marcar `failed` gastaria
  // as tentativas de mensagens que nunca chegaram a ser tentadas.
  if (!apiKey || !from || !siteUrl) {
    return json({ error: "provider_not_configured", claimed: 0 }, 503);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_email_deliveries", {
    p_batch_size: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (claimError) {
    // A mensagem do erro não vai na resposta: quem chama é o cron, não precisa
    // dela, e um erro de base de dados pode conter fragmentos de consulta.
    console.error("claim failed");
    return json({ error: "claim_failed" }, 500);
  }

  const batch = Array.isArray(claimed) ? claimed : [];
  const summary = { claimed: batch.length, sent: 0, retried: 0, failed: 0 };

  for (const delivery of batch) {
    const rendered = renderNotificationEmail({
      subject: delivery.subject,
      body: delivery.body,
      notifiedAt: delivery.notified_at,
      siteUrl,
    });

    let result: ProviderResult;
    try {
      result = await sendEmailViaResend(
        {
          apiKey,
          from,
          to: delivery.recipient_email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          // A MESMA CHAVE EM TODAS AS TENTATIVAS desta entrega. É o que impede
          // uma segunda mensagem quando o fornecedor aceitou e a confirmação se
          // perdeu no caminho de volta.
          idempotencyKey: providerIdempotencyKey(delivery.delivery_id),
        },
        fetch,
      );
    } catch (error) {
      result = { outcome: "retry", error: error instanceof Error ? error.message : "unknown" };
    }

    const { data: finalStatus } = await supabase.rpc("finalize_email_delivery", {
      p_delivery_id: delivery.delivery_id,
      p_outcome: result.outcome,
      p_provider_message_id: result.messageId ?? null,
      p_error: result.error ?? null,
    });

    if (finalStatus === "sent") summary.sent += 1;
    else if (finalStatus === "retry") summary.retried += 1;
    else summary.failed += 1;
  }

  // A resposta é um resumo, e só. Nenhum endereço, nenhum corpo, nenhum
  // identificador de aviso, nenhum segredo — quem invoca é um cron, e um
  // resumo é tudo o que lhe serve.
  return json(summary);
});
