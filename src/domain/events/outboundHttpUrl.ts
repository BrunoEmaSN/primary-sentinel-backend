/**
 * URLs http(s) cuya ruta es solo "/" suelen responder con 404 o "Cannot POST /"
 * (Next.js, SPAs, sitios estáticos).
 */
export function isHttpUrlRootPathOnly(urlString: string): boolean {
  try {
    const u = new URL(urlString.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const p = u.pathname.replace(/\/+$/, "") || "/";
    return p === "/";
  } catch {
    return false;
  }
}

function defaultPortForProtocol(protocol: string): string {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  return "";
}

/** Puerto efectivo (URL API puede devolver "" para el default del esquema). */
function effectivePort(u: URL): string {
  return u.port || defaultPortForProtocol(u.protocol);
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * Mismo servicio Worker que `WORKER_URL`: igualdad estricta de origin, o loopback
 * mismo protocolo + puerto con localhost/127.0.0.1/::1 intercambiables.
 */
export function sameOriginAsWorkerForSink(destinationUrl: string, workerBaseUrl: string): boolean {
  try {
    const d = new URL(destinationUrl.trim());
    const w = new URL(workerBaseUrl.trim());
    if (d.protocol !== w.protocol) return false;
    if (d.origin === w.origin) return true;
    if (!isLoopbackHost(d.hostname) || !isLoopbackHost(w.hostname)) return false;
    return effectivePort(d) === effectivePort(w);
  } catch {
    return false;
  }
}

/** Ruta pública del Worker que acepta POST JSON (mismo despliegue que WORKER_URL). */
export const WEBHOOK_TEST_SINK_PATH = "/api/public/webhook-test-sink" as const;

export type ExpandRootUrlOptions = {
  /**
   * Solo desarrollo (.dev.vars): si el destino es solo `/` en cualquier puerto loopback
   * (p. ej. Next en :3000), reenvía al sink del Worker en `WORKER_URL` para evitar "Cannot POST /".
   */
  loopbackRootUsesWorkerSink?: boolean;
};

/**
 * Si el destino es la raíz del mismo servicio que `WORKER_URL`, reescribe al sink de prueba.
 * Opcionalmente, con `loopbackRootUsesWorkerSink`, cualquier raíz en loopback va al sink del Worker.
 */
export function expandRootUrlToWorkerTestSink(
  destinationUrl: string,
  workerBaseUrl: string | undefined,
  options?: ExpandRootUrlOptions
): string {
  const trimmed = destinationUrl.trim();
  if (!workerBaseUrl?.trim() || !isHttpUrlRootPathOnly(trimmed)) {
    return trimmed;
  }
  try {
    const d = new URL(trimmed);
    const w = new URL(workerBaseUrl.trim());

    if (options?.loopbackRootUsesWorkerSink && isLoopbackHost(d.hostname)) {
      const out = new URL(w);
      out.pathname = WEBHOOK_TEST_SINK_PATH;
      out.search = d.search;
      return out.href;
    }

    if (sameOriginAsWorkerForSink(trimmed, workerBaseUrl)) {
      const out = new URL(w);
      out.pathname = WEBHOOK_TEST_SINK_PATH;
      out.search = d.search;
      return out.href;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}
