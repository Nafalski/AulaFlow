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
| `npm run db:verify:remote -- --confirm-development` | Verifica catálogo, migrações, RLS, grants, views e RPCs no Supabase remoto ligado |
| `npm run db:setup:e2e -- --confirm-development` | Cria/reutiliza contas e fichas E2E no Supabase de desenvolvimento usando service role local |
| `npm run db:verify:auth -- --confirm-development` | Valida Auth, JWT, PostgREST, RPCs, privacidade, isolamento e imutabilidade com sessões reais |
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
│   ├── ..._phase4_package_admin.sql Etapa 1D: ajustes administrativos e histórico
│   ├── ..._phase4_package_view_grants.sql grants explícitos das views da Fase 4
│   ├── ..._phase5_teacher_availability.sql Etapa 5A: disponibilidade, exceções e bloqueios
│   ├── ..._phase5_availability_view_grants.sql grants explícitos das views da Etapa 5A
│   ├── ..._phase5_calendar_projection.sql Etapa 5B: projeção de calendário e RPC segura do aluno
│   ├── ..._phase5_workspace_foundation.sql Etapa 5B.2A: workspaces tipados, membros e convites
│   ├── ..._phase5_workspace_security.sql Etapa 5B.2A: RLS, grants e projeções de workspace
│   ├── ..._phase5_workspace_functions.sql Etapa 5B.2A: RPCs atómicas de clubes e membros
│   ├── ..._phase5_workspace_grants.sql grants explícitos das views e funções da Etapa 5B.2A
│   ├── ..._phase5_club_calendar.sql Etapa 5B.2B: consentimento por membership e calendário do clube
│   ├── ..._phase5_club_calendar_states.sql Etapa 5B.2B: distinguir indisponível de fora do horário
│   ├── ..._phase5_club_calendar_outside_hours.sql Etapa 5B.2B: dia sem janela positiva é fora do horário
│   ├── ..._phase5_location_domain.sql Etapa 5B.3A: visibilidade, moderação e morada manual
│   ├── ..._phase5_location_security.sql Etapa 5B.3A: RLS, grants e projeções de locais
│   ├── ..._phase5_location_functions.sql Etapa 5B.3A: RPCs atómicas de locais
│   ├── ..._phase5_location_resources.sql Etapa 5B.3B: campos, salas e áreas de um local
│   ├── ..._phase5c_lesson_scheduling.sql Etapa 5C: contexto, recurso e RPCs de aulas
│   ├── ..._phase5d1_lesson_conflicts.sql Etapa 5D.1: conflitos atómicos de professor e recurso
│   ├── ..._phase5d2_lesson_credit_reservation.sql Etapa 5D.2: reserva atómica de créditos da aula
│   └── ..._phase5d3_weekly_lesson_recurrence.sql Etapa 5D.3: recorrência semanal segura
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
    │   ├── availability/    Horários, exceções e bloqueios do professor
    │   ├── workspaces/      Criação de clube, membros, convites e seletor de contexto
    │   ├── locations/      Locais, moradas manuais, moderação e recursos do local
    │   ├── lessons/        Formulário de criação e edição de aulas
    │   ├── admin/           Diretório, filtros, detalhe, estado de contas e clubes
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
6. **`private_notes` nunca chega ao aluno.** `authenticated` não tem GRANT dessa coluna; leituras comuns usam listas explícitas e a vista `teacher_lesson_schedule_records` é do professor da sessão. A vista `teacher_lesson_records` da Fase 2, que a dava a qualquer administrador, foi removida na 5C.
7. **Autenticação sempre com `getUser()`.** `getSession()` apenas descodifica o cookie e acredita nele; serve para mostrar um nome, nunca para decidir um acesso.
8. **Contas bloqueadas perdem identidades funcionais.** `auth_org_id()`, `current_teacher_id()` e `current_student_id()` só devolvem valores para perfis ativos; o layout encaminha a conta para `/conta-bloqueada`.
9. **Estado de conta só pela RPC administrativa.** `admin_set_account_status()` exige admin ativo, recusa auto-bloqueio e deixa o estado anterior/novo e o motivo em `audit_log`.
10. **`profiles.organization_id` é sempre pessoal.** Nunca apontar para um clube. É o que faz `auth_org_id()` nunca devolver um clube — e é por isso que uma membership não abre, sozinha, nenhuma policy de alunos, pacotes, locais ou disponibilidade.
11. **Membership de clube não é autorização operacional.** Dá acesso a nome e papel dos colegas e, com consentimento explícito, a disponibilidade genérica. Não acrescentar `SELECT` a tabelas existentes por causa de um clube: o calendário partilhado tem projeção própria e restrita.
12. **Partilhar a agenda é sempre uma decisão do próprio.** `calendar_sharing_enabled` nasce `false` e só muda por `set_workspace_calendar_sharing()`, que não aceita alvo. Não criar caminho para owner, manager ou admin forçarem a partilha de outra pessoa.
13. **Uma view nova não é privada por acidente.** No Supabase, views e funções herdam privilégios de `PUBLIC`/`anon` por omissão. Cada uma tem de ter `revoke all ... from public, anon` e um `grant` explícito — como em `..._workspace_grants.sql`. Não confiar na cláusula `WHERE` para fazer o trabalho de uma permissão.

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

