# AulaFlow

Plataforma web *mobile-first* para gestão de aulas desportivas.
Professores marcam aulas, escolhem os alunos e registam presenças; os alunos veem as suas aulas e são avisados quando algo muda.

A começar pelo **beach tennis**, com arquitetura preparada para outras modalidades.

> **Estado:** Fases 1, 1.5, 2 e 3 concluídas; Fase 4 parcialmente concluída pelas **Etapas 1A, 1B e 1C**.
> Ajustes administrativos, histórico visual completo, aulas e calendário continuam nas etapas seguintes.

---

## Arranque

```bash
npm install
cp .env.example .env.local     # preencher com os dados do seu projeto Supabase
npm run db:link                # uma vez: indicar o project ref quando pedido
npm run db:push                # aplicar as migrações
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000).

Sem `.env.local`, a aplicação arranca na mesma e mostra um ecrã com os passos que faltam.

Instruções completas — incluindo a configuração do Supabase — em [`AGENTS.md`](AGENTS.md).

---

## O que já funciona

- Registo de professores e alunos, com confirmação por email
- Início de sessão, recuperação de acesso e definição de nova palavra-passe
- Perfis e definições de professor e aluno, com avatar por iniciais, contacto e avisos persistentes
- Perfil profissional do professor com nome público, apresentação, zona e modalidades
- Gestão de alunos com pesquisa/filtros, ficha sem conta obrigatória, estados, grupos e resumo de pacotes
- Preparação auditada da ligação futura por email confirmado, sem reativar códigos de convite nem fingir entrega de email
- Gestão de turmas, participantes, capacidade, modalidade e observações administrativas privadas
- Gestão dos locais próprios, consulta segura dos partilhados e política de cancelamento do professor com fallback da organização
- Gestão de modelos reutilizáveis de pacotes pelo professor, com pesquisa, filtros, criação, edição, ativação/desativação e duplicação
- Atribuição de pacotes a alunos ativos pelo professor, a partir de modelo ou pacote personalizado, com snapshot, origem administrativa e idempotência
- Consulta de pacotes atribuídos e saldos: separador próprio em `/professor/pacotes`, detalhe administrativo e `/aluno/pacotes` mobile-first
- Views seguras para a área do aluno, sem valor registado, origem administrativa, observações, autoria ou identificadores internos sensíveis
- Diretório administrativo com pesquisa, filtros, detalhe e bloqueio/reativação auditados
- Proteção de rotas por tipo de conta e revogação de acesso para contas bloqueadas
- Esquema atual da base de dados: 22 tabelas, Row Level Security em todas
- Pacotes, saldos disponíveis/reservados/utilizados e livro-razão append-only
- RPCs PostgreSQL para atribuir, reservar, consumir, libertar, reagendar, ajustar e corrigir créditos
- Regras e validação com 211 testes de unidade/regressão
- 268 verificações PostgreSQL sobre migrações, permissões, RLS, gestão, claim, modelos, atribuição, consulta e saldos
- Estrutura responsiva das áreas de professor, aluno e administração, com manifesto e ícones PWA

`/professor/pacotes` gere modelos reutilizáveis, abre a atribuição e consulta pacotes atribuídos. `/aluno/pacotes` mostra apenas os próprios pacotes e movimentos básicos. Ajustes administrativos e histórico visual completo ainda não estão concluídos.

Sem um bucket de Storage configurado, os avatares usam iniciais. Preparar a ligação de um aluno ainda não envia email sem um Supabase remoto; a interface identifica essa limitação. As preferências de email ficam guardadas, mas a entrega automática e os lembretes agendados pertencem à Fase 8.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript estrito · Tailwind CSS 4 · Supabase (PostgreSQL + Auth + RLS) · Zod · Vitest

## Comandos

```bash
npm run dev        # desenvolvimento
npm run check      # lint + typecheck + testes + db:verify + build
npm run test       # testes
npm run db:verify  # migrações limpas + integração PostgreSQL/RLS
npm run icons      # regenerar ícones PWA
npm run db:push    # aplicar migrações
```

## Documentação

| Ficheiro | Conteúdo |
|---|---|
| [`implementation_plan.md`](implementation_plan.md) | Arquitetura, modelo de dados, decisões técnicas e fases |
| [`AGENTS.md`](AGENTS.md) | Estrutura, convenções, comandos e configuração |
| [`.env.example`](.env.example) | Variáveis de ambiente necessárias |

## Fusos horários

O sistema trabalha em **Europe/Lisbon**. Os instantes são guardados em UTC e convertidos apenas ao mostrar e ao ler entrada do utilizador — `src/lib/datetime.ts` é o único helper de conversão usado pela aplicação.
