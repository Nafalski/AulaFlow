"use client";

import { Search, UserMinus, UserPlus, UserRound } from "lucide-react";
import { useActionState, useState } from "react";

import { ActionMenu } from "@/components/ui/action-menu";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField, TextField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { addGroupMemberAction, removeGroupMemberAction } from "@/lib/actions/groups";

type Person = { id: string; fullName: string; email: string | null };

function AddMemberForm({ groupId, student }: { groupId: string; student: Person }) {
  const [state, formAction, pending] = useActionState(addGroupMemberAction, FORM_ACTION_IDLE_STATE);

  return (
    <form action={formAction} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-field)] border border-line p-3">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="studentId" value={student.id} />
      <div className="min-w-0">
        <p className="font-semibold text-ink">{student.fullName}</p>
        {student.email && <p className="truncate text-xs text-muted">{student.email}</p>}
      </div>
      <Button type="submit" variant="outline" loading={pending} loadingLabel="A adicionar" icon={<UserPlus className="size-4" aria-hidden="true" />}>
        Adicionar
      </Button>
      {state.message && <div className="w-full"><Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert></div>}
    </form>
  );
}

/**
 * Um membro da turma.
 *
 * Antes, cada cartão trazia permanentemente a caixa "Confirmo a remoção de X
 * desta turma" e um botão Remover. Numa turma de oito alunos, isso eram oito
 * pedidos de confirmação para uma operação que quase nunca se faz — e o ecrã
 * passava a ser sobre remover pessoas em vez de sobre quem está na turma.
 *
 * Agora o cartão mostra o aluno. A remoção vive no menu, e a confirmação —
 * que a Server Action continua a exigir — aparece quando a pessoa a pede.
 */
function MemberRow({ groupId, student }: { groupId: string; student: Person }) {
  const [state, formAction, pending] = useActionState(removeGroupMemberAction, FORM_ACTION_IDLE_STATE);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-field)] border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{student.fullName}</p>
          {student.email && <p className="truncate text-xs text-muted">{student.email}</p>}
        </div>
        <ActionMenu
          label={`Ações de ${student.fullName}`}
          items={[
            {
              label: "Ver aluno",
              href: `/professor/alunos/${student.id}`,
              icon: <UserRound className="size-4" aria-hidden="true" />,
            },
            {
              label: "Remover da turma",
              tone: "danger",
              onSelect: () => setConfirming(true),
              icon: <UserMinus className="size-4" aria-hidden="true" />,
            },
          ]}
        />
      </div>

      {confirming && (
        <form action={formAction} className="flex flex-col gap-3 border-t border-line pt-3">
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="studentId" value={student.id} />
          {/* O histórico é preservado — isto não apaga nada — mas o aluno deixa
              de contar para as aulas seguintes, e isso vale ser dito. */}
          <p className="text-sm text-ink-soft">
            {student.fullName} deixa de fazer parte desta turma. As aulas já realizadas
            mantêm-se no histórico.
          </p>
          <CheckboxField name="confirmed" required label="Confirmo a remoção." error={state.fieldErrors?.confirmed} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="danger"
              loading={pending}
              loadingLabel="A remover"
              icon={<UserMinus className="size-4" aria-hidden="true" />}
            >
              Remover da turma
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
          </div>
          {state.message && <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>}
        </form>
      )}
    </div>
  );
}

export function GroupMembersManager({
  groupId,
  currentMembers,
  eligibleStudents,
  search,
  canAdd,
}: {
  groupId: string;
  currentMembers: Person[];
  eligibleStudents: Person[];
  search: string;
  canAdd: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="current-members-title">
        <h3 id="current-members-title" className="mb-3 font-bold text-ink">Membros atuais ({currentMembers.length})</h3>
        {currentMembers.length === 0 ? (
          <p className="rounded-[var(--radius-field)] bg-sand-deep p-4 text-sm text-muted">A turma ainda não tem alunos.</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {currentMembers.map((member) => <MemberRow key={member.id} groupId={groupId} student={member} />)}
          </div>
        )}
      </section>

      <section aria-labelledby="eligible-members-title">
        <h3 id="eligible-members-title" className="font-bold text-ink">Adicionar alunos elegíveis</h3>
        {!canAdd && <Alert tone="warning" className="mt-3">A turma está inativa ou atingiu o limite. Reative-a ou aumente a capacidade antes de adicionar membros.</Alert>}
        {canAdd && (
          <form method="get" className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end" aria-label="Pesquisar alunos elegíveis">
            <div className="min-w-0 flex-1">
              <TextField name="aluno" label="Pesquisar aluno" type="search" maxLength={120} defaultValue={search} placeholder="Nome, email ou telefone" autoComplete="off" />
            </div>
            <Button type="submit" variant="outline" icon={<Search className="size-4" aria-hidden="true" />}>Pesquisar</Button>
          </form>
        )}
        {!canAdd ? null : search === "" ? (
          <p className="mt-3 text-sm text-muted">Escreva um nome, email ou telefone para pesquisar apenas no servidor.</p>
        ) : eligibleStudents.length === 0 ? (
          <p className="mt-3 rounded-[var(--radius-field)] bg-sand-deep p-4 text-sm text-muted">Não foram encontrados alunos próprios, ativos e fora desta turma.</p>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {eligibleStudents.map((student) => <AddMemberForm key={student.id} groupId={groupId} student={student} />)}
          </div>
        )}
      </section>
    </div>
  );
}
