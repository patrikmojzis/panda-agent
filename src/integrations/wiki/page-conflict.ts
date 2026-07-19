import {commandStaleVersionConflict} from "../../domain/commands/errors.js";
import type {WikiJsClient, WikiPage} from "./client.js";
import {DEFAULT_WIKI_LOCALE} from "./constants.js";
import {isWikiPathWithinNamespace} from "./paths.js";

const SAFE_CLI_ARGUMENT = /^[a-zA-Z0-9_./:@+-]+$/;

function quoteCliArgument(value: string): string {
  if (SAFE_CLI_ARGUMENT.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Rejects a stale Wiki write with only the scoped metadata needed to refresh. */
export async function assertWikiPageVersionCurrent(input: {
  client: Pick<WikiJsClient, "checkPageConflicts" | "getConflictLatest">;
  page: WikiPage;
  baseUpdatedAt?: string;
  namespacePath: string;
  requestedPath: string;
}): Promise<void> {
  if (!input.baseUpdatedAt) return;
  if (!await input.client.checkPageConflicts(input.page.id, input.baseUpdatedAt)) return;

  const latest = await input.client.getConflictLatest(input.page.id);
  const path = isWikiPathWithinNamespace(latest.path, input.namespacePath)
    ? latest.path
    : input.requestedPath;
  const localeFlag = latest.locale === DEFAULT_WIKI_LOCALE
    ? ""
    : ` --locale ${quoteCliArgument(latest.locale)}`;
  throw commandStaleVersionConflict({
    message: "The Wiki page changed after the supplied baseUpdatedAt.",
    resource: {
      kind: "wiki_page",
      path,
      locale: latest.locale,
      latestUpdatedAt: latest.updatedAt,
    },
    nextAction: {
      kind: "refresh_merge_write",
      command: `panda wiki read ${quoteCliArgument(path)}${localeFlag}`,
    },
  });
}