### Locais e moradas manuais (Etapa 5B.3A)

**Sem integração externa.** Nenhuma chave, API, faturação, `google_place_id`, coordenada ou mapa. A morada é **escrita por uma pessoa** e é tratada em todo o lado como não validada por terceiros. Não escrever "morada verificada" nem sugerir validação externa.

**Um eixo, não dois.** `visibility` (`private`/`club`/`public`) determina também a propriedade. Não acrescentar um "tipo" paralelo: seriam os mesmos três valores duas vezes, com combinações impossíveis.

**`is_active` é o ciclo de vida; a moderação tem enum próprio.** `location_moderation_status` = `not_required`/`pending`/`approved`/`rejected`. Juntar "inactive" ao mesmo enum criaria o par contraditório `status='inactive'` com `is_active=true`.

**Aprovar ≠ morada correta.** `moderation_status='approved'` diz que um administrador aprovou a **ficha pública**. Não diz nada sobre a morada. `address_source='manual'` deixa a origem explícita no esquema.

| Âmbito | Onde vive | Quem administra |
|---|---|---|
| `private` | workspace pessoal, `teacher_id` do dono | o próprio professor |
| `club` | organização do clube, sem `teacher_id` | `owner`/`manager` do clube |
| `public` | workspace pessoal de quem propõe | o proponente; a decisão é do admin |

Um membro com papel interno `teacher` **consulta** os locais do clube mas não os administra.

**Escrita só por RPC.** `create_location`, `update_location`, `set_location_active` e `admin_moderate_location`. A tabela não tem GRANT de INSERT/UPDATE/DELETE: com colunas de moderação e autoria, a escrita direta deixaria o cliente aprovar-se a si próprio. `update_location` **não** muda visibilidade nem estado — promover um local a público tem de passar pela fila de moderação.

**SELECT por lista de colunas.** `internal_reference`, `notes`, `created_by`, `moderated_by`, `moderation_reason` e `creation_idempotency_key` ficam fora do GRANT partilhado; um `grant select` de tabela deixaria qualquer colega de clube — ou qualquer aluno da organização — lê-las por PostgREST.

Views: `teacher_location_records` (os seus, os do clube, os públicos aprovados) e `admin_location_moderation_records` (só propostas públicas).

**Retrocompatibilidade:** locais anteriores ficam `private`/`not_required`/`manual`. `teacher_id` **não** é exigido pelo trigger — a Fase 3 só atribuiu responsável em organizações com um professor, e editar os restantes não pode passar a ser impossível.

**Na 5B.3A ainda não existiam aulas.** Hoje as aulas existem na 5C, os conflitos de recurso entram na 5D.1 e a reserva de créditos acontece na 5D.2. Campos, salas e áreas passaram a existir na 5B.3B, abaixo.

### Campos, salas e áreas de um local (Etapa 5B.3B)

Um local pode conter **recursos**: campos, quadras, salas, áreas. É a futura unidade de **conflito físico** — dois professores às 18:00 no Campo 1 do mesmo local serão um conflito; no Campo 1 e no Campo 2, não.

**Aqui não existe nenhuma lógica de conflito, horário, reserva ou disponibilidade.** Isso exige aulas (5C) e conflitos (5D). Um recurso não tem estado de ocupação — não escrever "livre", "ocupado", "reservado", "vaga" ou "conflito" em nada que descreva um recurso.

**Tipos genéricos.** `location_resource_kind` = `court`/`room`/`area`/`other`. O AulaFlow serve ténis, padel, beach tennis, ginásio e aulas de sala; não acrescentar valores de uma modalidade só. O nome ("Campo 1", "Court Central", "Sala Funcional") é texto livre do utilizador.

**Sem capacidade.** Capacidade do espaço, máximo de alunos de uma aula e limite de uma turma são três regras diferentes; uma coluna `capacity` aqui seria lida como as três. Não a acrescentar sem necessidade concreta.

**Sem recursos em locais públicos.** Um trigger recusa-os. Um local público é visível a todos os professores, e deixar o proponente definir os campos que todos veriam dar-lhe-ia poder sobre trabalho alheio. A limitação é do servidor, não da interface.

**Herda o contexto do local.** `can_manage_location_resources()` é `can_manage_location()` mais a recusa de locais públicos — não repetir regras de clube nem de membership. Quem administra o local administra os seus recursos; um membro com papel `teacher` consulta.

**O aluno não lê recursos.** `can_read_location_resources()` exige professor ou admin. Um aluno lê `locations` porque precisa de saber onde é a aula; um recurso é hoje matéria de gestão. Quando a 5C ligar um recurso a uma aula, o aluno lê-o pela projeção dessa aula — não por acesso direto ao inventário do local.

