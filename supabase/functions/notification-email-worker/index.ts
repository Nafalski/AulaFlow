/**
 * AulaFlow — o worker que esvazia o outbox de email (Etapa 8C).
 *
 * É AQUI QUE VIVE A ÚNICA REDE DESTA FUNCIONALIDADE. O trigger que materializa a
 * entrega escreve uma linha e acaba; o agendador da 8B escreve linhas e acaba.
 * Nenhuma operação de domínio espera pelo fornecedor de email, e é por isso que
 * cancelar uma aula continua a funcionar com o Resend em baixo.
 *
 * Este ficheiro não decide nada: lê o ambiente, cria o cliente e liga as
 * dependências reais ao `handleWorkerRequest()`. Toda a lógica — autenticação,
 * fornecedor por configurar, reclamar/enviar/fechar, privacidade da resposta —
 * vive em `handler.ts`, que é TypeScript puro e está coberto por testes.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

import { sendEmailViaResend } from "../_shared/email-transport.ts";
import {
  handleWorkerRequest,
  type ClaimedDelivery,
  type WorkerDependencies,
} from "./handler.ts";

Deno.serve(async (request: Request) => {
  const config = {
    workerToken: Deno.env.get("AULAFLOW_EMAIL_WORKER_TOKEN") ?? "",
    apiKey: Deno.env.get("RESEND_API_KEY") ?? "",
    from: Deno.env.get("AULAFLOW_EMAIL_FROM") ?? "",
    siteUrl: Deno.env.get("AULAFLOW_SITE_URL") ?? "",
  };

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "worker_not_configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const deps: WorkerDependencies = {
    config,
    claim: async (batchSize, leaseSeconds) => {
      const { data, error } = await supabase.rpc("claim_email_deliveries", {
        p_batch_size: batchSize,
        p_lease_seconds: leaseSeconds,
      });
      return { data: (data ?? null) as ClaimedDelivery[] | null, error };
    },
    send: (input) =>
      sendEmailViaResend(
        {
          apiKey: config.apiKey,
          from: config.from,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
          idempotencyKey: input.idempotencyKey,
        },
        fetch,
      ),
    finalize: async (input) => {
      const { data, error } = await supabase.rpc("finalize_email_delivery", {
        p_delivery_id: input.deliveryId,
        p_outcome: input.outcome,
        p_provider_message_id: input.providerMessageId,
        p_error: input.error,
      });
      return { data: (data ?? null) as string | null, error };
    },
  };

  return handleWorkerRequest(request, deps);
});
