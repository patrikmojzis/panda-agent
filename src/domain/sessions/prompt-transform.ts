interface Token {
  type: "identifier" | "number" | "string" | "symbol";
  value: string;
}

const WHITELISTED_FUNCTIONS = new Set([
  "regexp_replace",
  "replace",
  "overlay",
  "trim",
  "ltrim",
  "rtrim",
  "upper",
  "lower",
  "left",
  "right",
  "substring",
  "concat",
  "coalesce",
  "length",
]);

const WHITELISTED_IDENTIFIERS = new Set([
  "content",
  "placing",
  "from",
  "for",
  "null",
]);

function tokenizeSessionPromptTransformExpression(expression: string): Token[] {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Transform expression must not be empty.");
  }
  if (
    trimmed.includes(";")
    || trimmed.includes("--")
    || trimmed.includes("/*")
    || trimmed.includes("*/")
    || trimmed.includes("\"")
  ) {
    throw new Error("Transform expression uses unsupported SQL syntax.");
  }

  const tokens: Token[] = [];
  let index = 0;

  while (index < trimmed.length) {
    const char = trimmed[index];
    if (!char) {
      break;
    }

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "'") {
      let cursor = index + 1;
      let value = "'";
      let closed = false;
      while (cursor < trimmed.length) {
        const next = trimmed[cursor];
        if (!next) {
          break;
        }

        value += next;
        cursor += 1;
        if (next === "'") {
          if (trimmed[cursor] === "'") {
            value += "'";
            cursor += 1;
            continue;
          }

          closed = true;
          break;
        }
      }

      if (!closed) {
        throw new Error("Transform expression has an unterminated string literal.");
      }

      tokens.push({type: "string", value});
      index = cursor;
      continue;
    }

    if (/\d/.test(char)) {
      let cursor = index + 1;
      while (cursor < trimmed.length && /\d/.test(trimmed[cursor] ?? "")) {
        cursor += 1;
      }
      tokens.push({
        type: "number",
        value: trimmed.slice(index, cursor),
      });
      index = cursor;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let cursor = index + 1;
      while (cursor < trimmed.length && /[A-Za-z0-9_]/.test(trimmed[cursor] ?? "")) {
        cursor += 1;
      }
      tokens.push({
        type: "identifier",
        value: trimmed.slice(index, cursor),
      });
      index = cursor;
      continue;
    }

    if (char === "|" && trimmed[index + 1] === "|") {
      tokens.push({type: "symbol", value: "||"});
      index += 2;
      continue;
    }

    if ("(),+-*/".includes(char)) {
      tokens.push({type: "symbol", value: char});
      index += 1;
      continue;
    }

    throw new Error(`Unsupported transform expression token: ${char}`);
  }

  return tokens;
}

export function validateSessionPromptTransformExpression(expression: string): string {
  const tokens = tokenizeSessionPromptTransformExpression(expression);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type !== "identifier") {
      continue;
    }

    const normalized = token.value.toLowerCase();
    const next = tokens[index + 1];
    const isFunctionCall = next?.type === "symbol" && next.value === "(";

    if (isFunctionCall) {
      if (!WHITELISTED_FUNCTIONS.has(normalized)) {
        throw new Error(`Transform expression uses unsupported function ${token.value}.`);
      }
      continue;
    }

    if (!WHITELISTED_IDENTIFIERS.has(normalized)) {
      throw new Error(`Transform expression uses unsupported identifier ${token.value}.`);
    }
  }

  return expression.trim();
}
