# AulaFlow - prontidao para producao

## Estado

- **Fase 8:** fechada em DEV.
- **Fase 9A:** auditoria de prontidao concluida em 25 de agosto de 2026.
- **Fase 9:** aberta ate existir um ambiente de producao criado, configurado e validado.
- **Lancamento em producao:** nao iniciado.

O ambiente publico atual, `https://aulaflow-dev.vercel.app`, continua a ser DEV.
As contas `@aulaflow.test`, o projeto Supabase `fzkwacnpydoqhxipcvro` e os comandos
com `--confirm-development` nunca fazem parte do bootstrap de producao.

## Ambientes e variaveis

| Variavel | Classe | Onde e necessaria |
|---|---|---|
| `NODE_ENV` | runtime do framework | Next server e browser build; ativa cookies `Secure` e torna o Site URL explicito em producao |
| `NEXT_PUBLIC_SUPABASE_URL` | browser-publica | build/runtime Next; URL publica do Supabase do proprio ambiente |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser-publica | build/runtime Next; chave publica protegida por RLS, grants e projecoes |
| `NEXT_PUBLIC_SITE_URL` | browser-publica | build/runtime Next; base canonica dos callbacks; obrigatoria, sem fallback em producao |
| `SUPABASE_SERVICE_ROLE_KEY` | servidor/script administrativo | scripts E2E locais; o runtime Next atual nao a consome; a Edge recebe uma copia injetada pelo Supabase |
| `SUPABASE_URL` | Edge-only, injetada | `notification-email-worker` |
| `AULAFLOW_EMAIL_WORKER_TOKEN` | Edge-only, secreta | autentica o pedido `pg_net -> Edge Function`; o mesmo valor vive no Vault |
| `RESEND_API_KEY` | Edge-only, secreta | transporte Resend |
| `AULAFLOW_EMAIL_FROM` | Edge-only | remetente verificado no fornecedor |
| `AULAFLOW_SITE_URL` | Edge-only | base HTTPS dos links nos emails |
| `AULAFLOW_SUPABASE_PROJECT_REF` | script administrativo | alvo esperado dos verificadores; opcional em DEV porque o ref atual e o default fechado |
| `AULAFLOW_REMOTE_VERIFY` | script administrativo | alternativa automatizada a `--confirm-development`; apenas DEV |
| `E2E_RUN_ID`, `E2E_BASE_DATE` | local/E2E | isolamento e relogio das fixtures remotas |
| `E2E_TEACHER_EMAIL`, `E2E_TEACHER_PASSWORD` | local/E2E | professor A |
| `E2E_STUDENT_EMAIL`, `E2E_STUDENT_PASSWORD` | local/E2E | aluno A |
| `E2E_TEACHER_B_EMAIL`, `E2E_TEACHER_B_PASSWORD` | local/E2E | professor B |
| `E2E_STUDENT_B_EMAIL`, `E2E_STUDENT_B_PASSWORD` | local/E2E | aluno B |
| `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` | local/E2E | administrador |
| `E2E_BLOCKED_EMAIL`, `E2E_BLOCKED_PASSWORD` | local/E2E | conta bloqueada |

So as tres variaveis `NEXT_PUBLIC_*` podem entrar num bundle de browser. A URL
e a chave publica do Supabase nao sao segredos. Service role, Resend, token do
worker e credenciais E2E nao podem ser configurados com esse prefixo.

## Fronteira DEV/producao

| Ocorrencia | Classificacao | Decisao |
|---|---|---|
| `localhost` no arranque, `.env.example` e browser E2E | A: correto em local/teste | manter |
| fallback local de `NEXT_PUBLIC_SITE_URL` | A fora de producao | em producao a variavel passou a ser obrigatoria |
| ref `fzkwacnpydoqhxipcvro` nos verificadores | A: trava do DEV | manter; nao substituir silenciosamente por producao |
| `aulaflow.test` em fixtures e testes | A: isolamento E2E | manter; nunca criar estas contas em producao |
| `aulaflow-dev.vercel.app` | A: deploy publico controlado | nao tratar como dominio de clientes |
| callbacks de Auth e links de email | B: derivados do ambiente | usar os dominios reais de cada ambiente |

## Auth e navegador

As rotas reais sao `/entrar`, `/criar-conta`, `/recuperar-acesso`,
`/redefinir-senha`, `/auth/callback` e `POST /auth/sair`. O callback aceita PKCE
e OTP legado, e `proximo` aceita apenas caminhos internos que comecem por uma
unica `/`. A autorizacao usa `auth.getUser()`, layouts dinamicos por papel,
Server Actions reautenticadas e RLS; o proxy faz apenas renovacao e triagem.

O cookie SSR e `SameSite=Lax`, deliberadamente nao `HttpOnly` porque o cliente
Supabase do browser precisa da sessao, e `Secure` em producao. A Vercel faz
redirect HTTP -> HTTPS e fornece HSTS. A aplicacao acrescenta globalmente
`nosniff`, `DENY` para frames, referrer estrito e nega camera, microfone e
geolocalizacao. Uma CSP com nonce continua como hardening P2: nao deve ser
improvisada sobre scripts do Next e Server Actions.

## Base de dados e email

