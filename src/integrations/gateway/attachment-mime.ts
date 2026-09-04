import {GatewayHttpError} from "./http-body.js";

export function normalizeGatewayMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function sniffBinaryMimeType(bytes: Buffer): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  const firstSix = bytes.subarray(0, 6).toString("ascii");
  if (firstSix === "GIF87a" || firstSix === "GIF89a") {
    return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") {
    return "audio/ogg";
  }
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    return "audio/mp4";
  }
  return undefined;
}

function declaredMimeCompatibleWithSniffed(declared: string, sniffed: string): boolean {
  if (declared === sniffed) {
    return true;
  }
  return (declared === "audio/m4a" && sniffed === "audio/mp4")
    || (declared === "audio/opus" && sniffed === "audio/ogg");
}

export function requireGatewayAttachmentMimeType(declared: string, allowedMimeTypes: readonly string[]): string {
  const mimeType = normalizeGatewayMimeType(declared);
  if (!mimeType) {
    throw new GatewayHttpError(415, "Attachment Content-Type is required.");
  }
  if (mimeType === "application/octet-stream") {
    throw new GatewayHttpError(415, "Attachment Content-Type must be specific, not application/octet-stream.");
  }
  const allowed = new Set(allowedMimeTypes.map((value) => normalizeGatewayMimeType(value)).filter(Boolean));
  if (!allowed.has(mimeType)) {
    throw new GatewayHttpError(415, "Unsupported attachment Content-Type.");
  }
  return mimeType;
}

function assertCompatibleMime(mimeType: string, sniffedMimeType?: string): {mimeType: string; sniffedMimeType?: string} {
  if (sniffedMimeType && !declaredMimeCompatibleWithSniffed(mimeType, sniffedMimeType)) {
    throw new GatewayHttpError(415, "Attachment Content-Type does not match the file signature.");
  }
  return {
    mimeType,
    ...(sniffedMimeType ? {sniffedMimeType} : {}),
  };
}

/** Validates the entire text stream while retaining only the signature prefix. */
export function createGatewayAttachmentMimeValidator(mimeType: string) {
  const decoder = new TextDecoder("utf-8", {fatal: true});
  let prefix = Buffer.alloc(0);
  let textValid = true;
  let firstTextCharacter: string | undefined;
  const inspectText = (text: string) => {
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) textValid = false;
    firstTextCharacter ??= text.trimStart()[0];
  };
  return {
    update(bytes: Buffer): void {
      if (prefix.length < 12) prefix = Buffer.concat([prefix, bytes.subarray(0, 12 - prefix.length)]);
      if (textValid) {
        try { inspectText(decoder.decode(bytes, {stream: true})); } catch { textValid = false; }
      }
    },
    finish(): {mimeType: string; sniffedMimeType?: string} {
      if (textValid) {
        try { inspectText(decoder.decode()); } catch { textValid = false; }
      }
      const sniffed = sniffBinaryMimeType(prefix) ?? (textValid
        ? firstTextCharacter === "{" || firstTextCharacter === "[" ? "application/json" : "text/plain"
        : undefined);
      return assertCompatibleMime(mimeType, sniffed);
    },
  };
}
