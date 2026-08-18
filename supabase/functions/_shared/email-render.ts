/**
 * Composição do email a partir da notificação histórica.
 *
 * Este ficheiro não sabe o que é HTTP, não sabe o que é o Resend e não toca na
 * base de dados. É por isso que pode ser testado com Vitest sem rede nenhuma —
 * e é por isso que a fuga de HTML é verificável linha a linha.
 *
 * Não há aqui nenhum acesso a Deno: o worker importa-o, e a suite de testes
 * também.
 */

/**
 * O CONTEÚDO VEM DO SNAPSHOT, E NUNCA DO ESTADO ATUAL.
 *
 * `subject` e `body` são o título e o corpo que a notificação guardou no
 * momento em que o facto aconteceu. Um aviso de "aula marcada para as 18:00"
 * continua a dizer 18:00 depois de a aula ser reagendada para as 20:00 — se o
 * email fosse reconstruído a partir da aula, o histórico deixava de ser
 * histórico.
 */
export type NotificationEmailInput = {
  subject: string;
  body: string;
  notifiedAt: string;
  siteUrl: string;
};

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

/**
 * Escapa os cinco caracteres que dão significado a HTML.
 *
 * O título de uma aula é texto livre escrito por uma pessoa. `Treino <b>` tem
 * de aparecer como `Treino <b>`, e não pôr o resto do email a negrito; e um
 * `<script>` tem de chegar como texto visível, nunca como código.
 *
 * `&` é substituído primeiro, senão as entidades produzidas pelas substituições
 * seguintes voltariam a ser escapadas — `<` daria `&amp;lt;` em vez de `&lt;`.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Normaliza a base do site: sem barra final, para que juntar `/aluno/perfil` não
 * produza `//aluno/perfil`.
 */
export function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl.trim().replace(/\/+$/, "");
}

/**
 * O assunto: prefixo fixo e o título do aviso.
 *
 * Sem identificadores, sem nome da organização, sem nome de pacote ou de
 * colegas — o assunto de um email é visível na pré-visualização do telemóvel de
 * quem quer que esteja a olhar para o ecrã.
 */
export function emailSubject(title: string): string {
  return `[AulaFlow] ${title.trim()}`;
}

/**
 * As duas versões do mesmo email.
 *
 * Os links apontam para rotas que EXISTEM. Não se inventa `/aluno/aulas/<id>`:
 * a área do aluno não tem página de detalhe por aula, e um link partido é pior
 * do que nenhum link. A caixa de avisos tem sempre o aviso completo.
 */
export function renderNotificationEmail(input: NotificationEmailInput): RenderedEmail {
  const site = normalizeSiteUrl(input.siteUrl);
  const inboxUrl = `${site}/aluno/notificacoes`;
  const preferencesUrl = `${site}/aluno/perfil`;

  const subject = emailSubject(input.subject);

  const text = [
    input.subject,
    "",
    input.body,
    "",
    `Ver na aplicação: ${inboxUrl}`,
    `Alterar preferências de avisos: ${preferencesUrl}`,
    "",
    "AulaFlow",
  ].join("\n");

  // HTML deliberadamente simples: sem imagens remotas, sem pixel de rastreio,
  // sem scripts e sem folhas de estilo externas. Um cliente de email que bloqueie
  // tudo isso continua a mostrar a mensagem inteira.
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
    'font-size:16px;line-height:1.6;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px">',
    `<h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(input.subject)}</h1>`,
    `<p style="margin:0 0 20px;white-space:pre-line">${escapeHtml(input.body)}</p>`,
    `<p style="margin:0 0 8px"><a href="${escapeHtml(inboxUrl)}" `,
    'style="color:#1d4ed8">Ver na aplicação</a></p>',
    `<p style="margin:0 0 20px;font-size:14px"><a href="${escapeHtml(preferencesUrl)}" `,
    'style="color:#6b7280">Alterar preferências de avisos</a></p>',
    '<p style="margin:0;font-size:13px;color:#6b7280">AulaFlow</p>',
    "</div>",
  ].join("");

  return { subject, text, html };
}