A cadeia tem 66 migracoes incrementais e constroi uma base vazia pelo
`db:verify`. `db push --dry-run` tem de dizer `upToDate: true` antes e depois de
um deploy. Em Supabase hospedado, as migracoes ativam `pg_cron` e `pg_net`; o
Vault e fornecido como `supabase_vault`. Os jobs esperados sao:

| Job | Agenda | Dependencia |
|---|---|---|
| `aulaflow-scheduled-notifications` | `5 * * * *` | esquema migrado |
| `aulaflow-email-worker` | `* * * * *` | Edge ativa + dois segredos no Vault |

O worker exige `AULAFLOW_EMAIL_WORKER_TOKEN`, `RESEND_API_KEY`,
`AULAFLOW_EMAIL_FROM` e `AULAFLOW_SITE_URL`; `SUPABASE_URL` e
`SUPABASE_SERVICE_ROLE_KEY` sao injetadas pelo Supabase. No Vault vivem apenas
`aulaflow_email_worker_url` e `aulaflow_email_worker_token`. A fila usa lease,
ownership, retry limitado e chave idempotente estavel por entrega.

O remetente de teste do DEV nao serve clientes. Antes do primeiro email real,
o proprietario tem de verificar no Resend um dominio/remetente de producao e o
DNS correspondente.

## Visibilidade operacional

Hoje os erros Next e Server Actions ficam nos logs da Vercel; erros de RPC nos
logs do Postgres/API; erros Edge nos logs da funcao; execucoes em
`cron.job_run_details`; HTTP do worker em `net._http_response`; e entregas em
`notification_deliveries`, incluindo `pending`, `retry`, `failed`, `skipped` e
o ultimo erro. Isto permite diagnostico manual sem fornecedor novo.

Antes do primeiro cliente deve existir um responsavel e uma rotina escrita para
rever falhas Vercel/Supabase, cron, `pg_net` e outbox. Alertas automaticos e um
servico dedicado de error tracking sao P2 apos o lancamento, nao condicao para
criar o ambiente.

## PWA e acessibilidade

O manifesto publico tem `start_url=/inicio`, `scope=/`, `display=standalone`,
tema, idioma, icones 192/512 e icone maskable; o layout tem viewport movel e
metadados para iOS. A instalacao no ecra inicial e suportada. Service worker,
offline e push continuam opcionais e fora do escopo atual.

Os fluxos de login, calendarios, aulas, avisos, preferencias e pacotes usam
rotulos, feedback acessivel, foco visivel, skip link, navegacao semantica e
alvos moveis de 44 px. O gate de browser cobre 390 px, overflow, feedback e
erros de runtime. Uma auditoria assistiva externa e testes continuos de
contraste ficam como P2; nao foi encontrada violacao funcional que exija
redesign na 9A.

## Ordem de criacao do futuro ambiente de producao

1. Escolher o dominio publico e o remetente de email; nao reutilizar DEV.
2. Criar um projeto Supabase de producao numa regiao europeia e guardar as credenciais fora do repositorio.
3. Ligar a CLI explicitamente ao novo project ref e conferir o alvo antes de qualquer comando.
4. Aplicar as 66 migracoes com `db push`; nunca usar reset remoto.
5. Confirmar `pg_cron`, `pg_net`, Vault, os dois jobs unicos e `db push --dry-run` sem pendencias.
6. Executar um verificador de catalogo read-only proprio para producao; nao usar `--confirm-development` nem os verificadores Auth/E2E atuais.
7. Ativar Email Auth, exigir confirmacao, definir o Site URL HTTPS e permitir exatamente `https://DOMINIO/auth/callback`.
8. Registar a primeira conta operacional e promover o primeiro admin pelo procedimento controlado; nao executar `db:setup:e2e`.
9. Criar o projeto Vercel de producao ligado a `main`.
10. Configurar na Vercel somente `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `NEXT_PUBLIC_SITE_URL` do ambiente de producao.
11. Fazer o primeiro deploy Next e validar HTTPS, cabecalhos, paginas publicas, callback e rotas protegidas.
12. Verificar no Resend o dominio/remetente real de producao e concluir o DNS exigido pelo fornecedor.
13. Definir os quatro segredos do worker no projeto Supabase de producao, com Site URL e remetente reais.
14. Publicar `notification-email-worker` e provar 401 sem token, 401 com token errado e resposta autorizada sem expor o token.
15. Gravar no Vault o URL exato da Edge e o mesmo token do worker; confirmar os jobs e uma resposta `pg_net` 2xx.
16. Fazer um envio controlado apenas para uma caixa de QA autorizada e confirmar idempotencia, estado `sent` e ausencia de duplicado.
17. Executar smoke de professor e aluno com contas de QA de producao criadas manualmente, rever logs/outbox e so depois decidir a data do primeiro cliente.

## Classificacao da 9A

- **P0:** nenhum achado no repositorio atual.
- **P1 corrigidos:** Site URL explicito em producao; cookie `Secure`; cabecalhos basicos e remocao de `X-Powered-By`.
- **P1 antes do primeiro cliente:** criar/configurar os recursos externos acima; criar modo de verificacao de catalogo read-only para producao; definir o responsavel e a rotina operacional; validar o sender real.
- **P2:** CSP por nonce, alerta automatico/error tracking, auditoria assistiva externa, `global-error.tsx` para falhas do root layout e service worker/offline/push se o produto vier a pedir.
- **Nao bloqueia:** app nativa, pagamentos, calendarios externos, Places, WhatsApp, push e self-cancel.
