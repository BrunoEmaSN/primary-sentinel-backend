/**
 * Mitigación SSRF para destinos `webhook` y `http_api`.
 * No sustituye allowlist por tenant ni mitigación DNS→IP privada (riesgo residual).
 */

const BLOCKED_HOSTNAMES = new Set(
  [
    "metadata.google.internal",
    "metadata.goog",
    "metadata",
    "kubernetes.default",
    "kubernetes.default.svc",
    "kube-dns.kube-system.svc",
  ].map((h) => h.toLowerCase())
);

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function isIpv4String(hostname: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  const parts = hostname.split(".").map((x) => Number.parseInt(x, 10));
  return parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255);
}

/** true si la IPv4 (cuatro octetos 0–255) es no enrutable / privada / enlace local. */
export function isNonPublicIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 127 || a >= 224) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedIpv4Host(hostname: string): boolean {
  if (!isIpv4String(hostname)) return false;
  const oct = hostname.split(".").map((x) => Number.parseInt(x, 10)) as [
    number,
    number,
    number,
    number,
  ];
  return isNonPublicIpv4(oct);
}

function isBlockedIpv6Host(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (h === "::1") return true;
  const lower = h.toLowerCase();
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("ff")) return true;
  return false;
}

export type SafeOutboundUrlOptions = {
  /** Si false, solo se permite `https:` (salvo bloqueos de host/IP). */
  allowHttpOnLoopback: boolean;
};

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundUrlError";
  }
}

/**
 * Valida URL antes de `fetch` desde el Worker.
 * @throws UnsafeOutboundUrlError
 */
export function assertSafeOutboundHttpUrl(
  urlString: string,
  options: SafeOutboundUrlOptions
): void {
  let u: URL;
  try {
    u = new URL(urlString.trim());
  } catch {
    throw new UnsafeOutboundUrlError("Invalid URL");
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new UnsafeOutboundUrlError("Only http(s) URLs are allowed");
  }

  if (u.protocol === "http:") {
    if (!options.allowHttpOnLoopback || !isLoopbackHost(u.hostname)) {
      throw new UnsafeOutboundUrlError("http is only allowed for loopback hosts in non-production");
    }
  }

  const host = normalizeHostname(u.hostname);
  if (!host) throw new UnsafeOutboundUrlError("Missing host");

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new UnsafeOutboundUrlError("Host is not allowed for outbound requests");
  }

  if (host.endsWith(".localhost")) {
    throw new UnsafeOutboundUrlError(".localhost hosts are not allowed");
  }

  if (isLoopbackHost(u.hostname)) {
    return;
  }

  if (isBlockedIpv4Host(host) || isBlockedIpv6Host(host)) {
    throw new UnsafeOutboundUrlError("Non-public IP or reserved range is not allowed");
  }
}
