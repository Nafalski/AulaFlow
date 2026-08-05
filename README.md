# AulaFlow

Plataforma web *mobile-first* para gestão de aulas desportivas.
Professores marcam aulas, escolhem os alunos e registam presenças; os alunos veem as suas aulas e são avisados quando algo muda.

A começar pelo **beach tennis**, com arquitetura preparada para outras modalidades.

> **Estado:** Fases 1, 1.5, 2, 3 e 4 concluídas. A Fase 5 tem as Etapas 5A, 5B e 5B.1: fonte de verdade da disponibilidade, projeção segura e calendário visual refinado em dia/semana/mês.
> Clubes, criação de aulas, transferência/fusão de pacotes e reservas de créditos continuam nas etapas seguintes.

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
- Ajustes administrativos de pacotes: adicionar/remover créditos disponíveis, suspender, reativar, cancelar, corrigir datas e corrigir movimentações por operação compensatória
- Histórico completo em `/professor/pacotes/historico`, unindo livro-razão de créditos e eventos administrativos sem expor detalhes privados ao aluno
- Disponibilidade do professor em `/professor/definicoes/disponibilidade`: horários semanais, intervalos por separação de períodos, exceções por data, bloqueios privados, duração padrão e intervalo mínimo
- Calendários de disponibilidade em `/professor/calendario` e `/aluno/calendario`, com vistas Dia/Semana/Mês, semana em linha temporal no desktop, mês sem coluna de horas e mobile adaptado; o aluno recebe só data, hora e estado do próprio professor
- Views seguras para a área do aluno, sem valor registado, origem administrativa, observações, autoria ou identificadores internos sensíveis
- RPCs seguras de disponibilidade: professor vê detalhes dos próprios bloqueios; aluno não recebe motivo, categoria, fonte interna, organização nem `teacher_id`
- Diretório administrativo com pesquisa, filtros, detalhe e bloqueio/reativação auditados
- Proteção de rotas por tipo de conta e revogação de acesso para contas bloqueadas
- Esquema atual da base de dados: 26 tabelas, Row Level Security em todas
- Pacotes, saldos disponíveis/reservados/utilizados e livro-razão append-only
- RPCs PostgreSQL para atribuir, reservar, consumir, libertar, reagendar, ajustar e corrigir créditos
- RPCs PostgreSQL para guardar preferências, horários semanais, exceções, bloqueios e resolução segura de disponibilidade
- Regras e validação com 260 testes de unidade/regressão
- 336 verificações PostgreSQL sobre migrações, permissões, RLS, gestão, claim, modelos, atribuição, consulta, ajustes administrativos, disponibilidade, calendário seguro, grants de views e saldos
- 90 verificações Auth/PostgREST reais no Supabase de desenvolvimento
- Estrutura responsiva das áreas de professor, aluno e administração, com manifesto e ícones PWA

`/professor/pacotes` gere modelos reutilizáveis, atribuição, consulta e ajustes administrativos dos pacotes atribuídos. `/professor/pacotes/historico` mostra a auditoria global. `/professor/definicoes/disponibilidade` guarda a fonte de verdade da agenda do professor. `/professor/calendario` e `/aluno/calendario` mostram disponibilidade calculada em Dia/Semana/Mês; ainda não criam aulas. `/aluno/pacotes` mostra apenas os próprios pacotes e movimentos básicos.

O próximo passo planeado da Fase 5 é a **Etapa 5B.2 — clubes e calendário compartilhado**. Clubes ainda não foram implementados; o professor independente continua totalmente suportado com agenda privada.

Sem um bucket de Storage configurado, os avatares usam iniciais. Preparar a ligação de um aluno ainda não envia email sem um Supabase remoto; a interface identifica essa limitação. As preferências de email ficam guardadas, mas a entrega automática e os lembretes agendados pertencem à Fase 8.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript estrito · Tailwind CSS 4 · Supabase (PostgreSQL + Auth + RLS) · Zod · Vitest

## Comandos

```bash
npm run dev        # desenvolvimento
npm run check      # lint + typecheck + testes + db:verify + build
npm run test       # testes
npm run db:verify  # migrações limpas + integração PostgreSQL/RLS
npm run db:verify:remote -- --confirm-development
npm run db:setup:e2e -- --confirm-development
npm run db:verify:auth -- --confirm-development
npm run icons      # regenerar ícones PWA
npm run db:push    # aplicar migrações
```

Para repetir o E2E real com Auth/PostgREST, preencha localmente `.env.local` com `SUPABASE_SERVICE_ROLE_KEY` e credenciais `E2E_*`, depois execute:

```bash
npm run db:setup:e2e -- --confirm-development
npm run db:verify:auth -- --confirm-development
```

Confirme também no painel Supabase que o provider Email está ativo, a confirmação de email está ligada, o Site URL é `http://localhost:3000` e a Redirect URL inclui `http://localhost:3000/auth/callback`.

## Documentação

| Ficheiro | Conteúdo |
|---|---|
| [`implementation_plan.md`](implementation_plan.md) | Arquitetura, modelo de dados, decisões técnicas e fases |
| [`AGENTS.md`](AGENTS.md) | Estrutura, convenções, comandos e configuração |
| [`.env.example`](.env.example) | Variáveis de ambiente necessárias |

## Fusos horários

O sistema trabalha em **Europe/Lisbon**. Os instantes são guardados em UTC e convertidos apenas ao mostrar e ao ler entrada do utilizador — `src/lib/datetime.ts` é o único helper de conversão usado pela aplicação.
