import type {ServerResponse} from "node:http";

export function setAgentAppSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "permissions-policy",
    [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "serial=()",
      "bluetooth=()",
      "clipboard-read=()",
    ].join(", "),
  );
  response.setHeader(
    "content-security-policy",
    [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "worker-src 'none'",
      "child-src 'none'",
      "frame-src 'none'",
      "manifest-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
  );
}