**Escrita só por RPC.** `create_location_resource`, `update_location_resource`, `set_location_resource_active`. Sem GRANT de INSERT/UPDATE/DELETE: com autoria e chave de idempotência na tabela, a escrita direta permitiria forjar o autor.

**SELECT por lista de colunas.** `created_by` e `creation_idempotency_key` ficam fora do GRANT partilhado.

**Unicidade por local, só entre ativos.** `(location_id, lower(btrim(name))) where is_active`. Dois recursos ativos com o mesmo nome seriam indistinguíveis ao escolher um; um desativado não ocupa o nome; "Campo 1" existe legitimamente em milhares de locais. A foreign key é `on delete restrict`.

View: `teacher_location_resource_records` — é o contrato que a Etapa 5C vai consumir para oferecer recursos ao criar uma aula.

`locations.internal_reference` deixou de ser rotulado "Campo, quadra ou referência interna": passou a "Referência interna", para notas de acesso ao espaço. Não voltar a usá-lo como substituto de um recurso.

**Não implementado nesta camada de inventário:** disponibilidade/horário/reserva visual de recurso, créditos e notificações. Aulas existem na 5C, e a colisão real de recurso é validada só ao criar/editar aulas na 5D.1.

### Criação, edição, conflitos, créditos e recorrência de aulas (Etapas 5C, 5D.1, 5D.2 e 5D.3)

As aulas existem no esquema desde a Fase 1, mas só a 5C lhes deu um caminho de escrita real. A 5D.1 acrescenta a garantia transacional de conflitos de professor e recurso. A 5D.2 liga a aula ao ciclo financeiro: `create_lesson()` materializa participantes, seleciona pacote válido e reserva créditos na mesma transação. A 5D.3 acrescenta séries semanais seguras através de `create_recurring_lessons()`.

**Nunca escrever "campo livre", "vaga garantida" ou "crédito garantido" antes da submissão.** O banco impede sobreposição e reserva créditos no momento de gravar, mas a interface não deve apresentar disponibilidade futura como garantia absoluta antes da submissão. `LESSON_CONFLICT_PROTECTION_NOTICE` em `lib/domain/lesson-scheduling.ts` é o texto de limite do produto e está sob teste.

**`lessons.organization_id` é sempre a organização PESSOAL do professor.** Uma aula de clube guarda o clube em `club_organization_id`, com `context_kind = 'club'`. Pôr o clube em `organization_id` mudaria em silêncio o significado de todas as policies que já comparam com `auth_org_id()`. O clube é contexto, não propriedade.

**Cada professor cria e edita as suas aulas, inclusive dentro do clube.** `create_lesson()` **não tem parâmetro de professor**: deriva-o de `current_teacher_id()`. Ver o calendário de um colega — com o consentimento da 5B.2B — não é autorização para lhe escrever na agenda. Não acrescentar esse parâmetro sem uma necessidade de produto explícita.

**Escrita só por RPC.** `create_lesson()`, `create_recurring_lessons()` e `update_lesson()`. A Fase 1 tinha dado ao cliente `insert` em `lessons`/`lesson_participants` e `update` numa lista larga de colunas; a 5C revoga tudo isso. Com escrita direta, um PATCH contornaria disponibilidade, local, recurso e participantes.

| Validação | Onde |
|---|---|
| Aluno XOR turma | `create_lesson()` e o schema Zod |
| Local ativo, recurso do local, recurso ativo | trigger `validate_lesson_scope()` |
| Autorização de uso do local | `can_schedule_at_location()` |
| Janela dentro da disponibilidade e fora de bloqueios | `lesson_fits_teacher_availability()` |
| Sobreposição de professor, intervalo mínimo e recurso físico | trigger `ensure_lesson_has_no_conflict()` |
| Clube ativo e membership | `create_lesson()` |
| Seleção de pacote, saldo e validade | `select_package_for_student()` + `reserve_participation_credits()` |
| Recorrência semanal segura | `create_recurring_lessons()` + `create_lesson_occurrence()` interna |

`lesson_fits_teacher_availability()` reutiliza `resolve_teacher_availability_windows()` e `resolve_teacher_block_segments()` da 5B.2B — não duplicar a precedência nem a conversão de fuso. Funde períodos contíguos: uma aula das 12:30 às 13:30 cabe em `09:00–12:00` + `12:00–15:00`. Um intervalo real (o espaço entre `09:00–13:00` e `15:00–20:00`) continua a recusar. É **interna**: expô-la deixaria um professor sondar a agenda de outro por tentativa e erro.

**Uma aula não atravessa a meia-noite.** A rotina semanal é por dia da semana, e uma aula a cavalo de dois dias não é representável nela. Recusada com mensagem, em vez de aceite por engano.

