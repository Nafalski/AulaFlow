# AulaFlow — Plano de Implementação

> Plataforma web para gestão de aulas desportivas, com pacotes e créditos.
> **Uma única aplicação Next.js**, com interfaces distintas por tipo de conta.
> Versão inicial focada em **beach tennis**, preparada para outras modalidades.

**Documento vivo.** Atualizado no fim de cada fase com o que foi realmente construído.

- **Estado atual:** Fases 1, 1.5, 2, 3 e 4 concluídas. A Fase 5 tem as **Etapas 5A, 5B, 5B.1, 5B.2A e 5B.2B** concluídas — disponibilidade, projeção segura, calendário visual refinado, fundação de clubes/workspaces/membros e calendário partilhado com consentimento. **Locais/campos (5B.3)** e a criação de aulas continuam pendentes.
- **Timezone do sistema:** `Europe/Lisbon`
- **Idioma da interface:** Português (pt-PT)

---

## 1. Análise da arquitetura existente

Esta secção responde às perguntas de revisão antes de qualquer alteração.

### 1.1 A arquitetura já suporta uma aplicação única com layouts por função?

**Sim, e era já esse o desenho.** Nada teve de ser recomeçado.

O que já existia e se mantém:

| Requisito | Como já estava resolvido |
|---|---|
| Um só projeto Next.js | Um `package.json`, um `next.config.ts`, um build |
| Uma só base de dados | Um projeto Supabase, um esquema `public` |
| Uma só autenticação | Supabase Auth + `proxy.ts`, comuns às três áreas |
| Encaminhamento por função | `/inicio` lê o papel e redireciona (`homePathForRole`) |
| Layouts distintos | `app/(marketing)/`, `app/(auth)/`, `app/professor/`, `app/aluno/`, `app/admin/`, cada um com o seu `layout.tsx` |
| Componentes partilhados | `components/ui/` usado pelas três áreas |
| Regras fora dos componentes | `lib/domain/` — funções puras, sem JSX |

O que **faltava** e foi acrescentado: a **densidade** de cada área. O `AppShell` aplicava `max-w-3xl` a toda a gente — estreito de mais para as tabelas do professor e largo de mais para o telemóvel do aluno. Passou a depender do papel.

### 1.2 Como o sistema trata aulas, participantes e permissões

**Aulas.** `lessons` guarda instantes em `timestamptz` (UTC), com `duration_minutes` como coluna gerada. O estado percorre um ciclo de vida de oito valores; os seis terminais nunca são apagados — não há GRANT de DELETE, não há policy de DELETE, e um trigger recusa. Reagendar preserva a aula original em `rescheduled` e cria uma nova, com referência nos dois sentidos.

**Participantes.** `lesson_participants` responde a "quem é suposto vir?" (`invited`/`confirmed`/`declined`/`removed`); `attendance` responde a "quem veio?". A separação já existia, e é o que permite medir quem confirma e depois falta.

**Permissões.** Quatro camadas, e nenhuma delas é esconder um botão:

1. `proxy.ts` — verificação otimista: há sessão?
2. Layouts de área — `requireRole()`, contra a base de dados
3. GRANTs por coluna — `profiles.role` e `profiles.status` não são escrevíveis pelo cliente
4. RLS — ativo nas 23 tabelas; policies explícitas onde há acesso de cliente e `default deny` na outbox interna

### 1.3 O que foi preciso alterar

| Alteração | Porquê | Dimensão |
|---|---|---|
| Larguras por função no `AppShell` | Professor ao computador, aluno ao telemóvel | 1 ficheiro |
| Rotas `/professor/pacotes` e `/aluno/pacotes` | Nova área funcional | 2 ficheiros |
| 4 tabelas + 5 enums + 7 RPCs de mutação e 1 seletor | Pacotes e créditos | 8 migrações |
| 7 colunas em `lesson_participants`, 1 em `lessons` | Cobrança individual por participação | 1 migração |
| `lib/domain/packages.ts` + testes | Decisões de política, testáveis | 2 ficheiros |
| Manifesto e ícones PWA | Base para instalação no ecrã inicial | manifesto, gerador e ícones |
| Perfis e definições | Conta privada, perfil profissional, preferências e segurança | páginas, componentes, validação e Actions |
| Administração básica | Pesquisa, filtros, detalhe e bloqueio/reativação | vistas seguras, RPC auditada e interface responsiva |
| Proteção de dados pessoais | Projeções seguras e GRANTs por coluna | 3 migrações incrementais |
| Gestão operacional da Fase 3 | Alunos, turmas, locais e política do professor | 3 migrações, Actions, schemas e interfaces responsivas |

**Nenhum segundo projeto foi criado.** A fundação foi acrescentada à aplicação existente; os ajustes posteriores abrangeram também navegação móvel, sessão, testes, tipos e documentação.

### 1.4 Rotas: porquê continuar em português

O pedido sugeria `/teacher/*`, `/student/*` e `/admin/*`, notando que os caminhos exatos não são obrigatórios desde que a separação seja clara.

**Mantivemos `/professor`, `/aluno` e `/admin`.** As rotas são visíveis ao utilizador e a interface é toda em pt-PT; misturar `/student/aulas` seria incoerente. A separação por área é exatamente a pedida, e renomear obrigaria a mexer em ~25 ficheiros e em toda a documentação sem ganho funcional.

A correspondência é direta:

| Sugerido | Neste projeto |
|---|---|
| `/teacher/dashboard` | `/professor` |
| `/teacher/calendar` | `/professor/calendario` |
| `/teacher/students` | `/professor/alunos` |
| `/teacher/groups` | `/professor/grupos` |
| `/teacher/locations` | `/professor/locais` |
| `/teacher/packages` | `/professor/pacotes` |
| `/teacher/settings` | `/professor/definicoes` |
| `/student/home` | `/aluno` |
| `/student/classes` · `/student/calendar` | `/aluno/calendario` |
| `/student/packages` | `/aluno/pacotes` |
| `/student/notifications` | `/aluno/notificacoes` |
| `/student/profile` | `/aluno/perfil` |
| `/admin/dashboard` · `/users` · `/teachers` | `/admin` · `/admin/utilizadores` · `/admin/professores` |

Se preferir os caminhos em inglês, a mudança é mecânica — renomear pastas e atualizar `nav-items.ts`.

---

## 2. Visão geral da arquitetura

```
┌──────────────────────────────────────────────────────────────────┐
│                      UMA APLICAÇÃO, TRÊS CARAS                   │
│                                                                  │
│   PROFESSOR              ALUNO                 ADMIN             │
│   desktop-first          mobile-first          listagens         │
│   max-w-7xl              max-w-2xl             max-w-6xl         │
│   tabelas, filtros       cartões, botões       contas            │
│                          grandes, PWA                            │
│                                                                  │
│   └──────────── mesmos componentes de components/ui/ ────────────┘
└───────────────┬──────────────────────────────────┬───────────────┘
                │ RSC payload                      │ Server Actions
                ▼                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                    NEXT.JS 16 — APP ROUTER (Vercel)              │
│                                                                  │
│  proxy.ts ......... renova sessão, protege rotas                 │
│  app/(marketing)   público: início, termos, privacidade          │
│  app/(auth)        entrar, criar conta, recuperar acesso         │
│  app/professor     alunos, turmas, locais, definições, PACOTES   │
│  app/aluno         aulas, calendário, CRÉDITOS, avisos           │
│  app/admin         professores, utilizadores                     │
│  app/manifest.ts   base PWA (manifesto + ícones)                  │
│                                                                  │
│  lib/domain/ ...... REGRAS PURAS — aulas, créditos, políticas    │
│  lib/validation/ .. schemas Zod, cliente + servidor              │
│  lib/supabase/ .... clientes server / client / proxy / admin     │
└───────────────────────────────┬──────────────────────────────────┘
                                │ PostgREST + GoTrue (cookies geridos por @supabase/ssr)
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                            SUPABASE                              │
│  23 tabelas · RLS ativo em todas · 18 enums                      │
│  RPCs de créditos (atribuir / reservar / libertar / consumir /   │
│  transferir / ajustar / corrigir)                                │
│  Livro-razão imutável de movimentações                           │
└──────────────────────────────────────────────────────────────────┘
```

### Princípio arquitetural central

**As decisões vivem em TypeScript puro; a integridade vive no PostgreSQL.**

| Camada | Responsabilidade | Testável com |
|---|---|---|
| `lib/domain/` | Que ações são válidas; que pacote sugerir; cobrar ou devolver | Vitest, sem base de dados |
| `lib/validation/` | Formato dos dados (Zod), cliente e servidor | Vitest |
| Server Actions | Orquestração: validar → decidir → chamar RPC → revalidar | Manual |
| Funções SQL | Atomicidade: reservar, libertar, consumir sem duplicar | `npm run db:verify` |
| RLS + constraints | Última linha: saldos negativos e acessos alheios impossíveis | `npm run db:verify` |

A divisão entre as duas últimas linhas e as primeiras não é duplicação. O PostgreSQL garante que um saldo nunca fica negativo, mas não sabe se a política do professor manda cobrar um cancelamento tardio, nem consegue explicar a decisão a uma pessoa. Isso vive em `lib/domain/`, onde é testável em milissegundos.

---

## 3. Stack tecnológica

