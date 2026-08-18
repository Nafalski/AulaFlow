# AulaFlow

Plataforma web *mobile-first* para gestão de aulas desportivas.
Professores configuram alunos, pacotes, disponibilidade, locais e aulas; os alunos veem as suas aulas e o próprio estado de crédito.

A começar pelo **beach tennis**, com arquitetura preparada para outras modalidades.

> **Estado:** Fases 1, 1.5, 2, 3, 4 e 5 concluídas. A Fase 6A acrescentou presença e conclusão segura da aula; a Fase 6B acrescenta cancelamento de aula, cancelamento de participação em turma e falta/no-show com destino financeiro seguro.
> A **Etapa 6C.1** acrescenta o contrato transacional de reagendamento: a aula original fica histórica, a substituta herda participantes e reserva, e nenhum saldo se move. A **Etapa 6C.2** liga-o à aplicação e separa as duas intenções: editar muda conteúdo (título e observações), reagendar muda a colocação (data, hora, local, campo) e deixa rasto. A duração é preservada, e o reagendamento afeta apenas esta ocorrência. Reagendamento pelo aluno e alteração de série inteira continuam por implementar.
> A **Fase 7** está concluída. Ao criar uma aula, o professor pode pedir confirmação aos participantes; o aluno vê o pedido na sua área e responde pela sua própria participação. Confirmar é RSVP — responde a "vou a esta aula", nunca a "estive nesta aula" — por isso não escreve presença nem move créditos. Numa série, cada aula é confirmada à parte; ao reagendar, a resposta já dada acompanha a aula nova. Dizer que não vai, self-cancel e notificações continuam por implementar, e nenhum email ou push é enviado.
> Self-service de cancelamento do aluno, política configurável de janelas, notificações, pagamentos e transferência/fusão de pacotes continuam nas etapas seguintes.

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
- Criação de aulas em `/professor/aulas/nova`, com aluno ou turma, contexto pessoal ou de clube, local, campo, data, hora e duração — validadas contra a disponibilidade, bloqueios, intervalo mínimo, aulas ativas do professor e ocupação do recurso físico
- Em `/professor/aulas/[id]`, **editar** muda título e observações; **reagendar**, em `/professor/aulas/[id]/reagendar`, muda data, hora, local e campo com motivo, preserva a duração e afeta apenas aquela ocorrência
- Ao criar uma aula, o Supabase seleciona um pacote válido e reserva créditos na mesma transação; em turma, se algum aluno não tiver saldo, a criação inteira é desfeita
- Criação de séries semanais de 2 a 12 aulas, sempre por hora civil `Europe/Lisbon`: a hora local é preservada ao atravessar mudança de horário, cada ocorrência é uma aula real, e qualquer falha de disponibilidade, conflito ou crédito desfaz a série inteira
- Aulas de turma fixam os alunos no momento da criação: alterar a turma depois não altera quem estava previsto
- Presença, falta/no-show, conclusão e cancelamento em `/professor/aulas/[id]`: só o professor responsável opera a aula, marca presença depois do início, marca falta depois do fim, cancela a aula inteira, cancela participação de turma antes do início e conclui depois do fim; turma é tudo-ou-nada
- Aula cancelada pelo professor e participação de turma cancelada devolvem reservas (`reserved -> available`); presença e falta/no-show consomem na conclusão (`reserved -> used`); participante não confirmado bloqueia conclusão
- Aulas concluídas e canceladas continuam no calendário do professor e do aluno, com estado próprio; o aluno vê hora, professor, modalidade, local, campo, a própria presença/falta/participação e o próprio estado de crédito, nunca os colegas, a turma, o custo, o ID do pacote ou saldos internos
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
- Esquema atual da base de dados: 29 tabelas, Row Level Security em todas; aulas, participantes, presença, falta, cancelamento e conclusão escritos apenas por RPC, com trigger de conflitos na tabela `lessons`, reserva de créditos na criação, devolução no cancelamento e consumo na conclusão
- Pacotes, saldos disponíveis/reservados/utilizados e livro-razão append-only
- RPCs PostgreSQL para atribuir, reservar, consumir, libertar, reagendar, ajustar e corrigir créditos
- RPCs PostgreSQL para guardar preferências, horários semanais, exceções, bloqueios e resolução segura de disponibilidade
- Regras e validação com testes de unidade/regressão para domínio, Zod, interface e mensagens
- Verificações PostgreSQL sobre migrações, permissões, RLS, gestão, claim, modelos, atribuição, consulta, ajustes administrativos, disponibilidade, calendário seguro, clubes, memberships, locais, recursos, criação/edição de aulas, conflitos, reserva, recorrência, presença, falta/no-show, cancelamento, conclusão, ledger, grants e saldos
- Verificações Auth/PostgREST reais no Supabase de desenvolvimento, incluindo concorrência de conclusão/cancelamento e privacidade das projeções
- Estrutura responsiva das áreas de professor, aluno e administração, com manifesto e ícones PWA

`/professor/clubes` gere contextos, clubes e membros; `/professor/clubes/[id]/calendario` mostra a disponibilidade partilhada do clube; `/professor/convites` mostra os convites recebidos. `/professor/pacotes` gere modelos reutilizáveis, atribuição, consulta e ajustes administrativos dos pacotes atribuídos. `/professor/pacotes/historico` mostra a auditoria global. `/professor/definicoes/disponibilidade` guarda a fonte de verdade da agenda do professor. `/professor/calendario` e `/aluno/calendario` mostram disponibilidade e aulas em Dia/Semana/Mês. `/aluno/pacotes` mostra apenas os próprios pacotes e movimentos básicos.

A **Etapa 8A** ligou a fundação de notificações que existia desde a Fase 1: marcar, reagendar ou cancelar uma aula deixa um aviso na caixa do aluno, com o horário do momento em que aconteceu. Os avisos marcam-se como lidos e o sino mostra quantos faltam. **Nenhum email, push ou WhatsApp é enviado** — a entrega externa é a 8C, e o agendador de lembretes, saldo baixo e expiração é a 8B. O professor independente continua totalmente suportado, com workspace pessoal privado e agenda própria, e não precisa criar clube nenhum.

Entrar num clube **não** partilha a agenda: `calendar_sharing_enabled` nasce desativado e só o próprio membro o altera — proprietários, gestores e a administração da plataforma não têm caminho para forçar a partilha de outra pessoa. Os locais e os seus campos já são partilhados com o clube; alunos, pacotes, turmas e disponibilidade continuam ligados ao workspace pessoal, e a interface diz isso explicitamente em vez de o esconder.

Criar ou reagendar uma aula impede sobreposição de aulas ativas do professor, respeita o intervalo mínimo e impede duas aulas no mesmo campo/sala ao mesmo horário. Ao criar, os créditos ficam reservados; ao reagendar, a reserva é transferida para a aula nova sem nova cobrança e a validade do pacote é revalidada na data nova. Editar uma aula não mexe na colocação: `update_lesson()` recusa qualquer tentativa de mudar data, hora, local ou campo. Depois do início, o professor pode confirmar presença; depois do fim, pode marcar falta/no-show e concluir a aula quando todos os participantes ativos tiverem desfecho. Cancelar aula ou participação de turma devolve reservas; concluir presença ou falta consome reservas exatamente uma vez. Numa série semanal, editar, reagendar, concluir ou cancelar a página de uma aula altera apenas aquela ocorrência; não existe ainda edição, reagendamento ou cancelamento de série inteira.

Ainda não existe política configurável de cancelamento, janela de 12h/24h, cancelamento self-service do aluno, reativação de participação cancelada, notificações nem pagamentos.

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