**Turma: participantes materializados na criação.** `lesson_participants` recebe os membros ativos no momento. Alterar a turma amanhã não altera quem estava previsto para a aula de hoje — é isso que torna o histórico verdadeiro.

**Conflitos: só estados ativos bloqueiam.** `ensure_lesson_has_no_conflict()` usa advisory locks transacionais por professor e recurso, verifica `scheduled`/`confirmed`, aplica `teacher_profiles.minimum_break_minutes` e ignora estados históricos (`completed`, canceladas, reagendadas e faltas). Recurso `NULL` não bloqueia o local inteiro: a unidade física é `location_resource_id`.

**Pacotes: reserva atómica.** `lesson_participants` deixa de nascer com cobrança pendente quando há pacote válido: `reserve_participation_credits()` bloqueia o pacote, move saldo de disponível para reservado, escreve `credit_reserved` no livro-razão e marca a participação como `billing_status='reserved'`. A previsão no formulário é apenas leitura e não envia `student_package_id`; a escolha real volta a ser validada no PostgreSQL.

**Turma: tudo ou nada.** Se qualquer membro materializado não tiver pacote válido/saldo, a criação inteira falha e a transação desfaz aula, participantes, histórico, reservas e livro-razão. A mesma `idempotency_key` devolve a aula existente e não duplica reservas.

**Recorrência semanal: limitada e transacional.** Só existe repetição `weekly`, com intervalo fixo de 1 semana e contagem de 2 a 12 aulas. Não há recorrência diária, mensal, RRULE livre, repetição infinita, edição de série inteira nem "esta e futuras". A série é gerada por data e hora civis em `Europe/Lisbon`; não usar `starts_at + interval '7 days'` em UTC, porque a mudança de horário tem de preservar a hora local escolhida pelo professor.

`create_recurring_lessons()` é a única entrada pública da 5D.3. O browser envia intenção de recorrência, não envia lista de instantes, índice, grupo, pacote ou reserva. Cada ocorrência passa pela mesma validação de aula real: contexto, local, recurso, disponibilidade, conflitos, intervalo mínimo, materialização de aluno/turma, seleção de pacote e reserva de créditos. Se qualquer ocorrência falhar, a transação desfaz todas as ocorrências anteriores.

`lessons.recurrence_group_id` e `lessons.recurrence_rule` são metadados internos da série. A vista do professor mostra o grupo e os índices; a vista do aluno expõe só indicadores seguros, como "aula recorrente" e posição na série. Não acrescentar `recurrence_group_id`, regra completa, colegas, turma, custo, pacote ou notas privadas à projeção do aluno.

Cada ocorrência é editada como aula individual. Alterar a turma depois de criar uma série não muda os participantes já materializados, e cada ocorrência pode escolher um pacote diferente se a validade/saldo assim exigir.

**Projeções, e o que cada uma não tem:**

| View | Público | Nunca inclui |
|---|---|---|
| `teacher_lesson_schedule_records` | Professor da sessão | — (é o dono; inclui `private_notes`) |
| `student_lesson_records` | Aluno participante | colegas, contagem de participantes, turma, custo em créditos, `student_package_id`, saldos do pacote, `private_notes`, organização, `teacher_id`, autoria, `recurrence_group_id`, regra completa de recorrência |
| `lesson_participant_directory` | **Professor da aula** | `profile_id`; e o aluno já não a lê de todo |
| `teacher_lesson_participant_credit_records` | Professor da aula | `profile_id`, `student_package_id` e saldos totais do pacote |
| `schedulable_location_resource_records` | Professor | locais públicos (não têm recursos) |

**Correção de privacidade feita nesta etapa:** `lesson_participant_directory` deixava qualquer participante ler o nome e o `profile_id` dos colegas. Sem aulas de grupo isso nunca aconteceu; a partir da 5C aconteceria. Passou a ser do professor da aula.

**O aluno não lê `lessons` nem `lesson_change_history` diretamente** — só a sua projeção. O administrador da plataforma também não: moderar não é motivo para ler o conteúdo das aulas de ninguém.

**Edição:** só horário, local, recurso, título e observações, e só em `scheduled`/`confirmed`. Participante, modalidade e contexto não se editam — trocar o aluno é criar outra aula. As reservas já feitas são mantidas; ao mover a data, `update_lesson()` confirma que os pacotes reservados continuam válidos nessa nova data. O histórico é escrito pelo trigger `log_lesson_change()` da Fase 1, que também trata o caso "nada mudou": um `update_lesson()` sem alterações devolve `false` e não gera entrada.

**Não implementado:** presença, conclusão, cancelamento e reagendamento operacionais, edição/cancelamento de série inteira, libertação/consumo de créditos pela interface, confirmação pelo aluno, lista de espera, notificações.

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