| Camada | Tecnologia | Versão | Nota |
|---|---|---|---|
| Framework | Next.js (App Router) | 16.2.x | `proxy.ts` substitui `middleware.ts` |
| Runtime UI | React | 19.2.x | `useActionState` para formulários |
| Linguagem | TypeScript | 5.9.x | Estrito + `noUncheckedIndexedAccess`. Ver D-01 |
| Estilos | Tailwind CSS | 4.3.x | Configuração CSS-first via `@theme` |
| Base de dados | Supabase PostgreSQL | versão do projeto remoto por confirmar | RLS nativo |
| Autenticação | Supabase Auth + `@supabase/ssr` | 0.12.x | Cookies e renovação geridos pela biblioteca |
| Validação | Zod | 4.4.x | Um schema para cliente e servidor |
| Testes (unidade/regressão) | Vitest | 4.1.x | 260 testes |
| Testes (esquema) | PGlite | 0.5.x | PostgreSQL em WASM — ver D-14 |
| Ícones | lucide-react | 1.28.x | |
| Datas | date-fns + `@date-fns/tz` | 4.4.x | |

---

## 4. Modelo de dados

**23 tabelas.** As 16 da Fase 1, 4 de pacotes/créditos, `student_package_audit_events` para eventos administrativos de pacotes, `teacher_sports` para as modalidades N:N do perfil profissional e `student_invitations` para o estado administrativo — sem token — da ligação futura.

### 4.1 Núcleo de créditos

```
┌────────────────────┐
│ package_templates  │  "Pacote de 8 aulas" — modelo reutilizável
│ default_credits    │
└─────────┬──────────┘
          │ atribuir (COPIA as condições, não referencia)
          ▼
┌──────────────────────────────────────────┐
│           student_packages               │
│                                          │
│  initial_credits ... o que foi contratado│
│  credits_total ..... após ajustes        │
│  credits_available ┐                     │
│  credits_reserved  ├─ somam sempre total │
│  credits_used      ┘                     │
│  expires_on, status                      │
└───────┬──────────────────────┬───────────┘
        │ 1:N                  │ 1:N
        ▼                      ▼
┌───────────────────┐  ┌─────────────────────────────┐
│ lesson_           │  │ package_credit_transactions │
│ participants      │  │                             │
│                   │  │  LIVRO-RAZÃO IMUTÁVEL       │
│ student_package_id│  │  antes → depois das 3       │
│ credits_reserved  │  │  parcelas, motivo, autor    │
│ credits_consumed  │  │  Nunca alterado nem apagado │
│ billing_status    │  └─────────────────────────────┘
│ is_exception      │
└───────────────────┘

┌───────────────────────┐
│ cancellation_policies │  prazo, cobrar ou devolver
│ por organização ou    │  em atraso e em falta
│ por professor         │
└───────────────────────┘
```

### 4.2 O invariante que sustenta tudo

```sql
constraint student_packages_balance_adds_up
  check (credits_available + credits_reserved + credits_used = credits_total)
```

É esta constraint que torna impossível "arredondar" um saldo à mão. Para clientes autenticados, INSERT direto de pacotes e participantes cobrados e UPDATE de saldos estão revogados; as RPCs das migrações de créditos são o único caminho suportado e registam sempre a movimentação correspondente.

O requisito 15 diz: *"nunca altere apenas os números finais do pacote sem criar uma movimentação correspondente"*. Isto deixa de ser uma recomendação e passa a ser uma impossibilidade.

### 4.3 Onde ficam os dados de cobrança da participação

O requisito 19 pedia que se analisasse se ficam em `lesson_participants` ou numa tabela relacionada.

**Ficam em `lesson_participants`.** A relação é um-para-um: uma participação consome créditos de exatamente um pacote. Uma tabela à parte acrescentaria um JOIN a todas as consultas de aula e, pior, tornaria representável um estado impossível — duas linhas de cobrança para a mesma participação, apontando para pacotes diferentes. Com as colunas na própria participação, a chave primária já impede isso.

O que se perde: se um dia uma participação puder ser paga por dois pacotes em simultâneo, é preciso normalizar. Não é um caso real neste produto.

As colunas são o **estado atual**; a **história** vive em `package_credit_transactions`.

### 4.4 Aula de grupo

Cada aluno tem a sua linha em `lesson_participants`, o que permite **pacotes, quantidades e desfechos de cobrança diferentes na mesma aula**. `db:verify` confirma pacotes e quantidades diferentes; os desfechos por aluno estão cobertos nas regras de domínio e só terão teste ponta a ponta quando existirem as Server Actions da Fase 6.

---

## 5. Regras dos créditos

### 5.1 Os três estados

Um crédito está sempre num de três sítios, e a soma nunca muda sem uma movimentação:

```
   AGENDAR                   CONCLUIR
disponível ──────► reservado ──────► utilizado
     ▲                 │
     └─────────────────┘
        CANCELAR
```

Exemplo do requisito 10, com um pacote de 10:

| Momento | Disponíveis | Reservados | Utilizados |
|---|---|---|---|
| Início | 10 | 0 | 0 |
| Agendar uma aula | 9 | 1 | 0 |
| Aula concluída | 9 | 0 | 1 |
| Aula cancelada (em vez de concluída) | 10 | 0 | 0 |

**O crédito não é consumido ao agendar.** Fica reservado. É isto que impede que o mesmo crédito pague duas aulas, sem cobrar antecipadamente por algo que ainda pode ser cancelado.

### 5.2 O que acontece em cada desfecho

| Estado da aula | Efeito no crédito | Configurável? |
|---|---|---|
| Agendada / Confirmada | Mantém reservado | — |
| Concluída | Reservado → utilizado | — |
| Cancelada pelo professor | Devolvido ao disponível | **Não** |
| Falta do professor | Devolvido ao disponível | **Não** |
| Reagendada | Mantém reservado, muda de aula | — |
| Cancelada pelo aluno, dentro do prazo | Devolvido | prazo configurável |
| Cancelada pelo aluno, fora do prazo | Política decide | `charge` / `refund` / `teacher_decides` |
| Falta do aluno | Política decide | `charge` / `refund` / `teacher_decides` |

O cancelamento pelo professor **não é configurável de propósito**: cobrar um aluno por uma aula que o professor desmarcou não seria uma política, seria um erro.

Implementado em `resolveCreditOutcome()` (`lib/domain/packages.ts`), com 19 testes dedicados. A orquestração que muda o estado da aula e chama consumo/libertação ainda pertence à Fase 6.

### 5.3 Reagendamento sem cobrar duas vezes

A reserva **não** é libertada e recriada — isso produziria duas movimentações e, se algo falhasse pelo meio, um crédito perdido ou duplicado. Em vez disso, `transfer_participation_reservation()` muda a reserva de aula.

O saldo do pacote não se altera: continuam os mesmos créditos reservados, agora ligados à aula nova. Por isso **não há entrada no livro-razão** — ele regista alterações de saldo, e aqui nenhum saldo mudou. O reagendamento fica em `lesson_change_history`.

### 5.4 Escolha entre vários pacotes

Quando o aluno tem vários pacotes compatíveis, sugere-se:

1. O que **expira mais cedo**
2. Em caso de empate, o **criado há mais tempo**

Um pacote sem validade fica sempre para o fim: não tem pressa em ser gasto, e usá-lo antes de um que expira desperdiçaria créditos pagos.

O professor poderá escolher outro manualmente antes de confirmar. `select_package_for_student()` sugere no SQL; `selectPackageForLesson()` permite antecipar a mesma escolha na interface. A seleção isolada não reserva nada: `reserve_participation_credits()` volta a validar e bloqueia o pacote antes de mover o saldo.

### 5.5 Exceções

Agendar sem saldo exige uma ação explícita, e a função recusa sem ela:

- confirmação (`p_allow_exception = true`);
- motivo com pelo menos 3 caracteres, imposto por constraint;
- o utilizador responsável fica registado;
- a participação fica marcada com `is_exception`;
- os dados ficam disponíveis para o futuro painel do professor; esse painel ainda não existe.

### 5.6 Ajustes manuais

`adjust_package_credits(pacote, delta, motivo)`. O motivo é obrigatório. Retirar mais do que está **disponível** é recusado — os créditos reservados ou usados pertencem a aulas concretas.

Uma correção **nunca apaga** o erro: `correct_package_credit_transaction()` acrescenta uma movimentação compensatória ligada pelo `corrects_transaction_id`. O livro-razão não aceita `UPDATE` nem `DELETE` — nem GRANT, nem policy, nem trigger o permitem.

---

## 6. Políticas de cancelamento

Cada organização nasce com uma política, criada por trigger. Sem isto, o primeiro cancelamento de um professor acabado de registar não teria regra a aplicar.

**Política por omissão do MVP:**

| Campo | Valor | Significado |
|---|---|---|
| `min_hours_before_cancel` | 24 | Horas para cancelar sem cobrança |
| `late_cancellation` | `charge` | Cancelar mais tarde consome o crédito |
| `student_no_show` | `charge` | Faltar sem avisar consome o crédito |
| `allow_manual_exceptions` | `true` | O professor pode autorizar exceções |

`resolve_cancellation_policy(professor)` devolve a política do professor se existir, senão a da organização. Numa academia, cada professor pode ter regras próprias sem duplicar a base.

A Fase 3 acrescentou a interface para configurar a política do professor sobre esta estrutura.

---

## 7. Segurança

### 7.1 Cinco camadas, nenhuma delas é esconder um botão

