import {marked, type Token} from "marked";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function tokenChildren(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens)
    ? token.tokens as Token[]
    : [];
}

function renderInlineTokens(tokens: readonly Token[]): string {
  let html = "";

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const children = tokenChildren(token);
        html += children.length > 0
          ? renderInlineTokens(children)
          : escapeHtml(token.text);
        break;
      }

      case "strong":
        html += `<b>${renderInlineTokens(tokenChildren(token))}</b>`;
        break;

      case "em":
        html += `<i>${renderInlineTokens(tokenChildren(token))}</i>`;
        break;

      case "codespan":
        html += `<code>${escapeHtml(token.text)}</code>`;
        break;

      case "del":
        html += `<s>${renderInlineTokens(tokenChildren(token))}</s>`;
        break;

      case "link": {
        const href = token.href.trim();
        const label = renderInlineTokens(tokenChildren(token)) || escapeHtml(href);
        html += href
          ? `<a href="${escapeHtmlAttr(href)}">${label}</a>`
          : label;
        break;
      }

      case "image": {
        const label = token.text?.trim();
        if (label && token.href) {
          html += `<a href="${escapeHtmlAttr(token.href)}">${escapeHtml(label)}</a>`;
        } else if (token.href) {
          html += `<a href="${escapeHtmlAttr(token.href)}">${escapeHtml(token.href)}</a>`;
        } else if (label) {
          html += escapeHtml(label);
        }
        break;
      }

      case "br":
        html += "\n";
        break;

      case "escape":
        html += escapeHtml(token.text);
        break;

      default: {
        const children = tokenChildren(token);
        if (children.length > 0) {
          html += renderInlineTokens(children);
          break;
        }

        if ("text" in token && typeof token.text === "string" && token.text) {
          html += escapeHtml(token.text);
          break;
        }

        if ("raw" in token && typeof token.raw === "string" && token.raw) {
          html += escapeHtml(token.raw);
        }
      }
    }
  }

  return html;
}

function prefixMultilineBlock(block: string, prefix: string): string {
  const continuation = " ".repeat(prefix.length);
  return block.split("\n").map((line, index) => {
    if (index === 0) {
      return `${prefix}${line}`;
    }

    return line.length === 0 ? "" : `${continuation}${line}`;
  }).join("\n");
}

function renderListItem(item: {
  text?: string;
  tokens?: Token[];
}): string {
  const tokens = Array.isArray(item.tokens) ? item.tokens : [];
  const rendered = renderBlockTokens(tokens).trim();
  if (rendered) {
    return rendered;
  }

  return escapeHtml(item.text?.trim() ?? "");
}

function renderBlockTokens(tokens: readonly Token[]): string {
  const blocks: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;

      case "paragraph": {
        const paragraph = renderInlineTokens(tokenChildren(token)).trim();
        if (paragraph) {
          blocks.push(paragraph);
        }
        break;
      }

      case "text": {
        const children = tokenChildren(token);
        const text = (children.length > 0
          ? renderInlineTokens(children)
          : escapeHtml(token.text)).trim();
        if (text) {
          blocks.push(text);
        }
        break;
      }

      case "heading": {
        const heading = renderInlineTokens(tokenChildren(token)).trim();
        if (heading) {
          blocks.push(`<b>${heading}</b>`);
        }
        break;
      }

      case "blockquote": {
        const quoted = renderBlockTokens(tokenChildren(token)).trim();
        if (quoted) {
          blocks.push(`<blockquote>${quoted}</blockquote>`);
        }
        break;
      }

      case "list": {
        const start = token.start ?? 1;
        const items = token.items.map((item: {text?: string; tokens?: Token[]}, index: number) => {
          const rendered = renderListItem(item);
          if (!rendered) {
            return "";
          }

          const marker = token.ordered ? `${start + index}. ` : "• ";
          return prefixMultilineBlock(rendered, marker);
        }).filter((item: string) => item.length > 0);

        if (items.length > 0) {
          blocks.push(items.join("\n"));
        }
        break;
      }

      case "code":
        blocks.push(`<pre><code>${escapeHtml(token.text)}</code></pre>`);
        break;

      case "hr":
        blocks.push("──────────");
        break;

      case "table":
        blocks.push(`<pre><code>${escapeHtml(token.raw.trimEnd())}</code></pre>`);
        break;

      default: {
        const children = tokenChildren(token);
        if (children.length > 0) {
          const rendered = renderBlockTokens(children).trim();
          if (rendered) {
            blocks.push(rendered);
          }
          break;
        }

        if ("text" in token && typeof token.text === "string" && token.text.trim()) {
          blocks.push(escapeHtml(token.text.trim()));
          break;
        }

        if ("raw" in token && typeof token.raw === "string" && token.raw.trim()) {
          blocks.push(escapeHtml(token.raw.trim()));
        }
      }
    }
  }

  return blocks.join("\n\n");
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown.trim()) {
    return "";
  }

  const tokens = marked.lexer(markdown) as Token[];
  return renderBlockTokens(tokens).trim();
}