Executa **todas** as migrações, a partir de uma base vazia, contra PostgreSQL compilado para WebAssembly (PGlite), e volta a aplicá-las para confirmar idempotência. Depois exerce 702 garantias: RLS com papéis `authenticated`/`anon`, isolamento entre organizações e professores, privilégios das RPCs, perfis/claim/bloqueio, convites sem segredo, alunos, turmas, locais, modelos, atribuição, consulta e ajustes administrativos de pacotes, disponibilidade do professor, calendário seguro, clubes, memberships, convites de workspace, papéis internos, contexto ativo, suspensão, consentimento de partilha por clube, projeção do calendário partilhado, grants estritos das views, políticas, reserva, consumo, libertação, reagendamento, exceções, correções, imutabilidade do livro-razão, locais, campos/salas/áreas, criação/edição de aulas, conflitos, reserva de créditos de aula, recorrência semanal, materialização de turmas e privacidade das projeções de aula.

Corre em segundos, sem Docker e sem projeto na nuvem — serve para o CI.

**O que não substitui:** um `db:push` a sério. O PGlite tem uma só ligação e não tem GoTrue nem PostgREST. As policies são exercidas diretamente no PostgreSQL, mas a API real, os JWTs e duas transações concorrentes sobre o último crédito continuam a precisar de um projeto Supabase/PostgreSQL real.

### `npm run db:verify:remote`

Executa uma verificação estrutural no Supabase remoto atualmente ligado pela CLI. O comando recusa correr sem confirmação explícita de desenvolvimento:

```bash
npm run db:verify:remote -- --confirm-development
```

Ele não cria utilizadores, não escreve dados de teste e não imprime credenciais. Verifica se as migrações locais estão aplicadas no remoto, se as tabelas/views/enums/índices/constraints de pacotes e disponibilidade existem, se RLS e grants protegem escrita direta, se as RPCs têm assinatura única, `search_path` seguro e `EXECUTE` restrito, e se as views do aluno/disponibilidade pública não expõem campos administrativos.

**O que não substitui:** login real por GoTrue, payloads PostgREST com JWTs reais, confirmação de email, teste visual no browser, concorrência entre ligações e o cenário ponta a ponta professor → aluno. Estes exigem contas de teste no projeto de desenvolvimento; a Fase 4 inclui essa validação real via `db:setup:e2e`, `db:verify:auth` e browser.

### E2E remoto com Auth real

Os scripts remotos de Auth recusam execução sem confirmação explícita de desenvolvimento:

```bash
npm run db:setup:e2e -- --confirm-development
npm run db:verify:auth -- --confirm-development
```

`db:setup:e2e` usa `SUPABASE_SERVICE_ROLE_KEY` apenas localmente para criar ou reutilizar as contas de teste, confirmar emails, marcar uma conta bloqueada e ligar fichas de aluno aos professores certos. A chave não é impressa e não deve existir em `NEXT_PUBLIC_*`.

`db:verify:auth` não usa service role para simular utilizadores. Entra com URL pública, anon key, email e senha E2E; obtém JWT real; executa PostgREST e RPCs como professor, aluno, segundo professor, segundo aluno, admin, conta bloqueada e anónimo, cobrindo pacotes, disponibilidade, privacidade, isolamento e imutabilidade.

Variáveis locais necessárias, sempre com valores de desenvolvimento e nunca commitadas:

```bash
SUPABASE_SERVICE_ROLE_KEY=...
E2E_TEACHER_EMAIL=...
E2E_TEACHER_PASSWORD=...
E2E_STUDENT_EMAIL=...
E2E_STUDENT_PASSWORD=...
E2E_TEACHER_B_EMAIL=...
E2E_TEACHER_B_PASSWORD=...
E2E_STUDENT_B_EMAIL=...
E2E_STUDENT_B_PASSWORD=...
E2E_ADMIN_EMAIL=...
E2E_ADMIN_PASSWORD=...
E2E_BLOCKED_EMAIL=...
E2E_BLOCKED_PASSWORD=...
```

`E2E_RUN_ID` é opcional. O valor `default` reutiliza o mesmo pacote E2E; outro valor cria um fluxo identificado por esse sufixo. Não usar dados pessoais reais nem senhas reais.

### Checklist manual do Auth no Supabase

A CLI usada no projeto valida banco, migrações e sessões reais, mas não substitui a configuração do painel Auth. Ao repetir a validação noutro ambiente de desenvolvimento, confirmar no Supabase:

- **Authentication → Providers → Email:** provider Email ativo.
- **Authentication → Providers → Email:** confirmação de email ativa.
- **Authentication → URL Configuration:** Site URL `http://localhost:3000`.
- **Authentication → URL Configuration:** Redirect URL `http://localhost:3000/auth/callback`.
- **Authentication → URL Configuration:** acrescentar o domínio real quando existir deployment.
- **Authentication → Email Templates / SMTP:** envio padrão do Supabase pode ter limite de desenvolvimento; não implementar serviço externo nesta etapa.
- **Password recovery:** fluxo aponta para `NEXT_PUBLIC_SITE_URL` e volta para `/auth/callback` ou `/redefinir-senha` conforme o link.

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

