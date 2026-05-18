import type {IncomingMessage} from "node:http";

type HttpBodyErrorFactory = (statusCode: number, message: string) => Error;

interface ReadLimitedHttpBodyOptions {
  createError: HttpBodyErrorFactory;
  maxBytes: number;
  tooLargeMessage: string;
}

interface ParseJsonHttpBodyOptions {
  createError: HttpBodyErrorFactory;
  invalidJsonPrefix: string;
}

interface ReadJsonHttpBodyOptions extends ReadLimitedHttpBodyOptions, ParseJsonHttpBodyOptions {}

function readContentLength(request: IncomingMessage): string | undefined {
  const declaredLength = request.headers["content-length"];
  return Array.isArray(declaredLength) ? declaredLength[0] : declaredLength;
}

/**
 * Reads a Node HTTP request body while enforcing the same byte budget against
 * declared and streamed lengths. Public adapters provide their own error type.
 */
export async function readLimitedHttpBody(
  request: IncomingMessage,
  options: ReadLimitedHttpBodyOptions,
): Promise<Buffer> {
  const contentLength = readContentLength(request);
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > options.maxBytes) {
      throw options.createError(413, options.tooLargeMessage);
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > options.maxBytes) {
      throw options.createError(413, options.tooLargeMessage);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

export function parseJsonHttpBody(rawBody: Buffer, options: ParseJsonHttpBodyOptions): unknown {
  const raw = rawBody.toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw options.createError(400, `${options.invalidJsonPrefix}: ${message}`);
  }
}

export async function readJsonHttpBody(
  request: IncomingMessage,
  options: ReadJsonHttpBodyOptions,
): Promise<unknown> {
  return parseJsonHttpBody(await readLimitedHttpBody(request, options), options);
}
