/** Idioma de respuestas HTTP expuestas al dashboard y webhooks. */

export type ApiLocale = "es" | "en";

/**
 * Prioridad: cabecera explícita del front (`X-Sentinel-Locale`), luego `Accept-Language`, por defecto `es`.
 */
export function resolveApiLocale(request: Request): ApiLocale {
  const header = request.headers.get("x-sentinel-locale")?.trim().toLowerCase();
  if (header === "en") return "en";
  if (header === "es") return "es";

  const accept = request.headers.get("Accept-Language");
  if (accept) {
    for (const part of accept.split(",")) {
      const code = part.split(";")[0]?.trim().toLowerCase() ?? "";
      if (code.startsWith("en")) return "en";
      if (code.startsWith("es")) return "es";
    }
  }

  return "es";
}