### Disponibilidade e calendário (Etapas 5A, 5B e 5B.1)

A fonte de verdade da agenda do professor fica separada de aulas, participantes e créditos:

| Estrutura | Responsabilidade |
|---|---|
| `teacher_availability_rules` | Períodos semanais em hora civil local (`weekday`, `starts_at`, `ends_at`) |
| `teacher_availability_exceptions` | Disponibilidade positiva numa data civil, em modo `add` ou `replace` |
| `teacher_schedule_blocks` | Bloqueios específicos, parciais ou de dia inteiro, com motivo/categoria privados |
| `teacher_profiles` | Preferências simples: `default_lesson_duration_minutes` e `minimum_break_minutes` |

Rotina semanal usa hora civil local de `Europe/Lisbon` e não é convertida para UTC. Bloqueios específicos são instantes (`timestamptz`) e devem ser criados a partir de input local usando `lisbonInputToInstant()`. Bloqueios de dia inteiro usam fim exclusivo.

Precedência, também implementada em `resolve_teacher_availability_for_date()`:

1. bloqueio ativo;
2. exceção da data;
3. rotina semanal;
4. indisponível por padrão.

Intervalos simples são representados pelo espaço entre períodos do mesmo dia, por exemplo `09:00–13:00` e `15:00–20:00`. O intervalo mínimo entre marcações é aplicado na criação/edição de aulas pela 5D.1.

A interface vive em `/professor/definicoes/disponibilidade`. Server Actions chamam RPCs (`save_teacher_availability_preferences`, `upsert_teacher_availability_rule`, `upsert_teacher_availability_exception`, `upsert_teacher_schedule_block` e cancelamentos/desativações correspondentes). O browser nunca envia organização, professor, autor ou timestamps.

A view legada `teacher_availability_public_records` ficou sem `SELECT` direto para `authenticated` na Etapa 5B. A interface de calendário usa RPCs:

| RPC | Público | Campos |
|---|---|---|
| `get_teacher_availability_calendar(p_start_date, p_end_date)` | Professor ativo | Data, origem, `source_id`, períodos, estado, motivo/categoria dos próprios bloqueios |
| `get_student_availability_calendar(p_start_date, p_end_date)` | Aluno ativo com ficha ligada | Data, início, fim e estado |

Ambas recusam intervalos vazios, invertidos ou superiores a 42 dias. A RPC do aluno deriva o professor de `current_student_id()` e da ficha ligada; o browser do aluno nunca envia `teacher_id` e nunca recebe `source`, `source_id`, motivo, categoria, organização, professor ou auditoria. Bloqueios ativos cortam os intervalos disponíveis para que um período bloqueado nunca apareça como livre.

A interface vive em `/professor/calendario` e `/aluno/calendario`, com vistas por dia, semana e mês via query params `data` e `vista`. O calendário do professor mostra detalhes privados e prévia de inícios possíveis com a duração/intervalo das preferências; o do aluno mostra apenas disponibilidade segura.

Na Etapa 5B.1, a apresentação visual passou a usar:

- **Dia:** uma coluna temporal, horas na lateral, faixa de dia inteiro e blocos proporcionais à duração.
- **Semana desktop:** sete colunas alinhadas, cabeçalho de dias, horas na lateral, grelha com linhas de 30 minutos e blocos posicionados por minutos.
- **Semana mobile:** faixa horizontal de dias e timeline do dia selecionado, sem apertar sete colunas no telefone.
- **Mês:** grelha tradicional de cinco ou seis semanas, sem linha temporal de horas; cada célula mostra apenas resumos reais de disponibilidade, bloqueio ou exceção.
- Linha de "agora" apenas no cliente, depois da hidratação, atualizada por minuto e respeitando `Europe/Lisbon`.

`src/lib/domain/calendar.ts` centraliza janela selecionada, navegação civil, faixa horária visível, labels de horas, posição proporcional dos blocos e camada visual. O componente cliente recebe apenas strings, números, booleanos, arrays e objetos literais.

**Fora do âmbito original destas etapas:** criação de aulas, calendário de aulas reais, recorrência, participantes, reservas/consumo de créditos, presenças, cancelamentos/reagendamentos de aulas, confirmação do aluno, lista de espera, notificações, calendário compartilhado entre professores, recursos/campos de clube, Google Calendar, Apple Calendar, ICS e drag-and-drop. Parte desse trabalho já avançou em etapas posteriores; manter esta lista como memória histórica da 5A/5B.

### Clubes, workspaces e membros (Etapa 5B.2A)

**Decisão arquitetural: `organizations` é o workspace.** A auditoria concluiu que a tabela já era o que um clube precisaria de ser — nome, slug, timezone, timestamps e o eixo de isolamento de todas as tabelas. Criar `clubs` ao lado duplicaria o conceito. `organizations` ganhou `kind` (`personal`/`club`), `status`, autoria e campos de suspensão; o vínculo pessoa↔workspace vive em `organization_members`.