| Camada | O que protege |
|---|---|
| `proxy.ts` | Verificação otimista de sessão |
| Layouts de área | `requireRole()` contra a base de dados |
| GRANTs por coluna | `profiles.role`, `profiles.status`, saldos de pacotes |
| RLS | Que linhas cada utilizador vê, em todas as 23 tabelas |
| Funções `SECURITY DEFINER` | Verificam quem chama antes de qualquer escrita |

### 7.2 Matriz de acesso — pacotes

| Tabela | Professor | Aluno | Admin |
|---|---|---|---|
| `package_templates` | leitura, criação e edição na sua organização | ✗ | leitura |
| `student_packages` | leitura + atribuição por RPC aos seus alunos ativos | leitura dos **seus** | leitura |
| `package_credit_transactions` | leitura da sua organização | leitura das **suas** | leitura |
| `cancellation_policies` | leitura, criação e edição na sua organização | **leitura** | leitura |

Duas decisões que merecem nota:

- **O aluno lê a política que se lhe aplica.** Precisa de saber com quantas horas pode cancelar sem perder o crédito. Escondê-la tornaria a regra uma surpresa desagradável em vez de uma condição conhecida.
- **Ninguém escreve saldos por PATCH.** Não existe GRANT de `UPDATE` em `student_packages` para cliente nenhum — nem para o professor. Se existisse, o livro-razão deixaria de bater certo com a realidade.

### 7.3 Matriz de acesso — perfis e administração

| Recurso | Professor | Aluno | Admin |
|---|---|---|---|
| `profiles` | própria linha; apenas nome, telefone, avatar, idioma, timezone e contacto preferido | idem | leitura básica pelo diretório seguro |
| `teacher_profiles` | própria linha e atualização pública por RPC | nunca lê a tabela base; usa `teacher_public_profiles` | leitura administrativa |
| `student_profiles` | fichas da organização pelas colunas/vista autorizadas | apenas a própria projeção, sem `notes` nem convite | leitura administrativa autorizada |
| `admin_user_directory` | sem linhas | sem linhas | nome, contacto, função, estado e organização; nunca credenciais |
| Estado da conta | não altera | não altera | bloqueia/reativa outra conta por RPC auditada |

Contas bloqueadas conservam apenas a leitura da própria linha de `profiles`, necessária para o servidor reconhecer o estado e encaminhar para `/conta-bloqueada`. As identidades de organização/professor/aluno, os dados funcionais e as escritas passam a devolver vazio ou a ser recusados.

### 7.4 Riscos de concorrência

| Risco | Como é impedido |
|---|---|
| Duas aulas com o último crédito | `SELECT … FOR UPDATE` serializa; a segunda lê o saldo já decrementado e falha com erro claro |
| Saldo negativo | `CHECK (credits_available >= 0)` + invariante da soma |
| Reserva duplicada | `ON CONFLICT (lesson_id, student_id)` + recusa se `billing_status` já é `reserved`/`consumed` |
| Libertação duplicada | A função devolve `false` se não houver reserva ativa — chamar duas vezes não devolve o crédito duas vezes |
| Consumo duplicado | Idem |
| Consumo e libertação simultâneos | `participants_billing_coherent` torna os dois estados mutuamente exclusivos |
| Pacote de outro aluno | Verificação `v_pkg.student_id <> p_student_id` dentro da função |
| Pacote inválido | Estado e validade verificados antes de reservar |
| Perda de histórico | Livro-razão sem `UPDATE`/`DELETE`, em três camadas |

**Limite conhecido:** o `db:verify` corre em PGlite, que tem uma só ligação. Uma segunda tentativa **sequencial** sobre o último crédito é recusada e o saldo não fica negativo; isto não reproduz contenção. O comportamento do `FOR UPDATE` sob paralelismo verdadeiro precisa de um servidor real — previsto para a Fase 9.

### 7.5 Riscos de segurança conhecidos

| Risco | Estado |
|---|---|
| Escalada de privilégios no registo | Mitigado — `handle_new_user()` só aceita `teacher`/`student` |
| `private_notes` visível ao aluno | Mitigado — sem GRANT da coluna; consultas partilhadas usam projeção explícita e a vista privada é exclusiva do professor/admin |
| Aluno a ver dados de outro aluno | Mitigado — RLS por `current_student_id()`; nomes só via vistas restritas |
| Claim escolher entre fichas homónimas | Mitigado — correspondência confirmada, ativa e única; ambiguidades são recusadas e a organização existente limita a procura |
| Conta bloqueada conservar acesso por RLS | Mitigado — helpers de identidade exigem `status = 'active'` e a RPC deixa auditoria |
| Chave `service_role` no cliente | Mitigado — `import "server-only"` falha na compilação |
| Página autenticada servida como estática | Mitigado — `dynamic = "force-dynamic"` nos layouts |
| Isolamento por RLS | Verificado diretamente no PostgreSQL — `db:verify` troca para `authenticated`/`anon`. A Etapa 1E também valida JWT/PostgREST reais no Supabase remoto |

---

## 8. Experiência por tipo de conta

### 8.1 Professor — desktop-first

**Implementado:** largura útil `max-w-7xl`, navegação responsiva, definições e gestão funcional de alunos, turmas, locais e política de cancelamento. As listas têm filtros, alternativa móvel em cartões e estados de loading, vazio, erro e sucesso. Pacotes completos e aulas continuam nas Fases 4–6.

### 8.2 Aluno — mobile-first

**Implementado:** largura útil `max-w-2xl`, navegação inferior e `/aluno/perfil` mobile-first. O aluno edita apenas a conta, vê organização/professor em modo de consulta e gere avisos/segurança. Aulas e saldos continuam marcadores das Fases 7 e 4.

**Regra de interface planeada:** o saldo não será resumido a "restam 7 aulas"; mostrará **disponíveis, reservadas e utilizadas**. A base e os tipos já fornecem os três valores, mas o ecrã ainda não existe.

### 8.3 Administrador

**Implementado para o âmbito da Fase 2:** largura `max-w-6xl`, pesquisa e filtros, listagem responsiva, detalhe básico, diretório de professores e bloqueio/reativação auditados. Não inclui eliminação, impersonação, créditos ou gestão completa de organizações.

---

## 9. Progressive Web App

Base técnica para instalação, com o alvo principal na área do aluno. Nesta fase:

- `app/manifest.ts` — nome, ícones, cores, `display: standalone`
- Ícones PNG provisórios gerados por `scripts/generate-icons.mjs`, sem dependências
- Ícones `maskable` e Apple opacos, geráveis por `npm run icons`
- `start_url: /inicio`, que encaminha por papel — a mesma instalação serve alunos e professores
- `appleWebApp` no layout, para o Safari

**Deliberadamente não implementado:** service worker e funcionamento offline. Saldos, créditos e presenças exigem sempre o servidor — um crédito reservado a partir de dados em cache seria um crédito gasto duas vezes.

A estrutura fica pronta para notificações push (Fase 8).

---

## 10. Fases

| Fase | Âmbito | Estado |
|---|---|---|
| **1** | Projeto, layout, base de dados, autenticação | **Concluído** |
| **1.5** | Fundação técnica de pacotes/créditos e PWA, sem interfaces de gestão | **Concluído** |
| **2** | Perfis, definições e gestão administrativa básica de contas | **Concluído** |
| **3** | Alunos, turmas, locais, política de cancelamento | **Concluído** |
| **4** | Pacotes: modelos, atribuição, ajustes, painel de saldo | **Concluído** — Etapas 1A, 1B, 1C, 1D e 1E validadas |
| **5** | Calendário e criação de aulas, com reserva de créditos | **Parcialmente concluído** — Etapas 5A, 5B e 5B.1: disponibilidade, projeção segura e refinamento visual do calendário |
| **6** | Cancelamento, reagendamento, presenças, histórico | **Planeado** |
| **7** | Área do aluno: aulas, saldo, confirmação de presença | **Planeado** |
| **8** | Notificações, lembretes e expiração agendada | **Planeado** |
| **9** | Supabase real, concorrência, acessibilidade, deployment | **Parcialmente concluído** — Supabase/Auth reais validados para a Fase 4 e Etapas 5A-5B.1; concorrência real, acessibilidade completa e deployment pendentes |

A ordem segue as prioridades pedidas: primeiro a área do professor ao computador, depois as regras seguras de créditos, depois o aluno no telemóvel.

**Pacotes (Fase 4) vêm antes das aulas (Fase 5)** de propósito: a reserva de créditos faz parte da criação de uma aula, e construí-la primeiro sem créditos obrigaria a reescrevê-la a seguir.

### Concluído na Fase 1.5

- 4 tabelas, 5 enums, 7 RPCs de mutação, 1 seletor e funções auxiliares
- 7 colunas de cobrança em `lesson_participants`, `credit_cost` em `lessons`
- `lib/domain/packages.ts` — usabilidade, seleção, alertas, decisão de cobrança
- 57 testes de domínio de pacotes; mantidos na suite atual de 260 testes
- Garantias de créditos mantidas nas 336 verificações atuais; 30 migrações aplicadas do zero e reaplicadas
- Larguras por função, navegação responsiva, rotas marcadoras de pacotes, manifesto e ícones PWA

### Concluído na Etapa 1A — Modelos de pacotes

