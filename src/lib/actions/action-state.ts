/** Estado inicial partilhado pelos formulários com `useActionState`. */
export const FORM_ACTION_IDLE_STATE = { status: "idle" } as const;

/**
 * As Form Actions do React 19 repõem automaticamente os campos não controlados
 * quando a Action termina. Como os erros de validação são devolvidos no estado
 * (e não lançados), essa reposição apagaria também dados que o utilizador ainda
 * precisa de corrigir. Os formulários de dados impedem o reset e, depois de uma
 * criação concluída, desativam explicitamente uma nova submissão.
 */
export function preserveFormValuesOnReset(event: { preventDefault: () => void }) {
  event.preventDefault();
}