**A regra que não pode ser quebrada:**

> `profiles.organization_id` é sempre o workspace **pessoal** e **nunca** aponta para um clube.

`auth_org_id()` lê essa coluna, portanto nenhum clube é a organização de RLS de ninguém. Entrar num clube não abre nenhuma policy existente de alunos, pacotes, locais ou disponibilidade — todas comparam com `auth_org_id()`. **Não escrever policies que dêem acesso a dados operacionais por causa de uma membership.**

| Estrutura | Responsabilidade |
|---|---|
| `organizations.kind`/`status` | Workspace tipado (`personal`/`club`) e moderável |
| `organization_members` | Vínculo N:M, papel interno, estado e auditoria de entrada/saída |
| `organization_invitations` | Convite sem segredo: estado, email-alvo e auditoria |
| `profiles.active_workspace_id` | Preferência de contexto, sem GRANT de UPDATE |

Papéis internos (`owner`, `manager`, `teacher`) são **distintos** dos papéis globais. Criar um clube não altera `profiles.role` e não torna ninguém administrador da plataforma.

Invariantes impostos em SQL, não na interface: ninguém é convidado para `owner`; ninguém altera o próprio papel; o papel do proprietário não muda por esta via; o último proprietário ativo não pode ser removido; só um proprietário remove outro; `manager` convida apenas `teacher`.

**Convites não têm token.** Estado, email-alvo e auditoria — como em `student_invitations`. Aceitar exige sessão autenticada com esse email **confirmado**. Não reintroduzir tokens, códigos ou URLs com segredo.

**Contexto ativo não é autorização.** `set_active_workspace()` guarda a preferência; `resolve_active_workspace_id()` revalida em cada leitura e devolve o workspace pessoal se o vínculo tiver caído. Nunca decidir acesso a partir do valor guardado.

**Suspender não apaga.** Memberships, convites e auditoria ficam; as operações é que param. Suspender um workspace pessoal é recusado — isso é bloquear a conta, que tem caminho próprio em `admin_set_account_status()`.

RPCs (`create_club_workspace`, `invite_workspace_member`, `revoke_workspace_invitation`, `accept_workspace_invitation`, `decline_workspace_invitation`, `update_workspace_member_role`, `remove_workspace_member`, `admin_set_workspace_status`, `set_active_workspace`) são o único caminho de escrita: as tabelas não têm GRANT de INSERT/UPDATE/DELETE.

Views: `workspace_membership_records` (contextos próprios), `workspace_member_directory` (nome e papel dos colegas — sem email, telefone, alunos, pacotes ou agenda), `workspace_invitation_records` (gestão), `workspace_received_invitation_records` (convites dirigidos ao próprio) e `admin_workspace_directory` (moderação).

Interface: `/professor/clubes`, `/professor/clubes/[id]`, `/professor/convites`, `/admin/clubes` e o seletor de contexto no shell do professor.

**Limite honesto:** mudar de contexto **não** torna alunos, pacotes, turmas, locais, disponibilidade ou calendário multi-clube. `PERSONAL_ONLY_MODULES` em `lib/domain/workspaces.ts` é mostrado ao utilizador em vez de fingir o contrário. Não anunciar módulos como multi-clube antes de o serem.

### Calendário partilhado do clube (Etapa 5B.2B)

**Entrar num clube não partilha a agenda.** O consentimento vive na membership:

```sql
organization_members.calendar_sharing_enabled boolean not null default false
```

Está na membership, e não em `teacher_profiles`, porque uma preferência global obrigaria a escolher entre partilhar com todos os clubes ou com nenhum. Ativar no Clube A não ativa no Clube B, e sair de um clube leva o consentimento consigo.

**Só o próprio altera.** `set_workspace_calendar_sharing(p_organization_id, p_enabled)` **não aceita alvo** — deriva a membership de `auth.uid()` e do clube. Proprietário, gestor e administrador da plataforma não têm sequer um parâmetro por onde tentar forçar a partilha de um colega. Não acrescentar esse parâmetro.

| Contrato | Público | Campos |
|---|---|---|
| `get_club_availability_calendar(p_organization_id, p_start_date, p_end_date, p_membership_id)` | Membro ativo de clube ativo | `membership_id`, `teacher_name`, `date`, `starts_at`, `ends_at`, `status` |
| `club_calendar_member_directory` | Membro ativo de clube ativo | `membership_id`, `organization_id`, `teacher_name`, `role`, `calendar_sharing_enabled`, `is_self` |

O calendário do clube **nunca** devolve `source`, `source_id`, `reason`, `category`, `all_day`, IDs de regra/exceção/bloqueio, `teacher_id`, `profile_id`, organização pessoal, autoria, email ou telefone.

**Os quatro estados, e como cada um é representado:**