- `/professor/pacotes`: lista funcional de modelos reutilizáveis, com pesquisa por nome, filtro por estado e filtro por modalidade
- `/professor/pacotes/novo` e `/professor/pacotes/[id]`: criação, edição, ativação/desativação com confirmação e duplicação sem reaproveitar identificador
- Formulário com nome, quantidade de aulas, modalidade opcional, descrição, validade em dias, valor de referência em euros guardado como cêntimos e estado ativo
- Server Actions de modelos com reautenticação, autorização de professor ativo, objetos explícitos de insert/update, rejeição de campos extra e revalidação das rotas afetadas
- Migração incremental `20260802001500_phase4_package_templates.sql`: `updated_at` automático, descrição limitada, moeda `EUR`, índice único por professor, grants por coluna, RLS por professor responsável, validação de modalidade e bloqueio de delete para modelos já usados
- 6 testes Vitest de validação e 25 verificações PostgreSQL novas na entrega da 1A

### Concluído na Etapa 1B — Atribuição de pacotes

- `/professor/pacotes/atribuir`: formulário reutilizável para atribuir pacote a aluno ativo, a partir de modelo ativo ou como pacote personalizado
- Entrada pelo cabeçalho de `/professor/pacotes` e pela ficha administrativa do aluno em `/professor/alunos/[id]`
- `/professor/pacotes/atribuicoes/[id]`: confirmação mínima do pacote criado, com aluno, snapshot, origem, valor informativo, saldos iniciais e presença do primeiro registo do histórico
- Server Action `assignStudentPackageAction()` com reautenticação, professor ativo, Zod estrito, reconsulta de aluno/modelo/modalidade no servidor e chamada exclusiva à RPC `assign_student_package()`
- Migração incremental `20260802001600_phase4_package_assignment.sql`: enum `package_assignment_origin`, colunas `origin` e `assignment_idempotency_key`, índice único parcial por autor, limites de valor/notas/moeda e nova assinatura da RPC
- Snapshot: `student_packages` copia nome, modalidade, quantidade, datas, valor, origem e observações no momento da atribuição; `template_id` fica apenas para auditoria
- Idempotência: cada formulário recebe uma chave UUID; repetir a mesma submissão devolve o mesmo pacote, enquanto uma submissão nova usa outra chave e pode criar outro pacote
- A RPC passou a exigir professor ativo e a recusar administrador, aluno, anónimo, conta bloqueada, aluno inativo, aluno de outro professor e modelo de outro professor/organização
- 20 testes Vitest de validação e 27 verificações PostgreSQL novas naquela entrega

### Concluído na Etapa 1C — Consulta de pacotes e saldos

- `/professor/pacotes`: separadores para **modelos de pacotes** e **pacotes atribuídos**, preservando a gestão da Etapa 1A
- Lista administrativa de pacotes atribuídos com pesquisa por aluno/pacote, filtros por estado, modalidade, saldo baixo/sem saldo e validade próxima/expirada
- Resumo simples do professor: ativos, saldo baixo, sem saldo, a expirar e expirados
- Tabela no desktop e cartões no mobile; limite de 100 pacotes por consulta para evitar carregamento sem limite nesta etapa
- `/professor/pacotes/atribuicoes/[id]`: detalhe completo em modo consulta, com aluno, modelo de origem, saldos, datas, origem, valor, notas administrativas, responsável e histórico básico
- `/professor/alunos/[id]`: secção funcional de pacotes do aluno, mantendo o botão de atribuição e sem edição de saldos
- `/aluno/pacotes`: página mobile-first com cartões, saldos simples, validade, estado, barra de utilização e movimentos básicos seguros
- Migração incremental `20260802001700_phase4_package_read_views.sql`: `teacher_package_records`, `student_package_records` e `student_package_transaction_records`
- Estratégia de privacidade: aluno consulta views sem valor registado, origem administrativa, observações, autoria, organização, professor, modelo ou saldos internos do livro-razão; a interface também usa seleção explícita de colunas
- Regras visuais centralizadas em `lib/domain/package-display.ts`: saldo baixo = 1 ou 2 créditos disponíveis; sem saldo = 0; validade próxima = 7 dias ou menos em datas civis `Europe/Lisbon`
- 13 testes Vitest novos de apresentação e 19 verificações PostgreSQL novas naquela entrega

### Concluído na Etapa 1D — Ajustes administrativos e histórico de pacotes

- `/professor/pacotes/atribuicoes/[id]`: painel de ações administrativas compatíveis com o estado do pacote
- Adicionar créditos e retirar apenas créditos disponíveis por RPC idempotente; o browser nunca envia saldo final
- Suspensão e reativação explícitas; suspender não altera saldo e reativar recalcula o estado derivado a partir de datas e créditos
- Cancelamento sem apagar o pacote, bloqueado quando existem créditos reservados pendentes
- Correção de validade e início com motivo, preservando histórico; alteração de início só antes de reservas ou utilizações
- Correção de movimentações por lançamento compensatório com `corrects_transaction_id`; a original permanece append-only
- Migração incremental `20260802001800_phase4_package_admin.sql`: `student_package_audit_events`, idempotência em movimentações administrativas, views `teacher_package_audit_records` e `teacher_package_history_records`, novas RPCs administrativas e correção de datas civis `Europe/Lisbon`
- `/professor/pacotes/historico`: histórico global com filtros por aluno/pacote, origem, tipo, responsável e período
- A área do aluno continua somente leitura: não recebe motivos administrativos, autoria privada, saldos antes/depois nem eventos internos
- 20 testes Vitest novos de validação e 24 verificações PostgreSQL novas naquela entrega; suite atual com 260 testes e 336 verificações

### Etapa 1E — Revisão integrada e validação real da gestão de pacotes

Estado atual: **concluída**.

Concluído:

- Projeto local ligado ao Supabase de desenvolvimento `fzkwacnpydoqhxipcvro`.
- 27 migrações locais da Fase 4 aplicadas no remoto naquela etapa; o estado atual do projeto tem 30 migrações com as Etapas 5A e 5B, e a 5B.1 não acrescentou migração.
- Dependências Supabase auditadas: `@supabase/server` não é usado nem mantido; sessão/cookies continuam concentrados em `@supabase/ssr`, e `@supabase/supabase-js` fica para cliente admin server-only e tipos.
- Variáveis de ambiente auditadas: o código lê `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` e `SUPABASE_SERVICE_ROLE_KEY`; o exemplo não inclui chaves reais nem variáveis duplicadas de `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` ou `SUPABASE_JWKS_URL`.
- `scripts/verify-remote-supabase.mjs` valida o catálogo remoto sem escrever dados: migrações, tabelas, views, enums, índices, constraints, RLS, grants, assinaturas únicas de RPCs, `search_path` seguro, `EXECUTE` restrito e privacidade das views do aluno.
- `scripts/setup-remote-test-users.mjs` prepara contas E2E reais no Auth usando service role apenas localmente, com confirmação explícita de desenvolvimento e sem imprimir credenciais.
- `scripts/verify-remote-auth.mjs` valida login real, JWT, PostgREST, RPCs de pacotes, idempotência, isolamento, conta bloqueada, anónimo, imutabilidade e privacidade usando URL pública e anon key.
- `.env.local` local preenchido com `SUPABASE_SERVICE_ROLE_KEY` e credenciais `E2E_*`, mantendo o ficheiro ignorado e sem valores reais no repositório.
- `npm run db:setup:e2e -- --confirm-development` executado com sucesso, criando ou reutilizando professor, aluno, segundo professor, segundo aluno, administrador e conta bloqueada de desenvolvimento.
- `npm run db:verify:auth -- --confirm-development` executado com sucesso: a suite atual tem 90 verificações Auth/PostgREST reais, incluindo idempotência, privacidade do aluno, isolamento entre contas, recusas para anónimo/bloqueado, disponibilidade, calendário seguro e imutabilidade.
- Cenário em navegador real validado: professor em desktop autenticado abriu painel, alunos, pacotes, atribuição, histórico e detalhe de pacote; aluno em viewport mobile abriu `/aluno/pacotes`, viu apenas a projeção permitida e manteve sessão após refresh, sem overflow horizontal nem erros relevantes de console.
- Verificações finais executadas com sucesso: `db:verify:remote`, `lint`, `typecheck`, `test`, `db:verify`, `build` e `check`.

Checklist de configuração Auth a manter para repetir esta etapa:

- Email provider ativo.
- Confirmação de email ativa, obrigatória para claim seguro de aluno.
- Site URL de desenvolvimento: `http://localhost:3000`.
- Redirect URL de callback: `http://localhost:3000/auth/callback`.
- Recuperação de palavra-passe apontando para o mesmo domínio local durante desenvolvimento.
- Limitações do email padrão do Supabase documentadas; serviço externo de email permanece fora desta etapa.

**Não concluído na Fase 4:** transferência/fusão/divisão entre pacotes, expiração automática e integração do ciclo de aulas com reserva/consumo pela interface.

### Concluído na Fase 5 — Etapa 5A: disponibilidade, intervalos e bloqueios

Estado atual: **concluída para a fonte de verdade da disponibilidade**.

Concluído:

- `/professor/definicoes/disponibilidade`: página responsiva para o professor gerir horários semanais, exceções por data, bloqueios de agenda, duração padrão da aula e intervalo mínimo entre marcações.
- Entrada em `/professor/definicoes`, mantendo a disponibilidade como configuração operacional do professor, não como marketing nem área do aluno.
- Migração incremental `20260802002000_phase5_teacher_availability.sql`: novos enums, `minimum_break_minutes` em `teacher_profiles`, tabelas `teacher_availability_rules`, `teacher_availability_exceptions` e `teacher_schedule_blocks`, RLS, constraints, índices, triggers, views e RPCs.
- Migração incremental `20260802002100_phase5_availability_view_grants.sql`: revogação explícita de `PUBLIC`/`anon` nas views da Etapa 5A e `SELECT` apenas para `authenticated`.
- Rotina semanal guardada como hora civil local (`weekday`, `time`) em `Europe/Lisbon`, sem conversão para UTC.
- Bloqueios específicos guardados como `timestamptz`, incluindo período parcial, dia inteiro e multi-dia; bloqueios de dia inteiro usam fim exclusivo.
- Intervalos representados pelo espaço entre períodos do mesmo dia; o intervalo mínimo fica persistido para uso futuro no cálculo de conflitos.
- Precedência implementada e documentada: bloqueio ativo → exceção da data → rotina semanal → indisponível por padrão.
- Projeções administrativas para professor/admin e projeção segura `teacher_availability_public_records` para uso futuro do aluno, sem motivo, categoria, observações ou auditoria privada.
- Server Actions com Zod estrito e reautenticação de professor ativo; organização, professor, autoria e timestamps nunca vêm do formulário.
- `scripts/verify-schema.mjs` ampliado para 336 verificações, cobrindo grants, RLS, idempotência, sobreposição, precedência, privacidade, calendário seguro, bloqueio de conta e recusa de aluno/admin/anónimo.
- `scripts/verify-remote-supabase.mjs` ampliado para catálogo remoto da Etapa 5A.
- `scripts/verify-remote-auth.mjs` ampliado para Auth/PostgREST real das Etapas 5A-5B.1; suite atual com 90 verificações reais.
- Testes Vitest novos para domínio e validação de disponibilidade; suite atual com 260 testes.
- Supabase remoto `fzkwacnpydoqhxipcvro` atualizado com 30 migrações locais aplicadas.

Teste manual recomendado:

1. Entrar como professor e abrir `/professor/definicoes/disponibilidade`.
2. Guardar duração padrão e intervalo mínimo.
3. Criar dois períodos no mesmo dia, por exemplo `09:00–13:00` e `15:00–20:00`, confirmando que o intervalo entre eles representa indisponibilidade.
4. Tentar criar um período sobreposto e confirmar erro.
5. Criar uma exceção `replace` numa data e uma exceção `add` noutra.
6. Criar um bloqueio parcial e um bloqueio de dia inteiro; cancelar um bloqueio e confirmar a mensagem.
7. Repetir em viewport móvel, verificando que não há overflow horizontal.

**Não implementado nesta etapa:** calendário diário/semanal/mensal visual, criação de aulas, participantes, recorrência, reserva/consumo de créditos, presenças, cancelamentos/reagendamentos de aulas, confirmação do aluno, lista de espera, notificações, reservas de campos e pagamentos.

### Concluído na Fase 5 — Etapa 5B: calendário visual e disponibilidade segura do aluno

Estado atual: **concluída e validada com Supabase remoto e Auth/PostgREST real**.

Concluído:

- `/professor/calendario`: calendário visual de disponibilidade com vistas por dia, semana e mês, navegação por `data` e `vista`, detalhes privados dos próprios bloqueios e prévia de inícios possíveis usando duração padrão e intervalo mínimo.
- `/aluno/calendario`: calendário mobile-first de disponibilidade do professor responsável, sem botão de reserva, sem criação de aula e sem parâmetros de professor vindos do browser.
- Migração incremental `20260802002200_phase5_calendar_projection.sql`: revoga o `SELECT` direto da view legada `teacher_availability_public_records`, cria `resolve_teacher_availability_calendar_core()` como núcleo interno e expõe duas RPCs curtas.
- `get_teacher_availability_calendar(p_start_date, p_end_date)`: professor ativo consulta até 42 dias com `source`, `source_id`, período, estado, motivo/categoria dos próprios bloqueios e indisponibilidade padrão.
- `get_student_availability_calendar(p_start_date, p_end_date)`: aluno ativo com ficha ligada consulta até 42 dias; a base deriva o professor por `current_student_id()` e devolve só `date`, `starts_at`, `ends_at` e `status`.
- Bloqueios ativos cortam os períodos disponíveis para que um horário bloqueado nunca apareça como livre. Quando não há disponibilidade positiva, o aluno recebe indisponibilidade genérica do dia.
- `src/lib/domain/calendar.ts`: janelas dia/semana/mês, limite de 42 dias, navegação civil e geração de slots lógicos sem tocar em aulas.
- `src/lib/validation/calendar.ts`: normalização segura dos parâmetros `data` e `vista`, com fallback para a semana atual de Lisboa.
- Componente partilhado `AvailabilityCalendar`, alimentado por DTOs diferentes: professor recebe campos privados; aluno recebe apenas a projeção segura.
- `loading.tsx` e `error.tsx` nas rotas de calendário de professor e aluno.
- `scripts/verify-schema.mjs`, `scripts/verify-remote-supabase.mjs` e `scripts/verify-remote-auth.mjs` ampliados para as RPCs de calendário, privacidade do aluno, recusa de anónimo/bloqueado, limite de 42 dias e isolamento entre contas.
- Testes Vitest novos de domínio e validação de calendário; suite atual com 260 testes.
- Supabase remoto atualizado com a migração 30; `db:verify:remote` e `db:verify:auth` passam com a validação de calendário seguro.

Teste manual recomendado:

1. Entrar como professor, configurar disponibilidade em `/professor/definicoes/disponibilidade` e abrir `/professor/calendario`.
2. Alternar entre dia, semana e mês; confirmar que exceções e bloqueios aparecem no calendário privado.
3. Entrar como aluno ligado e abrir `/aluno/calendario` em viewport móvel.
4. Confirmar que o aluno vê apenas horários disponíveis/indisponíveis, sem motivo de bloqueio, categoria, IDs internos ou escolha de professor.

**Ainda não implementado:** criação de aulas, calendário de aulas reais, participantes, grupos ligados a aulas, recorrência, reserva/consumo de créditos, presenças, cancelamentos/reagendamentos de aulas, confirmação do aluno, lista de espera, notificações, reservas de campos, pagamentos, Google/Apple/ICS e drag-and-drop.

### Concluído na Fase 5 — Etapa 5B.1: refinamento visual do calendário

Estado atual: **concluída para apresentação visual**, sem alterar a fonte de dados.

Concluído:

- `AvailabilityCalendar` foi reconstruído como uma superfície de calendário, mantendo o mesmo contrato seguro de dados e sem biblioteca externa.
- As vistas **Dia**, **Semana** e **Mês** ficaram visualmente distintas e preservadas por URL (`data` e `vista`), com seletor visível, botão "Hoje", anterior, seguinte, título do período e timezone `Europe/Lisbon`.
- Vista semanal desktop: sete colunas alinhadas com cabeçalho de dias, coluna lateral de horas, grelha vertical, faixa de dia inteiro e blocos posicionados por início/duração.
- Vista diária: uma coluna temporal, faixa de dia inteiro, blocos proporcionais, detalhes permitidos e prévia de inícios possíveis apenas para o professor.
- Vista mensal: grelha tradicional de cinco ou seis semanas, sem linha temporal de horas, dias externos reduzidos, resumo real de disponibilidade/bloqueios/exceções e ligação de cada dia para a vista diária.
- Mobile: a semana não força sete colunas; usa faixa horizontal de dias e mostra a timeline do dia selecionado. O mês fica compacto e a página evita overflow horizontal.
- A linha de "agora" é um Client Component pequeno, aparece só depois da hidratação, respeita `Europe/Lisbon` e atualiza por minuto.
- A distinção visual combina texto, ícones, contorno/padrão e contraste; o aluno continua a ver apenas "Disponível" ou "Indisponível".
- `src/lib/domain/calendar.ts` centraliza janela selecionada, navegação civil, faixa horária visível, labels de horas, posicionamento proporcional, camada visual dos blocos e posição da linha atual.
- `src/lib/validation/calendar.ts` sinaliza `data`/`vista` inválidas sem passar parâmetros inválidos para a RPC.
- Loading das rotas de calendário passou a ter dimensões próximas da grelha final.
- Testes Vitest ampliados para navegação mensal, serialização, hora lateral, altura proporcional, precedência visual de bloqueio, linha de agora e parâmetros inválidos.

Decisão sobre biblioteca:

- FullCalendar, React Big Calendar e semelhantes não foram instalados. Para o MVP, CSS Grid + cálculos puros cobre o requisito com menor bundle, melhor controlo de privacidade, melhor compatibilidade com Server Components e manutenção mais simples.

Não alterado:

- Nenhuma migração nova.
- Nenhuma RPC nova.
- Nenhuma tabela de aulas, clubes, recursos ou memberships.
- Nenhum botão de reserva.
- Nenhum registo fictício de aula.
- Nenhuma integração Google Calendar, Apple Calendar, ICS ou drag-and-drop.

### Concluído na Fase 5 — Etapa 5B.2A: clubes, workspaces e membros

Estado: **concluída**. Cria o domínio seguro de clubes e vínculos; **não** implementa calendário compartilhado, agenda de colegas, aulas, locais/campos, recursos ou diretório público.

#### Decisão arquitetural: Opção A — `organizations` é o workspace

A auditoria mostrou que `organizations` já era exatamente o que um clube precisaria de ser: tem `name`, `slug`, `timezone` e timestamps, é criada automaticamente uma por professor no registo, e é o eixo de isolamento de **todas** as tabelas do produto. Uma tabela `clubs` ao lado duplicaria o conceito de workspace e obrigaria a decidir, tabela a tabela, qual dos dois manda.

