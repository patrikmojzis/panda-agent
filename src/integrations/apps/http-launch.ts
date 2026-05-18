import type {ServerResponse} from "node:http";

import type {AgentAppDefinition} from "../../domain/apps/types.js";
import {
  type AgentAppAuthService,
  buildAgentAppCookieNames,
} from "../../domain/apps/auth.js";
import {trimToUndefined} from "../../lib/strings.js";
import {AgentAppRequestError} from "./http-errors.js";
import {
  buildAgentAppCookiePath,
  buildAgentAppOpenPath,
  buildAgentAppPath,
} from "./http-config.js";
import {serializeCookie} from "./http-auth.js";
import {escapeAgentAppHtml} from "./html.js";

interface AgentAppLaunchLookup {
  getApp(agentKey: string, appSlug: string): Promise<AgentAppDefinition>;
}

function renderLaunchInterstitial(token: string): string {
  const action = escapeAgentAppHtml(buildAgentAppOpenPath(token));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Panda App</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px ui-sans-serif, system-ui; background: #f6f1e8; color: #17140f; }
    main { width: min(420px, calc(100vw - 32px)); padding: 28px; border: 1px solid #d8cbb8; border-radius: 20px; background: #fffaf2; box-shadow: 0 24px 80px rgb(31 23 13 / 12%); }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.05; }
    p { margin: 0 0 22px; color: #675c4d; line-height: 1.45; }
    button { width: 100%; border: 0; border-radius: 999px; padding: 13px 18px; background: #1c5d46; color: white; font: inherit; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Open Panda app</h1>
    <p>This one-time link will sign this browser into the app.</p>
    <form method="post" action="${action}">
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`;
}

function isInvalidLaunchTokenError(error: unknown): boolean {
  return error instanceof Error && error.message === "App launch link is invalid, expired, or already used.";
}

/**
 * Handles the one-time public app launch flow: preview interstitial, token
 * redemption, app UI validation, and scoped app cookies.
 */
export async function writeAgentAppLaunchResponse(input: {
  auth?: AgentAppAuthService;
  cookieSecure: boolean;
  method?: string;
  requestUrl: URL;
  response: ServerResponse;
  service: AgentAppLaunchLookup;
  sessionTtlMs: number;
}): Promise<void> {
  if (!input.auth) {
    throw new AgentAppRequestError(404, "App launch links are not configured.");
  }

  const token = trimToUndefined(input.requestUrl.searchParams.get("token"));
  if (!token) {
    throw new AgentAppRequestError(400, "Missing app launch token.");
  }

  if (input.method === "GET") {
    input.response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    input.response.end(renderLaunchInterstitial(token));
    return;
  }

  if (input.method !== "POST") {
    throw new AgentAppRequestError(405, "Use GET or POST for app launch links.");
  }

  const redeemed = await input.auth.redeemLaunchToken(token, {sessionTtlMs: input.sessionTtlMs})
    .catch((error: unknown) => {
      if (isInvalidLaunchTokenError(error)) {
        throw new AgentAppRequestError(401, "App launch link is invalid, expired, or already used.");
      }
      throw error;
    });
  const app = await input.service.getApp(redeemed.session.agentKey, redeemed.session.appSlug);
  if (!app.hasUi) {
    throw new AgentAppRequestError(404, `App ${app.slug} does not expose a UI.`);
  }

  const cookieNames = buildAgentAppCookieNames(app.agentKey, app.slug);
  input.response.writeHead(302, {
    "cache-control": "no-store",
    "location": buildAgentAppPath(app.agentKey, app.slug),
    "set-cookie": [
      serializeCookie({
        name: cookieNames.session,
        path: "/",
        value: redeemed.sessionToken,
        expiresAt: redeemed.session.expiresAt,
        httpOnly: true,
        secure: input.cookieSecure,
      }),
      serializeCookie({
        name: cookieNames.csrf,
        path: buildAgentAppCookiePath(app.agentKey, app.slug),
        value: redeemed.csrfToken,
        expiresAt: redeemed.session.expiresAt,
        httpOnly: false,
        secure: input.cookieSecure,
      }),
    ],
  });
  input.response.end();
}
