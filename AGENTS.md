<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AGENTS.md — AulaFlow

Guia para quem (pessoa ou agente) trabalha neste repositório.
A arquitetura e as decisões técnicas estão em [`implementation_plan.md`](implementation_plan.md).

> **Next.js 16 — o que mudou face ao que provavelmente sabe**
>
> - `middleware.ts` chama-se agora **`proxy.ts`**, e a função exportada é `proxy`. O runtime é sempre Node; `edge` não é suportado.
> - `cookies()`, `headers()`, `params` e `searchParams` são **assíncronos**. `await` obrigatório.
> - `next lint` **foi removido**. Usa-se o ESLint diretamente.
> - Turbopack é o predefinido em `dev` e em `build`.
> - `revalidateTag(tag)` passou a exigir um segundo argumento; para *read-your-writes* usa-se `updateTag(tag)`.

---

## Arranque rápido

```bash
npm install
cp .env.example .env.local     # preencher com os dados do seu projeto Supabase
npm run db:link                # uma vez: indicar o project ref quando pedido
npm run db:push                # aplicar as migrações
npm run dev                    # http://localhost:3000
```

Sem `.env.local`, a aplicação arranca na mesma e mostra um ecrã a explicar o que falta — não rebenta.

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento (Turbopack) em `localhost:3000` |
| `npm run build` | Compilação de produção |
| `npm start` | Serve a compilação de produção |
| `npm run lint` | ESLint |
| `npm run lint:fix` | ESLint com correção automática |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest, uma passagem |
| `npm run test:watch` | Vitest em modo contínuo |
| `npm run db:verify` | Executa as migrações num PostgreSQL local (WASM) e exercita RLS, gestão e créditos |
| `npm run icons` | Regenera os ícones PNG provisórios da PWA |
| `npm run check` | **lint → typecheck → test → db:verify → build**, por esta ordem |
| `npm run db:link` | Liga o projeto local ao projeto Supabase remoto |
| `npm run db:push` | Aplica as migrações de `supabase/migrations/` |
| `npm run db:types` | Regenera `src/types/database.ts` a partir da base de dados |

**Antes de dar uma fase por concluída, `npm run check` tem de passar por inteiro.**

---

## Configuração do Supabase

### 1. Criar o projeto