`organizations` passou portanto a ter um **tipo** (`personal` | `club`) e um **estado** (`active` | `suspended` | `archived`), e o vínculo pessoa↔workspace passou a viver em `organization_members`, N:M.

A propriedade que torna isto seguro, e que não pode ser perdida:

> `profiles.organization_id` continua a ser o workspace **pessoal** do professor e **nunca** aponta para um clube.

Como `auth_org_id()` lê exatamente essa coluna, nenhum clube é alguma vez a organização de RLS de alguém. Consequência: entrar num clube não concede, por si só, acesso a **uma única linha** de alunos, pacotes, saldos, locais ou disponibilidade — todas essas policies comparam com `auth_org_id()`, e a resposta continua a ser o workspace pessoal. A privacidade entre colegas fica garantida pela estrutura, e não por uma policy que alguém tenha de se lembrar de escrever.

Alternativas descartadas:

- **Opção B (clube separado da organização):** criaria duas hierarquias de tenancy a conviver, e cada tabela futura teria de escolher a sua.
- **Fazer o clube ser o `organization_id` do professor:** impossibilitaria pertencer a vários clubes e migraria à força alunos, pacotes e disponibilidade já existentes.

#### Estratégia de migração

Determinística e sem recriar UUIDs:

- Todas as organizações existentes ficam `kind = 'personal'`, `status = 'active'`.
- Cada professor já registado recebe uma membership `owner`/`active` no seu próprio workspace pessoal, com `accepted_at` derivado da data de criação da conta.
- `organizations.created_by` é preenchido a partir de `teacher_profiles`.
- `handle_new_user()` foi reescrito (a migração original não foi editada) para criar o workspace pessoal já tipado e com a linha de proprietário.
- Nenhum professor, aluno, pacote, local ou disponibilidade muda de dono. As contas E2E continuam intactas.

#### Estruturas

| Estrutura | Responsabilidade |
|---|---|
| `organizations.kind` / `.status` / `.created_by` / `.suspended_at` / `.suspension_reason` | Workspace tipado, com estado e moderação |
| `organization_members` | Vínculo N:M com papel interno, estado e auditoria de entrada/saída |
| `organization_invitations` | Convite sem segredo: estado, email-alvo e auditoria |
| `profiles.active_workspace_id` | Preferência de contexto, sem GRANT de UPDATE |

#### Papéis internos, distintos dos papéis globais

O papel global (`profiles.role`: `student`/`teacher`/`admin`) não é tocado. Criar um clube **não** torna a conta administradora da plataforma.

| Papel interno | Pode |
|---|---|
| `owner` | Gerir membros, convidar `manager` ou `teacher`, alterar papéis, remover membros |
| `manager` | Convidar `teacher`, alterar papéis entre gestor e professor, remover membros não proprietários |
| `teacher` | Pertencer ao clube e ver nome/papel dos colegas |

Invariantes impostos em SQL: ninguém é convidado para `owner`; ninguém altera o próprio papel; o papel do proprietário não muda por esta via; o último proprietário ativo não pode ser removido; só um proprietário remove outro proprietário.

#### Convites

Sem token, sem código, sem URL com segredo — a mesma decisão já tomada em `student_invitations`. Um convite é um estado administrativo dirigido a um email; quem o aceita tem de estar autenticado com esse email **confirmado**. Não havendo bearer token, não há nada que possa vazar num log, num histórico de browser ou num referer. Um convite para um email ainda sem conta fica guardado; o envio por email pertence à Fase 8 e a interface diz isso por palavras.

#### Contexto ativo

Guardado no servidor em `profiles.active_workspace_id`, escrito só por `set_active_workspace()` e **sempre** revalidado na leitura por `resolve_active_workspace_id()`, que ignora a preferência se o vínculo tiver caído e devolve o workspace pessoal. Um cookie decidiria o que a aplicação mostra, mas nunca poderia decidir o que o utilizador pode ver.

#### Suspensão

Suspender um clube não apaga nada: memberships, convites e auditoria ficam. O que para são as operações — `can_manage_workspace()` exige workspace ativo, e aceitar convite verifica o estado. O workspace pessoal de cada professor continua intacto, e suspender um workspace pessoal é recusado (isso é bloquear a conta, que já tem caminho próprio e auditado).

#### Interface

- `/professor/clubes` — lista de contextos (pessoal + clubes), papel, estado, contagem de membros e criação de clube.
- `/professor/clubes/[id]` — detalhe, membros, convites pendentes e ações permitidas, com confirmação antes de remover/revogar.
- `/professor/convites` — convites recebidos, aceitar ou recusar.
- `/admin/clubes` — moderação: estado, dimensão, autoria e suspender/reativar com motivo.
- Seletor de contexto no shell do professor: barra lateral no desktop, faixa própria no telemóvel, props primitivas e sem contextos não autorizados.

#### Limite honesto, declarado na própria interface

Mudar de contexto **não** torna alunos, pacotes, turmas, locais, disponibilidade ou calendário multi-clube. Esses módulos continuam ligados ao workspace pessoal, e a lista `PERSONAL_ONLY_MODULES` em `lib/domain/workspaces.ts` é mostrada ao utilizador em vez de fingir que já mudaram.

#### Não implementado nesta etapa

Calendário compartilhado, agenda de colegas, aulas, participantes, recorrência, créditos, presenças, conflitos, locais/campos/recursos, Google Places/Maps/Calendar, Apple Calendar, ICS, notificações, pagamentos, diretório público de clubes, pesquisa pública de professores, transferência de propriedade e edição das definições do clube.

### Concluído na Fase 5 — Etapa 5B.2B: calendário partilhado do clube

Estado: **concluída**. Abre exatamente uma porta a mais do que a 5B.2A — disponibilidade genérica — e só com consentimento explícito, clube a clube. Não implementa aulas, locais, campos, recursos, conflitos nem créditos.

#### Decisão: o consentimento vive na membership

`organization_members.calendar_sharing_enabled boolean not null default false`.

Na membership, e não em `teacher_profiles`, porque uma preferência global obrigaria a escolher entre partilhar com todos os clubes ou com nenhum. Quem dá aulas num clube de bairro e noutro de competição tem boas razões para partilhar num e não no outro. Ativar no Clube A não ativa no Clube B, e sair de um clube leva o consentimento consigo.

**Só o próprio altera.** `set_workspace_calendar_sharing(p_organization_id, p_enabled)` **não aceita alvo**: deriva a membership de `auth.uid()` e do clube. Proprietário, gestor e administrador da plataforma não têm sequer um parâmetro por onde tentar. A ausência do parâmetro é a garantia — não uma verificação que alguém possa remover por distração.

Gravar o mesmo valor devolve `false` e não repete a auditoria, que regista apenas ator, clube e transição — nunca períodos, motivos, categorias ou notas.

#### Projeção segura

`get_club_availability_calendar(p_organization_id, p_start_date, p_end_date, p_membership_id)` devolve exatamente seis colunas: `membership_id`, `teacher_name`, `date`, `starts_at`, `ends_at`, `status`.

Nunca são devolvidos `source`, `source_id`, `reason`, `category`, `all_day`, IDs de regra/exceção/bloqueio, `teacher_id`, `profile_id`, organização pessoal, autoria, email ou telefone.

**Os quatro estados:**

| Estado | Representação |
|---|---|
| `available` | Linha `available` com horas |
| `unavailable` | Linha `unavailable` com horas, só onde o servidor prova janela positiva ∩ bloqueio ativo |
| `outside_hours` | Ausência de linha, incluindo dias inteiros sem rotina |
| `not_shared` | Nenhuma linha, e `calendar_sharing_enabled = false` no diretório |

A primeira versão devolvia apenas linhas `available`, e por isso um bloqueio privado e uma pausa de almoço ficavam representados da mesma maneira: ausência. Como a Etapa 5A representa a pausa de almoço exatamente como o espaço entre `09:00–13:00` e `15:00–20:00`, deduzir "buraco = ocupado" no cliente marcaria almoços como indisponibilidade — inventaria informação. A correção calcula a interseção no servidor, que é o único sítio onde as fronteiras das janelas são conhecidas.

Para não duplicar regras, a precedência e o recorte de fuso passaram a viver em `resolve_teacher_availability_windows()` e `resolve_teacher_block_segments()`, e o motor original é construído a partir delas — comportamento público inalterado, confirmado pelas garantias já existentes do calendário do professor e do aluno.

O contrato é próprio e não herda o contrato privado do professor, que transporta motivo e categoria: reaproveitá-lo seria arriscar que uma coluna futura passasse a ser partilhada por acidente.

Quem não consentiu não produz linha nenhuma. `club_calendar_member_directory` é que distingue "indisponível" de "disponibilidade não partilhada".

#### Autorização

Professor global ativo + membership `active` + `kind = 'club'` + `status = 'active'`. `active_workspace_id` **não** participa da decisão em momento nenhum. O filtro `p_membership_id` é revalidado — tem de ser uma membership ativa **deste** clube — e é recusado em vez de devolver vazio, para não parecer que o colega simplesmente não tem disponibilidade.

#### Interface

`/professor/clubes/[id]/calendario`, com Dia/Semana/Mês, "Hoje", navegação e filtro por professor. O filtro vive no URL e é feito de links, sem JavaScript: sobrevive a partilhar o endereço, recarregar e voltar atrás.

Reutiliza `AvailabilityCalendar` em vez de duplicar o calendário: o componente ganhou a audiência `club` e as verificações de privacidade passaram de `audience === "student"` para `audience !== "teacher"`, para que uma audiência futura nasça segura. `calendarHref()` passou a preservar a query já presente no `basePath` — uma alteração num único ponto, em vez de arrastar o filtro por seis subcomponentes de um ficheiro de 1229 linhas.

