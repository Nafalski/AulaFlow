import type { MetadataRoute } from "next";

/**
 * Manifesto da PWA.
 *
 * O Next serve isto em `/manifest.webmanifest` e injeta o `<link>` no
 * documento automaticamente — não é preciso acrescentá-lo ao layout.
 *
 * O alvo principal é a área do aluno: um aluno que consulta a próxima aula
 * duas vezes por semana beneficia de ter o AulaFlow no ecrã inicial em vez de
 * procurar um separador do browser. Instalar continua a ser a MESMA aplicação
 * Next, com a mesma base de dados e a mesma autenticação — não há build
 * separada nem código duplicado.
 *
 * `start_url` aponta para `/inicio`, que encaminha conforme o papel. Assim, a
 * mesma instalação serve alunos e professores, e ninguém aterra na área
 * errada.
 *
 * NESTA FASE não há service worker: nada funciona offline, e é intencional.
 * Saldos, créditos e presenças exigem sempre o servidor — um crédito
 * reservado a partir de dados em cache seria um crédito gasto duas vezes.
 * A estrutura fica pronta para notificações push, que chegam na Fase 8.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AulaFlow — gestão de aulas desportivas",
    short_name: "AulaFlow",
    description:
      "As suas aulas, horários e créditos num só sítio. Para professores e alunos de desporto.",
    start_url: "/inicio",
    scope: "/",
    display: "standalone",
    background_color: "#f7f1e8",
    theme_color: "#0e7c86",
    lang: "pt-PT",
    dir: "ltr",
    categories: ["sports", "productivity", "education"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        // O Android recorta os ícones instalados em círculo. Sem uma versão
        // com margem, a onda do logótipo ficaria cortada.
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
