/** Entero de query acotado; valores no finales o fuera de rango se clamp-ean. */
export function parseBoundedInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export const MAX_LIST_LIMIT = 100;
export const MAX_LIST_OFFSET = 50_000;
export const MAX_AI_HISTORY_LIMIT = 200;
export const MAX_METRICS_HOURS = 168;
