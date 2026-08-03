# AulaFlow — Plano de Implementação

> Plataforma web para gestão de aulas desportivas, com pacotes e créditos.
> **Uma única aplicação Next.js**, com interfaces distintas por tipo de conta.
> Versão inicial focada em **beach tennis**, preparada para outras modalidades.

**Documento vivo.** Atualizado no fim de cada fase com o que foi realmente construído.

- **Estado atual:** Fases 1, 1.5, 2 e 3 concluídas. A Fase 4 está parcialmente concluída com a **Etapa 1A — modelos reutilizáveis de pacotes**, a **Etapa 1B — atribuição de pacotes aos alunos**, a **Etapa 1C — consulta de pacotes e saldos** e a **Etapa 1D — ajustes administrativos e histórico de pacotes**.
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
| Testes (unidade/regressão) | Vitest | 4.1.x | 231 testes |
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
| Isolamento por RLS | Verificado diretamente no PostgreSQL — `db:verify` troca para `authenticated`/`anon`. JWT/PostgREST reais continuam pendentes na Fase 9 |

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
| **4** | Pacotes: modelos, atribuição, ajustes, painel de saldo | **Parcialmente concluído** — Etapas 1A, 1B, 1C e 1D |
| **5** | Calendário e criação de aulas, com reserva de créditos | **Planeado** |
| **6** | Cancelamento, reagendamento, presenças, histórico | **Planeado** |
| **7** | Área do aluno: aulas, saldo, confirmação de presença | **Planeado** |
| **8** | Notificações, lembretes e expiração agendada | **Planeado** |
| **9** | Supabase real, concorrência, acessibilidade, deployment | **Parcialmente concluído** — RLS em PGlite e revisão estrutural de acessibilidade feitos; ambiente real e deployment pendentes |

A ordem segue as prioridades pedidas: primeiro a área do professor ao computador, depois as regras seguras de créditos, depois o aluno no telemóvel.

**Pacotes (Fase 4) vêm antes das aulas (Fase 5)** de propósito: a reserva de créditos faz parte da criação de uma aula, e construí-la primeiro sem créditos obrigaria a reescrevê-la a seguir.

### Concluído na Fase 1.5

- 4 tabelas, 5 enums, 7 RPCs de mutação, 1 seletor e funções auxiliares
- 7 colunas de cobrança em `lesson_participants`, `credit_cost` em `lessons`
- `lib/domain/packages.ts` — usabilidade, seleção, alertas, decisão de cobrança
- 57 testes de domínio de pacotes; mantidos na suite atual de 231 testes
- Garantias de créditos mantidas nas 292 verificações atuais; 26 migrações aplicadas do zero e reaplicadas
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
- 20 testes Vitest novos de validação e 24 verificações PostgreSQL novas; suite atual com 231 testes e 292 verificações

**Não concluído na Fase 4:** transferência/fusão/divisão entre pacotes, expiração automática e integração do ciclo de aulas com reserva/consumo pela interface.

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
| Validação num Supabase remoto | **Bloqueado (Fase 9)** | Requer credenciais/projeto real; PGlite não reproduz GoTrue, JWT/PostgREST nem concorrência entre várias ligações |

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
- **Preparar uma ligação não envia email.** A Fase 3 guarda apenas um estado auditável e sem segredo; entrega real e validação via GoTrue/PostgREST dependem de um Supabase remoto.
- **A interface de pacotes ainda é parcial.** `/professor/pacotes` gere modelos, atribuição, consulta, ajustes administrativos e histórico; `/aluno/pacotes` mostra os próprios pacotes. Transferências/fusões/divisões e integração com aulas reais continuam pendentes.
- **A expiração de pacotes não é automática.** `refresh_package_status()` marca `expired` quando é chamada, mas nada corre à meia-noite. Precisa de uma tarefa agendada — Fase 8, com os lembretes.
- **`credit_expired` e `credit_transferred_*` existem no enum mas não têm função.** Ficam para quando a expiração automática e a transferência entre pacotes forem implementadas (Fase 4).
- **Não há teste com Supabase real.** O RLS é exercido diretamente como `authenticated`/`anon` no PGlite, mas GoTrue, JWT e PostgREST não existem nesse ambiente.
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

---

## 12. Pontos de extensão

Preparados, **não implementados**. Assinalados no código com `// EXTENSÃO:`.

| Funcionalidade | O que já está preparado | O que falta |
|---|---|---|
| Academias com vários professores | `organization_id` em todas as tabelas; políticas por professor | Convites; papel `org_admin` |
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
npm run db:types
```

Alternativa: colar os ficheiros de `supabase/migrations/` no SQL Editor, por ordem numérica. São idempotentes.

Instruções completas em [`AGENTS.md`](AGENTS.md).
