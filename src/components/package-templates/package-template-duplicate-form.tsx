"use client";

import Link from "next/link";
import { Copy } from "lucide-react";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { duplicatePackageTemplateAction } from "@/lib/actions/package-templates";

export function PackageTemplateDuplicateForm({ packageTemplateId }: { packageTemplateId: string }) {
  const [state, formAction, pending] = useActionState(
    duplicatePackageTemplateAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="packageTemplateId" value={packageTemplateId} />
      <p className="text-sm text-muted">
        Cria um novo modelo com os mesmos dados, sem copiar datas de auditoria nem alterar este modelo.
      </p>
      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>
          <p>{state.message}</p>
          {state.resourceId && (
            <Link
              href={`/professor/pacotes/${state.resourceId}`}
              className={buttonClasses({ variant: "outline", size: "sm", className: "mt-3" })}
            >
              Abrir cópia
            </Link>
          )}
        </Alert>
      )}
      <Button
        type="submit"
        variant="outline"
        loading={pending}
        loadingLabel="A duplicar"
        icon={<Copy className="size-4" aria-hidden="true" />}
      >
        Duplicar modelo
      </Button>
    </form>
  );
}
