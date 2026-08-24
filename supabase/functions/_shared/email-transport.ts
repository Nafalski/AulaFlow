/**
 * O transporte, e a leitura do que o fornecedor respondeu.
 *
 * Separado da composição e do SQL de propósito: classificar um 429 como "tentar
 * outra vez" e um 422 como "não insistas" é uma regra de negócio, e regras de
 * negócio testam-se sem rede. `classifyProviderResult()` é uma função pura; só
 * `sendEmailViaResend()` fala com o mundo.
 */

export type ProviderOutcome = "sent" | "retry" | "failed";

export type ProviderResult = {
  outcome: ProviderOutcome;
  messageId?: string;
  error?: string;
};

// Cinco pedidos sequenciais deste tamanho cabem folgadamente no lease de 300 s
// do worker. A relação completa vive e é testada em `handler.ts`.
export const PROVIDER_TIMEOUT_MS = 10_000;
const PROVIDER_TIMEOUT_ERROR = "provider request timed out";

/**
 * A chave de idempotência da entrega, estável em todas as tentativas.
 *
 * É a SEGUNDA defesa, não a primeira — a primeira é `unique (notification_id,
 * channel)` na base de dados. Esta cobre a janela em que o fornecedor aceitou a
 * mensagem e o worker morreu antes de conseguir gravar `sent`: a repetição
 * apresenta a mesma chave, e o fornecedor reconhece-a em vez de enviar outra vez.
 *
 * Gerar um UUID novo por tentativa destruiria exatamente essa proteção.
 */
/** O que o fornecedor vê nos registos dele. Nada de ambiente, versão ou conta. */
export const USER_AGENT = "AulaFlow/1.0";

export function providerIdempotencyKey(deliveryId: string): string {
  return `aulaflow-email/${deliveryId}`;
}

/**
 * O identificador de erro que o Resend devolve no corpo.
 *
 * Só se lê o campo estruturado. Procurar substrings numa mensagem escrita para
 * humanos é frágil de uma forma que não se nota logo: o fornecedor reescreve a
 * frase, e o worker passa a classificar mal sem nada falhar visivelmente.
 */
export function providerErrorName(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { name?: unknown; type?: unknown };
    if (typeof parsed.name === "string") return parsed.name;
    if (typeof parsed.type === "string") return parsed.type;
  } catch {
    return null;
  }
  return null;
}

/**
 * O que fazer com o que o fornecedor respondeu.
 *
 * - 2xx: aceite.
 * - 408/429 e 5xx: o problema é temporário — limite de ritmo, indisponibilidade,
 *   timeout. Vale a pena repetir.
 * - 4xx restantes: o pedido está errado e vai continuar errado. Endereço
 *   inválido, remetente não verificado, chave sem permissões — repetir cinco
 *   vezes não muda nenhuma dessas coisas, e só atrasa a fila.
 *
 * O 409 É O CASO EM QUE O ESTADO SOZINHO NÃO CHEGA.
 *
 * O Resend usa-o para duas situações opostas, e distingue-as pelo nome do erro:
 *
 *   `concurrent_idempotent_requests` — já há um pedido com esta chave a ser
 *   processado. É transitório por definição: daqui a pouco terá acabado, e a
 *   chave estável faz o fornecedor reconhecê-lo. RETRY.
 *
 *   `invalid_idempotent_request` — a mesma chave foi usada com um corpo
 *   diferente. Repetir manda exatamente o mesmo corpo diferente, e o fornecedor
 *   volta a recusar. Cinco vezes seguidas seria gastar tentativas a confirmar o
 *   que já se sabe. FAILED.
 *
 * Um 409 que não seja nenhum dos dois é tratado como transitório: a incerteza
 * aqui é sobre concorrência, e um atraso custa menos do que dar por perdida uma
 * mensagem que ainda podia sair. O limite de cinco tentativas continua a impedir
 * que isso se torne um ciclo infinito.
 */
export function classifyProviderResult(status: number, errorName?: string | null): ProviderOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 408 || status === 429) return "retry";
  if (status >= 500) return "retry";

  if (status === 409) {
    return errorName === "invalid_idempotent_request" ? "failed" : "retry";
  }

  return "failed";
}

/**
 * Uma falha de rede nunca é resposta: não houve status nenhum. Não se sabe
 * sequer se o fornecedor recebeu o pedido — e é por isso que se repete com a
 * mesma chave de idempotência, em vez de assumir que não chegou.
 */
export function networkFailureResult(message: string): ProviderResult {
  return { outcome: "retry", error: sanitizeProviderError(message) };
}

/**
 * O erro que fica gravado é curto e sem segredos.
 *
 * A resposta do fornecedor pode trazer eco do pedido; guardar tudo arriscaria
 * escrever cabeçalhos de autorização na base de dados. Guarda-se o suficiente
 * para diagnosticar, e mais nada.
 */
export function sanitizeProviderError(raw: string): string {
  return raw
    .replace(/re_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export type ResendRequest = {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

/** O `fetch` é injetado para que os testes possam exercer 200, 429, 500 e falha de rede. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Chamada HTTP direta, sem a biblioteca do fornecedor.
 *
 * É um POST com um JSON. Trazer um SDK inteiro para isto acrescentaria uma
 * dependência ao bundle e uma superfície de atualização, sem tirar nenhuma
 * decisão das nossas mãos.
 */
export async function sendEmailViaResend(
  request: ResendRequest,
  fetchImpl: FetchLike,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<ProviderResult> {
  let response: Response;
  const controller = new AbortController();
  const boundedTimeoutMs = Math.max(1, Math.min(timeoutMs, PROVIDER_TIMEOUT_MS));
  const timeout = setTimeout(() => controller.abort(), boundedTimeoutMs);

  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": request.idempotencyKey,
        // Explícito, estável e anónimo. O runtime acrescentaria algo por sua
        // conta, mas isso mudaria com a versão do Deno e não identificaria o
        // AulaFlow — e é o AulaFlow que o fornecedor vê nos seus registos.
        // Sem versão de ambiente, sem identificadores, sem dados pessoais.
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
      body: JSON.stringify({
        from: request.from,
        to: [request.to],
        subject: request.subject,
        text: request.text,
        html: request.html,
      }),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return networkFailureResult(PROVIDER_TIMEOUT_ERROR);
    }
    return networkFailureResult(error instanceof Error ? error.message : "network failure");
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text().catch(() => "");
  const outcome = classifyProviderResult(response.status, providerErrorName(raw));

  if (outcome !== "sent") {
    return { outcome, error: sanitizeProviderError(raw || `HTTP ${response.status}`) };
  }

  // Só o identificador da mensagem é guardado. A resposta inteira não acrescenta
  // nada que se possa vir a precisar, e é mais uma coisa a proteger.
  let messageId: string | undefined;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id === "string") messageId = parsed.id;
  } catch {
    messageId = undefined;
  }

  return { outcome: "sent", messageId };
}
