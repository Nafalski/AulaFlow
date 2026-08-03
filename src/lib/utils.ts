import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Junta classes Tailwind resolvendo conflitos.
 *
 * `cn("px-4", condicao && "px-6")` devolve `px-6` — sem isto, ambas as classes
 * ficariam no HTML e o resultado dependeria da ordem no ficheiro CSS.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Primeira letra de cada palavra, para avatares sem imagem. */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** "Ana", a partir de "Ana Sofia Marques" — para saudações. */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}
