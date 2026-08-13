# AulaFlow

Plataforma web *mobile-first* para gestão de aulas desportivas.
Professores marcam aulas, escolhem os alunos e registam presenças; os alunos veem as suas aulas e são avisados quando algo muda.

A começar pelo **beach tennis**, com arquitetura preparada para outras modalidades.

> **Estado:** Fases 1, 1.5, 2, 3 e 4 concluídas. A Fase 5 tem as Etapas 5A a 5D.2: disponibilidade, projeção segura, calendário visual refinado, clubes/workspaces/membros, calendário partilhado com consentimento, locais com moradas manuais, campos/salas/áreas, criação/edição de aulas, conflitos atómicos de professor/recurso e reserva atómica de créditos.
> A recorrência e a transferência/fusão de pacotes continuam nas etapas seguintes.

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
- Locais privados, de clube e propostas públicas em `/professor/locais`, com morada escrita à mão e assumida como não validada por terceiros; moderação das propostas em `/admin/locais`
- Campos, salas e áreas de cada local, com tipo genérico, ordem de apresentação e desativação que preserva a linha; herdam a autorização do local
- Criação e edição de aulas em `/professor/aulas/nova` e `/professor/aulas/[id]`, com aluno ou turma, contexto pessoal ou de clube, local, campo, data, hora e duração — validadas contra a disponibilidade, bloqueios, intervalo mínimo, aulas ativas do professor e ocupação do recurso físico
- Ao criar uma aula, o Supabase seleciona um pacote válido e reserva créditos na mesma transação; em turma, se algum aluno não tiver saldo, a criação inteira é desfeita
- Aulas de turma fixam os alunos no momento da criação: alterar a turma depois não altera quem estava previsto
- Aulas marcadas aparecem no calendário do professor e no do aluno; o aluno vê hora, professor, modalidade, local, campo e o próprio estado de crédito, nunca os colegas, a turma, o custo, o ID do pacote ou saldos internos
- Política de cancelamento do professor com fallback da organização
- Gestão de modelos reutilizáveis de pacotes pelo professor, com pesquisa, filtros, criação, edição, ativação/desativação e duplicação
- Atribuição de pacotes a alunos ativos pelo professor, a partir de modelo ou pacote personalizado, com snapshot, origem administrativa e idempotência
- Consulta de pacotes atribuídos e saldos: separador próprio em `/professor/pacotes`, detalhe administrativo e `/aluno/pacotes` mobile-first
- Ajustes administrativos de pacotes: adicionar/remover créditos disponíveis, suspender, reativar, cancelar, corrigir datas e corrigir movimentações por operação compensatória
- Histórico completo em `/professor/pacotes/historico`, unindo livro-razão de créditos e eventos administrativos sem expor detalhes privados ao aluno
- Disponibilidade do professor em `/professor/definicoes/disponibilidade`: horários semanais, intervalos por separação de períodos, exceções por data, bloqueios privados, duração padrão e intervalo mínimo
- Calendários de disponibilidade em `/professor/calendario` e `/aluno/calendario`, com vistas Dia/Semana/Mês, semana em linha temporal no desktop, mês sem coluna de horas e mobile adaptado; o aluno recebe só data, hora e estado do próprio professor
- Clubes como workspaces partilhados em `/professor/clubes`: criação, papéis internos (proprietário, gestor, professor), convites por email confirmado, gestão de membros e seletor de contexto no shell
- Convites recebidos em `/professor/convites`, com aceitar e recusar; moderação de clubes em `/admin/clubes`, com suspender/reativar auditado que não apaga dados
- Calendário partilhado do clube em `/professor/clubes/[id]/calendario`, com Dia/Semana/Mês e filtro por professor: cada professor decide, clube a clube, se partilha a disponibilidade, e quem não partilha aparece como «Disponibilidade não partilhada»
- A projeção partilhada tem quatro estados: disponível, indisponível, fora do horário (espaço vazio, incluindo dias inteiros sem rotina) e disponibilidade não partilhada; um bloqueio pessoal de um colega aparece como faixa indisponível, sem nunca revelar motivo, categoria nem identificadores internos
- Views seguras para a área do aluno, sem valor registado, origem administrativa, observações, autoria ou identificadores internos sensíveis
- RPCs seguras de disponibilidade: professor vê detalhes dos próprios bloqueios; aluno não recebe motivo, categoria, fonte interna, organização nem `teacher_id`
- Diretório administrativo com pesquisa, filtros, detalhe e bloqueio/reativação auditados
- Proteção de rotas por tipo de conta e revogação de acesso para contas bloqueadas
- Esquema atual da base de dados: 29 tabelas, Row Level Security em todas; aulas e participantes escritos apenas por RPC, com trigger de conflitos na tabela `lessons` e reserva de créditos dentro da criação da aula
- Pacotes, saldos disponíveis/reservados/utilizados e livro-razão append-only
- RPCs PostgreSQL para atribuir, reservar, consumir, libertar, reagendar, ajustar e corrigir créditos
- RPCs PostgreSQL para guardar preferências, horários semanais, exceções, bloqueios e resolução segura de disponibilidade
- Regras e validação com 478 testes de unidade/regressão
- 676 verificações PostgreSQL sobre migrações, permissões, RLS, gestão, claim, modelos, atribuição, consulta, ajustes administrativos, disponibilidade, calendário seguro, clubes, memberships, convites, contexto ativo, consentimento de partilha, calendário partilhado, locais, recursos de locais, criação/edição de aulas, conflitos, reserva de créditos, grants de views e saldos
- 295 verificações Auth/PostgREST reais no Supabase de desenvolvimento
- Estrutura responsiva das áreas de professor, aluno e administração, com manifesto e ícones PWA

`/professor/clubes` gere contextos, clubes e membros; `/professor/clubes/[id]/calendario` mostra a disponibilidade partilhada do clube; `/professor/convites` mostra os convites recebidos. `/professor/pacotes` gere modelos reutilizáveis, atribuição, consulta e ajustes administrativos dos pacotes atribuídos. `/professor/pacotes/historico` mostra a auditoria global. `/professor/definicoes/disponibilidade` guarda a fonte de verdade da agenda do professor. `/professor/calendario` e `/aluno/calendario` mostram disponibilidade e aulas em Dia/Semana/Mês. `/aluno/pacotes` mostra apenas os próprios pacotes e movimentos básicos.

O próximo passo planeado da Fase 5 é continuar a **Etapa 5D** com recorrência e o ciclo operacional posterior das aulas. O professor independente continua totalmente suportado, com workspace pessoal privado e agenda própria, e não precisa criar clube nenhum.

Entrar num clube **não** partilha a agenda: `calendar_sharing_enabled` nasce desativado e só o próprio membro o altera — proprietários, gestores e a administração da plataforma não têm caminho para forçar a partilha de outra pessoa. Os locais e os seus campos já são partilhados com o clube; alunos, pacotes, turmas e disponibilidade continuam ligados ao workspace pessoal, e a interface diz isso explicitamente em vez de o esconder.

Criar ou editar uma aula impede sobreposição de aulas ativas do professor, respeita o intervalo mínimo e impede duas aulas no mesmo campo/sala ao mesmo horário. Ao criar, os créditos ficam reservados; ao editar horário/local/recurso, a reserva é mantida e a validade do pacote é revalidada quando a data muda.

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