#### Duas correções que as verificações apanharam

A primeira versão alargava `workspace_member_directory` com a coluna de partilha. A verificação de reaplicação falhou: a migração da 5B.2A recria essa view com `create or replace`, que recusa perder colunas. A view do calendário passou a ser própria — o que também é melhor desenho, porque o contrato do calendário deixa de herdar um contrato pensado para outra coisa.

A revisão de encerramento encontrou a segunda: bloqueio e fora do horário eram indistinguíveis. Corrigida em `20260803000600_phase5_club_calendar_states.sql`, com a interseção calculada no servidor e uma legenda que nomeia os quatro estados.

E a terceira, na leitura crítica do próprio relatório: a correção anterior mantinha um ramo que marcava o **dia inteiro** como `unavailable` sempre que não houvesse disponibilidade — contradizendo a regra que ela própria enunciava. Um dia sem rotina não tem janela positiva e é, por definição, fora do horário; e um dia sem rotina **com** bloqueio pessoal chegava a sinalizar ao colega que ali havia alguma coisa. `20260803000700_phase5_club_calendar_outside_hours.sql` remove esse ramo: a projeção passa a devolver exclusivamente segmentos com horas.

#### Não implementado nesta etapa

Aulas, participantes, locais, campos, recursos, Google Places/Maps/Calendar, Apple Calendar, ICS, recorrência, conflitos, reservas, consumo de créditos, presenças, cancelamentos, notificações, pagamentos, drag-and-drop, transferência de propriedade e diretório público. Os únicos estados são disponível e indisponível: não existe "ocupado", "reservado", "lotado", "vagas" nem "conflito", porque nada disso existe ainda para ser verdade.

Decisões preservadas da 5B.2A:

- Professor independente mantém um workspace pessoal privado, vê somente a própria agenda e nenhum outro professor acessa sua agenda.
- Clube funcionará como workspace compartilhado, com vários professores e possíveis administradores/gestores.
- Clube poderá possuir locais, campos ou recursos; professores entrarão por convite ou vínculo autorizado.
- Professores autorizados poderão ver um calendário compartilhado filtrável por professor, local, campo ou recurso.
- Um professor do clube poderá ver, conforme permissão, nome do colega, horário ocupado, disponibilidade necessária para coordenação e local/campo usado.
- Um professor do clube não deverá ver automaticamente nome dos alunos de outro professor, pacote, saldo, pagamento, telefone, notas privadas, motivo pessoal de bloqueio ou dados administrativos sensíveis.
- Bloqueio privado de colega deve aparecer apenas como `Indisponível`.
- O domínio deve preparar a possibilidade futura de um professor ter workspace pessoal, vínculo com um clube e vínculo com mais de um clube, sem implementar isso na 5B.1.

Conflitos futuros a modelar:

1. Conflito do professor: o mesmo professor não pode ter duas aulas simultâneas.
2. Conflito do recurso: o mesmo campo ou recurso não pode receber duas aulas simultâneas.
3. Ausência de conflito: professores diferentes podem dar aulas no mesmo horário usando recursos diferentes.

A auditoria de `organizations` foi feita na 5B.2A e concluiu pela Opção A (organização = workspace tipado). A 5B.2B parte daí e não volta a discutir o modelo de tenancy.

O que a 5B.2B terá de trazer de novo:

- Uma projeção própria e restrita da agenda partilhada — a 5B.2A **não** abriu nenhuma leitura de disponibilidade entre membros.
- Bloqueio privado de colega visível apenas como `Indisponível`, sem motivo nem categoria.
- Filtro por professor e, mais tarde, por local/campo/recurso.

Rotas prováveis:

- `/professor/clubes/[id]/calendario`

Ordem da Fase 5:

1. 5B.1 — Refinamento visual. **Concluída.**
2. 5B.2A — Clubes, workspaces e membros. **Concluída.**
3. 5B.2B — Calendário partilhado do clube. **Concluída.**
4. 5B.3 — Locais, campos e Google Places. **Próxima.**
5. 5C — Criação e edição de aulas.
6. 5D — Recorrência, conflitos e reservas de créditos.
7. 5E — Revisão integrada.

### Fase 2 — estado por item

| Item | Estado | Resultado real |
|---|---|---|
| Conta e definições do professor | **Concluído** | Nome, telefone, idioma, timezone, contacto preferido, avisos, palavra-passe e logout persistentes |
| Perfil profissional do professor | **Concluído** | Nome público, apresentação, zona e modalidades N:N, atualizados por uma RPC atómica |
| Avatar | **Parcialmente concluído** | Iniciais funcionais; upload planeado porque não existe bucket de Storage configurado |
| Perfil e definições do aluno | **Concluído** | Apenas dados privados autorizados; organização e professor são leitura segura |
| Claim automático por email confirmado | **Concluído** | Idempotente, com bloqueio de linha, isolamento, recusa de ambiguidade e de fichas ligadas/inativas |
| Código de convite legado | **Desativado** | Valores eliminados, coluna limitada a `NULL`, sem GRANT e parâmetro recusado; nunca voltou a ser uma credencial |
| Preparação de ligação | **Concluído (estado)** | Registo administrativo sem token, URL ou segredo; a interface não afirma envio de email |
| Preferências de notificação | **Concluído** | Persistência de canais/eventos; entrega automática continua planeada para a Fase 8 |
| Diretório administrativo | **Concluído** | Pesquisa, filtros, professores, detalhe, estados vazios/erro/loading e resposta mobile/desktop |
| Bloqueio e reativação | **Concluído** | RPC exclusiva de admin, sem auto-bloqueio, motivo, auditoria e revogação efetiva por RLS |
| Validação num Supabase remoto | **Concluído para a Fase 4 e Etapas 5A-5B.1** | Migrações, catálogo remoto, GoTrue/Auth, JWT/PostgREST, contas reais e browser desktop/mobile da Fase 4 validados; calendário seguro validado por RPC/Auth real |

### Concluído na Fase 2

- 3 migrações incrementais: dados do perfil, endurecimento de acesso e correção de validação
- `teacher_sports`, vistas seguras de professor/aluno/admin e RPCs de perfil/estado
- Server Actions com reautenticação, objetos de update explícitos e schemas Zod partilhados
- `/professor/definicoes`, `/aluno/perfil`, `/admin/utilizadores`, detalhe por ID e `/admin/professores`
- 24 testes novos de validação (149 Vitest no total) e 41 garantias PostgreSQL adicionais (110 no total)
- `private_notes`, observações de alunos, convite, função, organização e saldos fora dos contratos indevidos

### Concluído na Fase 3

- `/professor/alunos`: pesquisa, filtros de estado, criação sem conta, detalhe, edição administrativa, ativação/desativação, grupos e resumo agregado de pacotes
- Preparação e revogação auditadas da ligação futura; o claim continua a exigir email confirmado, correspondência única, ficha ativa e organização coerente
- `/professor/grupos`: criação, edição, estado, modalidade e capacidade opcionais, pesquisa de alunos e adesão/remoção atómicas com histórico preservado
- `/professor/locais`: pesquisa e filtros dos locais disponíveis na organização; criação/edição/desativação dos próprios e consulta pública dos partilhados, com campos administrativos mascarados
- `/professor/definicoes/politicas-cancelamento`: política própria, fallback explícito da organização, prazo em horas, decisões de cobrança/devolução e exceção manual
- 3 migrações incrementais, 1 tabela, 1 enum, vistas restritas, RLS/GRANTs por coluna e 7 RPCs/contratos de gestão; reentradas em turmas conservam períodos separados
- 23 testes Vitest novos na Fase 3 (172 no total naquela entrega) e 87 verificações PostgreSQL novas (197 no total naquela entrega)

**Teste manual com um Supabase configurado:** entrar como professor ativo; criar duas fichas em `/professor/alunos`; preparar a ligação de uma ficha com email e confirmar que a interface diz que nada foi enviado; criar uma turma, pesquisar/adicionar/remover um aluno e desativá-la; criar e desativar um local; por fim, guardar uma política própria, desativá-la e confirmar que a política efetiva volta à da organização. Repetir as listas numa largura móvel e numa largura desktop. A entrega de convite e o claim real exigem uma conta com email confirmado no projeto remoto.

### Limitações ainda ativas

- **Não há upload de avatar.** Não existe bucket de Storage nem política de objetos; a interface usa iniciais e explica a limitação.
- **Preferências de email não significam entrega automática.** Ficam persistidas, mas outbox/worker e lembretes agendados chegam na Fase 8.
- **Preparar uma ligação não envia email.** A Fase 3 guarda apenas um estado auditável e sem segredo; entrega real por email continua fora desta etapa, embora o claim/Auth real já esteja coberto pelos testes remotos de desenvolvimento.
- **A interface de pacotes ainda é parcial.** `/professor/pacotes` gere modelos, atribuição, consulta, ajustes administrativos e histórico; `/aluno/pacotes` mostra os próprios pacotes. Transferências/fusões/divisões e integração com aulas reais continuam pendentes.
- **A expiração de pacotes não é automática.** `refresh_package_status()` marca `expired` quando é chamada, mas nada corre à meia-noite. Precisa de uma tarefa agendada — Fase 8, com os lembretes.
- **`credit_expired` e `credit_transferred_*` existem no enum mas não têm função.** Ficam para quando a expiração automática e a transferência entre pacotes forem implementadas numa fase futura.
- **A validação remota da Fase 4 e das Etapas 5A-5B.1 cobre Auth/PostgREST real, mas não concorrência simultânea.** O catálogo remoto é verificado por `db:verify:remote` e o cenário com contas reais por `db:verify:auth`; duas ligações concorrentes sobre o último crédito ainda pertencem à Fase 9.
- **A concorrência real não é reproduzida.** O teste sequencial confirma o resultado e as funções usam `FOR UPDATE`; duas ligações simultâneas ainda têm de ser testadas na Fase 9.
- **Não existem Server Actions do ciclo de créditos.** As RPCs e decisões de domínio estão prontas, mas criar/cancelar/concluir/reagendar pela interface pertence às Fases 5–6.

