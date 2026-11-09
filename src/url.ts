import { ToolError } from "./types";

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError("INVALID_URL", "Provide an absolute http(s) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ToolError("INVALID_URL", "Only http(s) URLs are supported.");
  if (url.username || url.password) throw new ToolError("INVALID_URL", "URLs with credentials are not allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    /\.(localhost|local|internal|lan|home\.arpa)$/.test(host) ||
    PRIVATE_V4.some((re) => re.test(host)) ||
    /^(::1?|f[cd][0-9a-f]{2}:|fe80:)/.test(host) ||
    host === "metadata.google.internal"
  )
    throw new ToolError("INVALID_URL", "Private, loopback and link-local hosts are not allowed.");
  return url;
}
