import {GatewayHttpError} from "./http-body.js";

const TEXT_DECODER = new TextDecoder("utf-8", {fatal: true});

export function normalizeGatewayMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function looksLikeUtf8Text(bytes: Buffer): boolean {
  try {
    const text = TEXT_DECODER.decode(bytes);
    return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
  } catch {
    return false;
  }
}

export function sniffGatewayAttachmentMimeType(bytes: Buffer): string | undefined {
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
  if (looksLikeUtf8Text(bytes)) {
    const trimmed = bytes.toString("utf8").trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return "application/json";
    }
    return "text/plain";
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

export function assertGatewayAttachmentMimeAccepted(input: {
  allowedMimeTypes: readonly string[];
  bytes: Buffer;
  declaredMimeType: string;
}): {mimeType: string; sniffedMimeType?: string} {
  const mimeType = normalizeGatewayMimeType(input.declaredMimeType);
  if (!mimeType) {
    throw new GatewayHttpError(415, "Attachment Content-Type is required.");
  }
  if (mimeType === "application/octet-stream") {
    throw new GatewayHttpError(415, "Attachment Content-Type must be specific, not application/octet-stream.");
  }
  const allowed = new Set(input.allowedMimeTypes.map((value) => normalizeGatewayMimeType(value)).filter(Boolean));
  if (!allowed.has(mimeType)) {
    throw new GatewayHttpError(415, "Unsupported attachment Content-Type.");
  }
  const sniffedMimeType = sniffGatewayAttachmentMimeType(input.bytes);
  if (sniffedMimeType && !declaredMimeCompatibleWithSniffed(mimeType, sniffedMimeType)) {
    throw new GatewayHttpError(415, "Attachment Content-Type does not match the file signature.");
  }
  return {
    mimeType,
    ...(sniffedMimeType ? {sniffedMimeType} : {}),
  };
}
