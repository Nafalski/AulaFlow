/** Utilitários de normalização partilhados pelos formulários da Fase 3. */

export function normalizeSingleLine(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeOptionalSingleLine(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const normalized = normalizeSingleLine(value);
  return normalized === "" ? null : normalized;
}

export function normalizeOptionalMultiline(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;

  const normalized = value.trim().replace(/\r\n?/g, "\n");
  return normalized === "" ? null : normalized;
}

export function normalizeOptionalUuid(value: unknown): unknown {
  const normalized = normalizeOptionalSingleLine(value);
  return typeof normalized === "string" ? normalized.toLowerCase() : normalized;
}

export function normalizeRequiredUuid(value: unknown): unknown {
  const normalized = normalizeSingleLine(value);
  return typeof normalized === "string" ? normalized.toLowerCase() : normalized;
}

export function normalizeOptionalInteger(value: unknown): unknown {
  const normalized = normalizeOptionalSingleLine(value);
  if (normalized === null) return null;
  if (typeof normalized !== "string") return normalized;
  return /^-?\d+$/.test(normalized) ? Number(normalized) : normalized;
}

export function normalizeRequiredInteger(value: unknown): unknown {
  const normalized = normalizeSingleLine(value);
  if (typeof normalized !== "string") return normalized;
  return /^-?\d+$/.test(normalized) ? Number(normalized) : normalized;
}

export function normalizeRequiredBoolean(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return value;
}

export function formString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

export function formChecked(formData: FormData, key: string): boolean {
  return formData.getAll(key).some((value) => {
    if (typeof value !== "string") return false;
    return ["on", "true", "1"].includes(value.trim().toLowerCase());
  });
}

/**
 * Um FormData pode ser forjado fora do browser. As Actions usam esta função
 * antes do schema para rejeitar, em vez de apenas ignorar, nomes de campo que
 * não pertencem ao contrato do formulário.
 */
export function unexpectedFormFields(
  formData: FormData,
  allowedFields: readonly string[],
): string[] {
  const allowed = new Set(allowedFields);
  const unexpected = new Set<string>();

  for (const key of formData.keys()) {
    if (!key.startsWith("$ACTION_") && !allowed.has(key)) unexpected.add(key);
  }

  for (const key of allowed) {
    if (formData.getAll(key).length > 1) unexpected.add(key);
  }

  return [...unexpected];
}