| Estado | Representação |
|---|---|
| `available` | Linha `available` com horas |
| `unavailable` | Linha `unavailable` com horas — **só** quando o servidor prova que o horário pertence a uma janela positiva cortada por bloqueio ativo |
| `outside_hours` | **Ausência de linha.** Inclui dias inteiros sem rotina: sem janela positiva não há indisponibilidade a comunicar |
| `not_shared` | Nenhuma linha e `calendar_sharing_enabled = false` no diretório |

A projeção devolve **apenas segmentos com horas**. A regra que sustenta isto: **não marcar como indisponível o que o servidor não consegue provar pertencer a uma janela positiva**. Um bloqueio pessoal num dia sem rotina não produz linha nenhuma — além de ser a etiqueta errada, sinalizá-lo diria ao colega que ali há alguma coisa num dia em que o professor nem trabalha. Uma pausa de almoço — que a Etapa 5A representa como o espaço entre `09:00–13:00` e `15:00–20:00` — é ausência, não bloqueio. Deduzir "buraco = ocupado" no cliente marcaria almoços como indisponibilidade.

Para calcular a interseção (janela ∩ bloqueio) sem duplicar regras, a precedência e o recorte de fuso vivem em `resolve_teacher_availability_windows()` e `resolve_teacher_block_segments()`; `resolve_teacher_availability_calendar_core()` é construído a partir delas. As três são internas — sem `EXECUTE` para `authenticated`, porque devolvem motivo, categoria e IDs de origem.

Quem não consentiu não produz linha nenhuma. A interface distingue "indisponível" de "não partilhada" pelo diretório, não pelo calendário, e explica "fora do horário" numa legenda — espaço vazio não se explica sozinho.

**Autorização:** professor global ativo + membership `active` + `kind = 'club'` + `status = 'active'`. `active_workspace_id` **não** participa da decisão. O filtro `p_membership_id` é revalidado: tem de ser uma membership ativa **deste** clube, caso contrário é recusado em vez de devolver vazio.

Interface em `/professor/clubes/[id]/calendario`, com filtro por professor no URL. O componente `AvailabilityCalendar` ganhou a audiência `club`: as verificações de privacidade passaram a perguntar `audience !== "teacher"`, para que uma audiência futura nasça segura. `calendarHref()` preserva a query já presente no `basePath` — é assim que o filtro sobrevive a Dia/Semana/Mês, anterior, seguinte e "Hoje".

**Não implementado:** aulas, participantes, locais, campos, recursos, conflitos, reservas e créditos. Os únicos estados são disponível e indisponível — não escrever "ocupado", "reservado", "lotado", "vagas" ou "conflito", porque nada disso existe ainda para ser verdade.

Ordem atual: 5D.3 recorrência fechada → 5D.4 revisão integrada do agendamento → ciclo operacional posterior.

### `src/types/database.ts`

As linhas são declaradas com `type`, **nunca com `interface`**. Um `interface` não é atribuível a `Record<string, unknown>` (pode ser aumentado por *declaration merging*), o esquema deixa de satisfazer `GenericSchema` do supabase-js, e **todas** as consultas passam a devolver `never` — com erros a aparecer em ficheiros longe da causa. A nota está no topo do próprio ficheiro.

---

## Testes

Vitest, ambiente Node, `TZ=Europe/Lisbon` fixo para que um teste que passa localmente passe também no CI (que corre em UTC).

Cobertura atual: **487 testes** em vinte e seis ficheiros — testes de domínio, regressões de respostas/autenticação do proxy, formulários da Fase 2, validação/normalização da gestão da Fase 3, modelos, atribuição, apresentação, navegação, ajustes administrativos de pacotes, disponibilidade do professor, calendário, permissões de clube, validação de workspaces, regras do calendário partilhado, domínio de locais, recursos de locais e agendamento de aulas com reserva de créditos e recorrência semanal.

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
| 4 | Interfaces de modelos, atribuição, ajustes e saldos | **Concluído** — Etapas 1A, 1B, 1C, 1D e 1E validadas com Auth/PostgREST reais e browser desktop/mobile |
| 5 | Calendário e criação de aulas com reserva | **Parcialmente concluído** — Etapas 5A a 5D.3: disponibilidade, projeção segura, refinamento visual, clubes/membros, calendário partilhado, locais com moradas manuais, campos/salas/áreas, criação/edição de aulas, conflitos atómicos, reserva atómica de créditos e recorrência semanal segura. Falta revisão integrada e ciclo operacional posterior |
| 6 | Cancelamento, reagendamento, presenças e histórico | **Planeado** |
| 7 | Área do aluno: aulas, créditos e confirmação | **Planeado** |
| 8 | Notificações, lembretes e expiração agendada | **Planeado** |
| 9 | Supabase real, concorrência, acessibilidade e deployment | **Parcialmente concluído** — RLS em PGlite e validação real da Fase 4/Etapas 5A-5D.3 feitos; concorrência real de aulas/créditos/recorrência coberta, acessibilidade completa e deployment pendentes |

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