---

## 11. Decisões técnicas

### D-01 — TypeScript 5.9 em vez de 7.0
O npm serve a 7.0 (compilador em Go) como `latest`, mas `typescript-eslint` ainda declara dependências sobre a série 5.x. Para um MVP, um pipeline de qualidade que funciona vale mais do que um `tsc` rápido.

### D-02 — Esquema completo antes da interface
As policies RLS são interdependentes; fatiá-las por fases obrigaria a reescrevê-las várias vezes.

### D-03 — Organização criada automaticamente no registo
Um professor independente não quer saber o que é uma "organização". A abstração existe na base de dados, invisível na interface.

### D-04 — Alunos existem antes de terem conta
`student_profiles.profile_id` é `NULL` até o aluno se registar. A ligação faz-se por email **com confirmação obrigatória**; a preparação administrativa da Fase 3 não é uma credencial e não contém token.

### D-05 — Recorrência materializada
Cada ocorrência tem de ser individualmente cancelável e reagendável.

### D-06 — Preferências de notificação em colunas
Uma linha por utilizador em vez de 39.

### D-07 — Padrão outbox para canais externos
Uma falha do email não pode impedir o cancelamento de uma aula.

### D-08 — `private_notes` protegido também na base
O RLS filtra linhas, não colunas. Por isso, `authenticated` deixou de ter `SELECT` sobre `lessons.private_notes`; as consultas partilhadas usam uma lista explícita e o professor/admin recebe a coluna apenas por `teacher_lesson_records`. O mesmo padrão separa `student_profiles.notes` e `invite_code` da projeção do aluno.

### D-09 — Server Actions em vez de Route Handlers
Menos código, validação Zod partilhada, revalidação integrada.

### D-10 — Sem biblioteca de componentes
O requisito pede um visual que não pareça um painel administrativo genérico.

### D-11 — Rotas em português
Ver secção 1.4. Preservar o que funciona; a separação por área é a pedida.

### D-12 — Cobrança em `lesson_participants`, não em tabela à parte
**Alternativa:** tabela `participation_billing` relacionada.
**Porquê:** a relação é um-para-um. A tabela à parte acrescentaria um JOIN a todas as consultas e tornaria representável um estado impossível — duas cobranças para a mesma participação. Ver 4.3.

### D-13 — Saldos alteráveis apenas por funções SQL
**Alternativa:** GRANT de UPDATE ao professor, com a aplicação a manter o livro-razão.
**Porquê:** confiar na aplicação para escrever o histórico significa que um `PATCH` esquecido produz um saldo sem rasto. Sem GRANT, esse caminho não existe. O custo é uma chamada RPC por operação — irrelevante face à garantia.

### D-14 — PGlite para testar o esquema
**Alternativa:** Docker com PostgreSQL, ou testar só contra o Supabase real.
**Porquê:** as regras de créditos vivem em SQL porque só aí podem ser atómicas — e testá-las exige uma base de dados. O PGlite dá PostgreSQL em segundos, sem daemon nem recursos na nuvem, e corre no CI. A verificação começa numa base vazia, reaplica as migrações e troca para papéis não proprietários para exercer o RLS.
**Limite:** uma só ligação, sem GoTrue nem PostgREST. Ver 7.4 e 7.5.

### D-15 — `initial_credits` separado de `credits_total`
**Alternativa:** uma só coluna de total.
**Porquê:** `initial_credits` regista o que foi **contratado** e nunca muda; `credits_total` reflete ajustes posteriores. A diferença entre os dois é, por si só, uma pista de auditoria: um pacote de 8 com total de 11 diz que houve três créditos oferecidos, e o livro-razão diz porquê.

### D-16 — Uma reserva pendente não esgota o pacote
**Alternativa:** marcar `depleted` assim que `credits_available` chega a zero.
**Porquê:** o crédito está reservado, não gasto. Se a aula for cancelada, volta. Marcar o pacote como esgotado enquanto isso é possível daria um alarme falso ao professor. "Esgotado" fica para quando não há mesmo nada — nem disponível, nem por decidir. O painel usa uma consulta separada (`credits_available = 0`) para "alunos sem créditos", que é a pergunta operacional.

### D-17 — Ícones PNG gerados por script próprio
**Alternativa:** `sharp`, `canvas`, ou ficheiros binários no repositório.
**Porquê:** um PNG é uma assinatura, um cabeçalho e píxeis comprimidos com zlib, que o Node já traz. Acrescentar dezenas de megabytes de dependência para desenhar dois quadrados não se justifica, e ícones binários sem fonte não se conseguem ajustar.

### D-18 — Sem service worker nesta fase
**Alternativa:** cache offline básica.
**Porquê:** o requisito pede explicitamente que não haja offline complexo, e há uma razão de correção: operações sobre créditos exigem sempre o servidor. Um saldo lido de cache levaria a reservar um crédito que já não existe.

### D-19 — Clube é uma organização tipada, não uma tabela nova
**Alternativa:** tabela `clubs` ligada a `organizations`, ou clube a substituir o `organization_id` do professor.
**Porquê:** `organizations` já tinha nome, slug, timezone, timestamps e era o eixo de isolamento de todas as tabelas — uma tabela `clubs` duplicaria o conceito de workspace. E fazer do clube o `organization_id` do professor impossibilitaria pertencer a vários clubes e migraria à força os dados existentes. Mantendo `profiles.organization_id` sempre pessoal, `auth_org_id()` nunca devolve um clube, e portanto entrar num clube não abre nenhuma das policies existentes: a privacidade entre colegas passa a ser uma propriedade da estrutura, não de uma policy que alguém tenha de se lembrar de escrever.

### D-21 — Partilha de agenda por consentimento, não por membership
**Alternativa:** membros de um clube veem automaticamente a agenda uns dos outros.
**Porquê:** a agenda de um professor revela quando trabalha, quando descansa e quando tem compromissos pessoais — mesmo reduzida a "disponível/indisponível". Entrar num clube para coordenar horários não é consentir na exposição da própria rotina. O consentimento fica na membership, e não no professor, porque a decisão é razoável clube a clube. O custo é um clube parecer vazio até alguém ativar a partilha; a interface explica isso em vez de o esconder.

### D-20 — Convite de clube sem token
**Alternativa:** token assinado numa URL de convite.
**Porquê:** a mesma razão de `student_invitations`. Um token é um segredo portador que aparece em logs, históricos de browser e cabeçalhos `Referer`, e obriga a gerir entropia, hashing, expiração e uso único. Exigir que quem aceita esteja autenticado com o email **confirmado** do convite dá a mesma garantia sem criar nada que possa vazar. O custo é não poder convidar alguém que nunca confirme o email — que é precisamente quem não deveria entrar.

---

## 12. Pontos de extensão

Preparados, **não implementados**. Assinalados no código com `// EXTENSÃO:`.

| Funcionalidade | O que já está preparado | O que falta |
|---|---|---|
| Clubes com vários professores | `organizations` tipada, `organization_members`, convites, papéis internos, contexto ativo e calendário partilhado com consentimento (5B.2A + 5B.2B) | Locais/campos (5B.3); aulas (5C); transferência de propriedade |
| Outras modalidades | Tabela `sports`; pacotes com `sport_id` opcional | Seed; campos por desporto |
| Pagamentos | `paid_amount_cents`, `reference_price_cents` | Stripe; tabela `payments` |
| Expiração automática de créditos | `credit_expired` no enum; `refresh_package_status()` | Tarefa agendada noturna |
| Transferência entre pacotes | `credit_transferred_in/out` no enum | Função SQL + interface |
| Notificações por email | `notification_deliveries` + outbox | Adaptador Resend; templates |
| WhatsApp | `notification_channel` é enum | Adaptador; opt-in |
| Notificações push | Manifesto PWA pronto | Service worker; VAPID; subscrições |
| Chat professor↔aluno | `notifications` já é 1:N | Tabelas `conversations`/`messages` |
| App móvel nativa | Regras em `lib/domain/`, independentes do Next | API REST em `app/api/v1/` |
| Rankings e torneios | `attendance` como base | Tabelas próprias |

---

## 13. Fora do âmbito do MVP

Pagamentos, subscrições, marketplace, reservas automáticas de campos, WhatsApp, apps nativas, chat interno, rankings, IA, sistema financeiro completo, sincronização offline.

---

## 14. Como aplicar as migrações

```bash
npm run db:verify                              # valida localmente, sem nuvem
npx supabase link --project-ref SEU_REF
npm run db:push
npm run db:verify:remote -- --confirm-development
npm run db:types
```

Alternativa: colar os ficheiros de `supabase/migrations/` no SQL Editor, por ordem numérica. São idempotentes.

Instruções completas em [`AGENTS.md`](AGENTS.md).
