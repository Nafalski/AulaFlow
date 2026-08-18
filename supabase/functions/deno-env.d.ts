/**
 * O mínimo do ambiente Deno de que o entrypoint precisa.
 *
 * PORQUE É QUE ISTO EXISTE
 *
 * `index.ts` corre em Deno, não em Node, e o projeto não tem Deno instalado —
 * `deno check` não é uma opção aqui. A CLI do Supabase também não oferece
 * bundle sem deploy, e publicar a função só para a verificar seria publicá-la
 * sem fornecedor configurado.
 *
 * Deixá-lo sem verificação nenhuma era o que estava mal. Com estas declarações,
 * o `tsc --noEmit` do projeto passa a verificar o entrypoint a sério: que os
 * imports resolvem, que o `handler` recebe as dependências com a forma certa, e
 * que a ligação ao cliente Supabase está tipada. Não substitui um `deno check` —
 * não valida o especificador `jsr:` nem as permissões do runtime —, e é por isso
 * que isto está escrito aqui em vez de ser assumido.
 *
 * São declarações de TIPO. Não geram código, não entram no bundle e não são
 * usadas em tempo de execução: em produção, quem fornece `Deno` é o próprio
 * runtime, e quem fornece `createClient` é o registo JSR.
 */

declare namespace Deno {
  const env: {
    get(key: string): string | undefined;
  };

  function serve(handler: (request: Request) => Response | Promise<Response>): unknown;
}

declare module "jsr:@supabase/supabase-js@2" {
  /** Só o que o worker usa: uma chamada a RPC, com dados e erro. */
  export type WorkerSupabaseClient = {
    rpc(
      name: string,
      params?: Record<string, unknown>,
    ): Promise<{ data: unknown; error: unknown }>;
  };

  export function createClient(
    url: string,
    key: string,
    options?: { auth?: { persistSession?: boolean } },
  ): WorkerSupabaseClient;
}