Em [supabase.com](https://supabase.com), criar um projeto numa região europeia (`eu-west-*`) — menor latência a partir de Portugal e RGPD mais simples.

### 2. Preencher `.env.local`

Painel Supabase → **Project Settings → API**:

| Variável | Onde encontrar |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chave `anon` / `public` |
| `SUPABASE_SERVICE_ROLE_KEY` | chave `service_role` — **só para tarefas agendadas da Fase 8** |

### 3. Aplicar as migrações

```bash
npx supabase link --project-ref SEU_PROJECT_REF
npm run db:push
```

Em alternativa: colar os ficheiros de `supabase/migrations/` no SQL Editor, **por ordem numérica crescente**. São idempotentes, pelo que repetir a execução é seguro.

### 4. Ativar a confirmação de email

Painel → **Authentication → Providers → Email** → ligar *Confirm email*.

Não é opcional. A ligação entre a conta de um aluno e a ficha criada pelo professor é feita por correspondência de email; sem confirmação, bastaria registar-se com o email de outra pessoa para herdar o seu histórico de aulas.

Em **Authentication → URL Configuration**, acrescentar às *Redirect URLs*:

```
http://localhost:3000/auth/callback
https://SEU-DOMINIO/auth/callback
```

### 5. Criar o primeiro administrador

O papel `admin` **não é atribuível pelo registo** — o trigger `handle_new_user()` converte qualquer valor que não seja `teacher` em `student`. É deliberado: caso contrário, `{"role":"admin"}` no formulário de registo seria suficiente para tomar conta do sistema.

Registe-se normalmente e depois, no SQL Editor:

```sql
update public.profiles set role = 'admin' where email = 'voce@exemplo.pt';
```

---

## Estrutura do projeto

```
├── scripts/
│   ├── verify-schema.mjs    Migrações + regras de créditos contra PostgreSQL (WASM)
│   └── generate-icons.mjs   Ícones PNG provisórios da PWA, sem dependências
│
├── supabase/migrations/     Esquema SQL, por ordem de execução
│   ├── ..._enums.sql              tipos enumerados
│   ├── ..._core_tables.sql        organizações, perfis, alunos, locais, turmas
│   ├── ..._lessons.sql            aulas, participantes, presenças, histórico
│   ├── ..._notifications.sql      notificações, preferências, outbox
│   ├── ..._helpers.sql            funções auxiliares de RLS
│   ├── ..._rls_policies.sql       RLS + GRANTs por coluna + vistas de diretório
│   ├── ..._functions_triggers.sql triggers e funções de negócio
│   ├── ..._seed_sports.sql        modalidades globais
│   ├── ..._packages_enums.sql     estados de pacote, movimentações, cobrança
│   ├── ..._packages_tables.sql    modelos, pacotes, livro-razão, políticas
│   ├── ..._lesson_credits.sql     cobrança em lesson_participants + credit_cost
│   ├── ..._packages_rls.sql       RLS dos pacotes
│   ├── ..._credit_functions.sql   OPERAÇÕES ATÓMICAS DE CRÉDITOS
│   ├── ..._default_policy.sql     política de cancelamento por omissão
│   ├── ..._credit_hardening.sql   permissões, escopos, correções e ciclo de vida
│   ├── ..._student_claim_flow.sql ligação segura da conta à ficha de aluno
│   ├── ..._phase2_profile_settings.sql perfil público, contacto e modalidades N:N
│   ├── ..._phase2_access_hardening.sql vistas seguras, claim e bloqueio auditado
│   ├── ..._phase2_profile_validation_fix.sql correção incremental do telefone
│   ├── ..._phase3_management_schema.sql convites sem segredo e campos de gestão
│   ├── ..._phase3_management_security.sql RLS, GRANTs e vistas privadas da Fase 3
│   ├── ..._phase3_management_functions.sql invariantes e RPCs atómicas da Fase 3
│   ├── ..._phase4_package_templates.sql Etapa 1A: modelos reutilizáveis
│   ├── ..._phase4_package_assignment.sql Etapa 1B: atribuição de pacotes
│   ├── ..._phase4_package_read_views.sql Etapa 1C: consulta de pacotes e saldos
│   └── ..._phase4_package_admin.sql Etapa 1D: ajustes administrativos e histórico
│
└── src/
    ├── proxy.ts             Renova a sessão e protege rotas (era middleware.ts)
    │
    ├── app/
    │   ├── (marketing)/     Público: início, termos, privacidade
    │   ├── (auth)/          Entrar, criar conta, recuperar acesso, nova senha
    │   ├── auth/            Route Handlers: callback de email, terminar sessão
    │   ├── inicio/          Encaminha conforme o papel
    │   ├── professor/       Área do professor
    │   ├── aluno/           Área do aluno
    │   └── admin/           Área administrativa
    │
    ├── components/
    │   ├── ui/              Button, Field, Card, Alert, EmptyState, StatusBadge
    │   ├── layout/          AppShell, navegação, placeholders de fase
    │   ├── auth/            Componentes de autenticação
    │   ├── settings/        Formulários de conta, perfil público, avisos e segurança
    │   ├── admin/           Diretório, filtros, detalhe e estado de contas
    │   └── brand/           Logótipo
    │
    ├── lib/
    │   ├── actions/         Server Actions com reautenticação e updates explícitos
    │   ├── domain/          REGRAS DE NEGÓCIO PURAS (testadas, sem I/O)
    │   ├── validation/      Schemas Zod, partilhados cliente + servidor
    │   ├── supabase/        Clientes: server, client, proxy, admin
    │   ├── auth/            Leitura de sessão e guardas de papel
    │   ├── datetime.ts      único helper de conversão Europe/Lisbon na aplicação
    │   ├── env.ts           Validação das variáveis de ambiente
    │   └── utils.ts         cn(), initials(), firstName()
    │
    └── types/database.ts    Tipos da base de dados
```

---

## Convenções de código

### Idioma

| O quê | Idioma |
|---|---|
| Interface, rotas, mensagens de erro | **Português (pt-PT)** |
| Comentários e documentação | **Português** |
| Nomes de variáveis, funções e ficheiros | **Inglês** |
| Colunas e tabelas | **Inglês**, `snake_case` |

Rotas em português (`/professor/alunos`) porque são visíveis ao utilizador; código em inglês porque é a convenção do ecossistema e evita misturar idiomas a meio de uma expressão.

### Nomenclatura

- Ficheiros: `kebab-case.tsx`
- Componentes: `PascalCase`
- Funções e variáveis: `camelCase`
- Constantes de topo: `SCREAMING_SNAKE_CASE`
- Colunas SQL: `snake_case`

### Onde vive cada coisa

| Tipo de lógica | Onde | Porquê |
|---|---|---|
| Que ações são válidas | `lib/domain/` | Funções puras, testáveis sem base de dados |
| Formato dos dados | `lib/validation/` | Um schema Zod serve cliente e servidor |
| Orquestração de mutações | Server Actions | Validar → aplicar regra → gravar → revalidar |
| Integridade dos dados | Migrações SQL | Constraints e RLS não são contornáveis |

**Regra prática:** se conseguir escrever um teste sem base de dados, a lógica pertence a `lib/domain/`.

### Componentes

Server Components por omissão. `"use client"` apenas quando há estado, evento ou hook de browser — e no componente mais pequeno possível, para não arrastar a árvore inteira para o cliente.

### Páginas autenticadas

Qualquer layout ou página que dependa da sessão declara `export const dynamic = "force-dynamic"`.

Sem isso, o resultado passa a depender de haver credenciais no ambiente durante o `next build`: se não houver, o Next não deteta nada de dinâmico e gera **HTML estático** para páginas que exigem sessão. Uma página autenticada não pode ser estática por acidente.

### Datas e horas

**Nunca** usar `toLocaleString()`, `getDay()` ou `new Date("...T...")` diretamente sobre horários de aulas. O servidor corre em UTC e daria resultados errados.

Usar sempre `lib/datetime.ts`:

```ts
formatTime(lesson.starts_at)                    // "18:30"
formatRelativeDay(lesson.starts_at)             // "Hoje" · "Amanhã"
lisbonDayRange(new Date())                      // limites do dia, para consultar
lisbonInputToInstant("2026-08-10", "18:00")     // input do utilizador → instante
```

### Estados dos ecrãs

Nenhum ecrã está pronto sem os quatro: **carregamento** (`loading.tsx` com skeletons), **vazio** (`<EmptyState>`), **erro** (`error.tsx` em linguagem natural) e **sucesso**.

### Acessibilidade

Alvo: WCAG 2.1 AA. Os componentes de `components/ui/` já resolvem o essencial — usá-los em vez de `<input>` e `<button>` em bruto. Ao acrescentar componentes: rótulo associado, erro ligado por `aria-describedby`, foco visível, alvo de toque de 44px, e nunca depender só da cor.

---

## Segurança — regras que não se negoceiam

1. **Segredos só em variáveis de ambiente.** Nada de chaves no código, nem em comentários, nem em testes.
2. **`SUPABASE_SERVICE_ROLE_KEY` ignora o RLS.** Só em tarefas agendadas. `lib/supabase/admin.ts` tem `import "server-only"`, que faz a compilação falhar se for importado do cliente.
3. **RLS em todas as tabelas novas.** Com RLS ativo e sem policy, a tabela fica `default deny`; acrescente apenas as policies explícitas exigidas pelo cliente.
4. **Papéis nunca vêm do cliente.** O trigger `handle_new_user()` aceita `teacher` ou `student` e trata tudo o resto como `student`.
5. **Aulas nunca são apagadas.** Sem GRANT de DELETE, sem policy de DELETE, e um trigger que recusa estados terminais.
6. **`private_notes` nunca chega ao aluno.** `authenticated` não tem GRANT dessa coluna; leituras comuns usam listas explícitas e a vista `teacher_lesson_records` é reservada ao professor/admin.
7. **Autenticação sempre com `getUser()`.** `getSession()` apenas descodifica o cookie e acredita nele; serve para mostrar um nome, nunca para decidir um acesso.
8. **Contas bloqueadas perdem identidades funcionais.** `auth_org_id()`, `current_teacher_id()` e `current_student_id()` só devolvem valores para perfis ativos; o layout encaminha a conta para `/conta-bloqueada`.
9. **Estado de conta só pela RPC administrativa.** `admin_set_account_status()` exige admin ativo, recusa auto-bloqueio e deixa o estado anterior/novo e o motivo em `audit_log`.

### Perfis e definições (Fase 2)

- A conta privada vive em `profiles`; papel, organização, estado e email nunca fazem parte de um objeto de update do formulário.
- O perfil público do professor é atualizado atomicamente por `update_teacher_public_profile()`, incluindo `teacher_sports`.
- O aluno lê `student_self_profile`, `teacher_public_profiles` e `teacher_public_sports`; nunca a nota privada ou o convite da ficha.
- `claim_student_profile()` corre em `getSessionUser()` apenas depois de `auth.getUser()`, para uma conta de aluno ainda sem ficha. Email não confirmado, ambiguidade, ficha inativa/ligada ou conta bloqueada são recusados.
- O código de convite legado está definitivamente desativado: a coluna aceita apenas `NULL`, não tem GRANT e o parâmetro legado é recusado. Não o reativar.
- Sem bucket de Storage, o avatar é composto por iniciais. Não acrescentar um upload que não consiga persistir.
- Preferências de avisos já persistem; envio externo e tarefas agendadas continuam na Fase 8.

### Gestão operacional (Fase 3)

- Alunos e turmas pertencem ao professor da sessão; `organization_id`, proprietário, papel e estado protegido nunca vêm do formulário.
- `teacher_location_records` lista os locais disponíveis na organização. Só o responsável recebe `can_manage = true` e os campos administrativos; os restantes professores veem apenas os dados públicos em modo de consulta.
- As vistas `teacher_student_management_records`, `teacher_group_records` e `teacher_location_records` são os contratos de gestão. Observações privadas não entram nas projeções dos alunos nem de outros professores.
- `student_invitations` guarda apenas estado (`prepared`/`claimed`/`revoked`), email-alvo e auditoria. Não contém token, código ou URL e preparar não significa enviar email.
- A ligação continua a depender de email confirmado, correspondência única, ficha ativa e organização coerente; preparar/revogar é idempotente e auditado.
- Membros de turmas são alterados apenas por `add_group_member()` e `remove_group_member()`. A remoção fecha o período com `left_at`; uma reentrada cria uma nova linha e não apaga o período anterior.
- A política própria do professor é guardada por `save_teacher_cancellation_policy()` e resolvida por `resolve_cancellation_policy()`; desativá-la faz usar o fallback ativo da organização.

### Ao criar uma tabela nova

```sql
alter table public.nova enable row level security;
revoke all on public.nova from anon, authenticated;
grant select on public.nova to authenticated;
-- + policies explícitas de select / insert / update
```

---

## Base de dados

### Migrações

Nomeadas `YYYYMMDDHHMMSS_descricao.sql`, sempre acrescentadas — nunca editar uma migração já aplicada em produção.

Escrever de forma idempotente (`if not exists`, `create or replace`, `drop policy if exists` antes de `create policy`), para que reexecutar seja seguro.

### Depois de alterar o esquema

```bash
npm run db:verify   # corre as migrações num PostgreSQL local — apanha erros antes do push
npm run db:push
npm run db:types
npm run typecheck
```

### `npm run db:verify`

Executa **todas** as migrações, a partir de uma base vazia, contra PostgreSQL compilado para WebAssembly (PGlite), e volta a aplicá-las para confirmar idempotência. Depois exerce 292 garantias: RLS com papéis `authenticated`/`anon`, isolamento entre organizações e professores, privilégios das RPCs, perfis/claim/bloqueio, convites sem segredo, alunos, turmas, locais, modelos, atribuição, consulta e ajustes administrativos de pacotes, políticas, reserva, consumo, libertação, reagendamento, exceções, correções, imutabilidade do livro-razão e constraints herdadas das aulas.

Corre em segundos, sem Docker e sem projeto na nuvem — serve para o CI.

**O que não substitui:** um `db:push` a sério. O PGlite tem uma só ligação e não tem GoTrue nem PostgREST. As policies são exercidas diretamente no PostgreSQL, mas a API real, os JWTs e duas transações concorrentes sobre o último crédito continuam a precisar de um projeto Supabase/PostgreSQL real.

### Pacotes e créditos

Quatro tabelas formam este subsistema:

| Tabela | Responsabilidade |
|---|---|
| `package_templates` | Modelos reutilizáveis do professor; a atribuição copia as condições do momento |
| `student_packages` | Pacote concreto e os saldos atuais de um aluno |
| `package_credit_transactions` | Livro-razão permanente de todas as alterações de saldo |
| `cancellation_policies` | Prazo e decisão de cobrar/devolver, por organização ou professor |

Em `student_packages`, um crédito está sempre **disponível**, **reservado** ou **utilizado**. A base impõe:

```text
credits_available + credits_reserved + credits_used = credits_total
```

Agendar move disponível → reservado; concluir ou cobrar uma falta move reservado → utilizado; cancelar com devolução move reservado → disponível. `initial_credits` conserva o contratado e `credits_total` inclui ajustes posteriores.

Cada aluno numa aula tem uma linha em `lesson_participants`. As sete colunas de cobrança (`student_package_id`, `credits_reserved`, `credits_consumed`, `billing_status`, `is_exception`, `exception_reason`, `exception_authorized_by`) ligam essa participação a, no máximo, um pacote. `lessons.credit_cost` é apenas o custo por omissão; a cobrança efetiva é individual.

#### Escrita obrigatoriamente atómica

O frontend e as Server Actions **nunca** fazem `INSERT` direto em `student_packages`/`lesson_participants`, nem alteram saldos. Depois de validar o input e aplicar uma regra de domínio, chamam exatamente uma RPC:

| Operação | RPC |
|---|---|
| Atribuir pacote | `assign_student_package()` |
| Sugerir pacote compatível | `select_package_for_student()` |
| Reservar ao inscrever | `reserve_participation_credits()` |
| Libertar uma reserva | `release_participation_credits()` |
| Consumir uma reserva | `consume_participation_credits()` |
| Transferir num reagendamento | `transfer_participation_reservation()` |
| Ajuste administrativo pela interface | `admin_adjust_package_credits()` |
| Corrigir uma movimentação pela interface | `admin_correct_package_credit_transaction()` |
| Suspender pacote | `admin_suspend_student_package()` |
| Reativar pacote | `admin_reactivate_student_package()` |
| Cancelar pacote | `admin_cancel_student_package()` |
| Alterar validade | `admin_update_student_package_validity()` |
| Alterar início | `admin_update_student_package_start()` |

Não copiar esta lógica para React, para o browser ou para várias Server Actions. As RPCs de mutação validam sessão ativa, organização, proprietário, modalidade, estado/validade do pacote, estado da aula e saldo. Toda a **alteração de saldo** bloqueia as linhas relevantes e regista a movimentação na mesma transação. O seletor apenas lê; a transferência de reagendamento não cria movimento porque nenhum saldo muda.

#### Livro-razão e correções

`package_credit_transactions` é append-only: não há GRANT nem policy de `UPDATE`/`DELETE`, e um trigger recusa alterações mesmo numa ligação privilegiada. A atribuição inicial é registada automaticamente pelo trigger `record_package_creation()` na mesma transação que cria o pacote; se a escrita do histórico abortar, o pacote não fica criado a meio. Um erro corrige-se com uma movimentação compensatória através de `correct_package_credit_transaction()`, que preenche `corrects_transaction_id`; o original permanece intacto. Não “corrigir” apenas os números finais do pacote.

#### Atribuição de pacotes (Etapa 1B)

`assign_student_package()` é o único caminho da aplicação para criar `student_packages`. A função exige professor ativo, aluno ativo sob gestão desse professor, modelo ativo do próprio professor quando indicado, modalidade disponível na organização e `assignment_idempotency_key`.

O snapshot vive no próprio `student_packages`: `name`, `sport_id`, `initial_credits`, `starts_on`, `expires_on`, `paid_amount_cents`, `origin`, `notes` e saldos iniciais são gravados no momento da atribuição. `template_id` fica apenas como auditoria; editar ou desativar o modelo não altera pacotes já atribuídos.

A idempotência usa `student_packages.assignment_idempotency_key`, com índice único parcial por `created_by`. Repetir a mesma submissão devolve o pacote já criado; uma nova submissão intencional usa uma nova chave e pode criar outro pacote.

`origin` é administrativo (`purchased`, `gifted`, `manual`) e `paid_amount_cents`/`notes` não devem ser enviados ao aluno.

#### Consulta de pacotes e saldos (Etapa 1C)

As consultas da interface usam projeções próprias:

| View | Público | Campos |
|---|---|---|
| `teacher_package_records` | Professor responsável | Pacote, aluno, modalidade, modelo, saldos, valor registado, origem, observações e autoria |
| `student_package_records` | Próprio aluno | Nome, modalidade, saldos, datas, estado e timestamps básicos |
| `student_package_transaction_records` | Próprio aluno | Movimentos simples: atribuição, reserva, devolução e utilização |

O aluno não recebe `paid_amount_cents`, `origin`, `notes`, `created_by`, organização, professor, modelo ou saldos antes/depois do livro-razão. A aplicação também seleciona colunas explicitamente e não usa `select('*')`.

Regras visuais da Etapa 1C:

- **Saldo baixo:** 1 ou 2 créditos disponíveis.
- **Sem saldo:** 0 créditos disponíveis.
- **Validade próxima:** faltam 7 dias ou menos, usando datas civis em `Europe/Lisbon`.
- **Expirado:** `expires_on` anterior ao dia civil de Lisboa.

Estas regras vivem em `lib/domain/package-display.ts` e são partilhadas entre professor e aluno.

#### Ajustes administrativos e histórico (Etapa 1D)

- O professor ajusta pacotes em `/professor/pacotes/atribuicoes/[id]`; a lista global fica em `/professor/pacotes/historico`.
- Adicionar/remover créditos escreve em `package_credit_transactions` com `idempotency_key`; remoção só toca créditos disponíveis.
- Suspensão, reativação, cancelamento e alterações de datas escrevem em `student_package_audit_events`, append-only, e não criam movimentações de crédito de quantidade zero.
- Reativar usa `resolve_student_package_status()`; o professor não escolhe estados derivados como `active`, `expired` ou `depleted`.
- Cancelar é bloqueado quando existem créditos reservados; não apaga pacote, saldo ou histórico.
- Alterar início só é permitido antes de haver créditos reservados ou utilizados.
- A área do aluno continua sem motivos administrativos, autoria privada e saldos antes/depois.
- Datas civis de pacotes usam `Europe/Lisbon`; não usar `current_date` do servidor para derivar estado de pacote.

#### RLS e exceções

- Alunos leem apenas os próprios pacotes e movimentos; professores, apenas a sua organização; administradores têm leitura global.
- As funções `SECURITY DEFINER` verificam `auth.uid()` e autorização internamente. `PUBLIC` e `anon` não têm `EXECUTE` nas RPCs de créditos.
- Uma exceção manual exige `p_allow_exception = true`, política com `allow_manual_exceptions`, motivo de pelo menos três caracteres e autor identificado. `NULL` não significa autorização.
- Aula gratuita (`credit_cost = 0`) fica `exempt` sem ser exceção. Falta de saldo, pacote cancelado/fora da validade/de outra modalidade só é exceção quando explicitamente autorizada e auditada.

#### Ciclo de vida

- Reserva: apenas aula `scheduled` ou `confirmed`.
- Consumo: aula `completed`, ou desfecho do aluno cuja política determine cobrança (`cancelled_by_student`/`no_show_student`).
- Libertação: cancelamento ou falta com decisão de devolução.
- Reagendamento: a aula original está `rescheduled`, as referências nos dois sentidos coincidem e o destino não tem outra cobrança ativa para o aluno.

`resolveCreditOutcome()` em `lib/domain/packages.ts` decide cobrar/devolver conforme prazo e política; a Server Action futura aplica essa decisão chamando a RPC correspondente. As interfaces e essas orquestrações ainda pertencem às Fases 4–7.

### `src/types/database.ts`

As linhas são declaradas com `type`, **nunca com `interface`**. Um `interface` não é atribuível a `Record<string, unknown>` (pode ser aumentado por *declaration merging*), o esquema deixa de satisfazer `GenericSchema` do supabase-js, e **todas** as consultas passam a devolver `never` — com erros a aparecer em ficheiros longe da causa. A nota está no topo do próprio ficheiro.

---

## Testes

Vitest, ambiente Node, `TZ=Europe/Lisbon` fixo para que um teste que passa localmente passe também no CI (que corre em UTC).

Cobertura atual: **231 testes** em treze ficheiros — testes de domínio, regressões de respostas/autenticação do proxy, formulários da Fase 2, validação/normalização da gestão da Fase 3, modelos, atribuição, apresentação e ajustes administrativos de pacotes.

Os testes de domínio exercem funções puras, sem base de dados nem mocks. Os testes de validação garantem normalização, limites, identificadores, estados, valores monetários em cêntimos, datas civis e rejeição de campos extra/protegidos. A integração SQL fica separada em `db:verify`.

```bash
npm run test       # unidade/regressão (Vitest)
npm run db:verify  # integração PostgreSQL/RLS, base limpa + reaplicação
npm run check      # lint → typecheck → test → db:verify → build
```

Não existe um comando de formatação separado. Use `npm run lint:fix` apenas para correções mecânicas e reveja o diff. Antes de concluir uma alteração ou fase, `npm run check` tem de passar integralmente.

---

## Fases

| Fase | Âmbito | Estado |
|---|---|---|
| 1 | Projeto, layout, base de dados, autenticação | **Concluído** |
| 1.5 | Fundação técnica de pacotes/créditos e PWA, sem interfaces de gestão | **Concluído** |
| 2 | Perfis, definições e gestão administrativa básica de contas | **Concluído** |
| 3 | Alunos, turmas, locais, política de cancelamento | **Concluído** |
| 4 | Interfaces de modelos, atribuição, ajustes e saldos | **Parcialmente concluído** — Etapas 1A, 1B, 1C e 1D |
| 5 | Calendário e criação de aulas com reserva | **Planeado** |
| 6 | Cancelamento, reagendamento, presenças e histórico | **Planeado** |
| 7 | Área do aluno: aulas, créditos e confirmação | **Planeado** |
| 8 | Notificações, lembretes e expiração agendada | **Planeado** |
| 9 | Supabase real, concorrência, acessibilidade e deployment | **Parcialmente concluído** — RLS em PGlite e revisão básica de acessibilidade feitos; validação real/deployment pendentes |

**Ao concluir uma fase ou etapa:** `npm run check`, corrigir tudo o que falhe, atualizar `implementation_plan.md`, e resumir o que foi criado e como testar manualmente.

---

## Deployment (Vercel)

1. Importar o repositório na Vercel — o Next.js 16 é detetado automaticamente.
2. Definir as variáveis de ambiente (`.env.example` lista todas). `NEXT_PUBLIC_SITE_URL` tem de ser o domínio real, ou os links dos emails apontam para `localhost`.
3. Acrescentar `https://SEU-DOMINIO/auth/callback` às *Redirect URLs* do Supabase.

---

## Fora do âmbito do MVP

Pagamentos, subscrições, marketplace, reservas de campos, WhatsApp, app nativa, chat, rankings, IA, sistema financeiro.

Os pontos de extensão estão assinalados no código com `// EXTENSÃO:` e listados na secção 8 do [`implementation_plan.md`](implementation_plan.md). **Não implementar nada disto sem pedido explícito.**
