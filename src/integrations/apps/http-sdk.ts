export function buildAgentAppSdkScript(input: {
  csrfHeaderName: string;
}): string {
  return `(() => {
  const trim = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const cookieSuffix = (agentKey, appSlug) => \`\${agentKey.length}_\${agentKey}_\${appSlug.length}_\${appSlug}\`.replace(/[^A-Za-z0-9_-]/g, "_");
  const readCookie = (name) => {
    const prefix = \`\${name}=\`;
    const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return match ? decodeURIComponent(match.slice(prefix.length)) : undefined;
  };
  const url = new URL(window.location.href);
  const parts = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const route = parts[0] === "apps" && parts[1] && parts[2]
    ? {agentKey: parts[1], appSlug: parts[2]}
    : parts[1] === "apps" && parts[0] && parts[2]
      ? {agentKey: parts[0], appSlug: parts[2]}
      : null;
  if (!route) {
    return;
  }

  const apiBase = \`/api/apps/\${encodeURIComponent(route.agentKey)}/\${encodeURIComponent(route.appSlug)}\`;
  const csrfCookieName = \`panda_app_csrf_\${cookieSuffix(route.agentKey, route.appSlug)}\`;
  let context = {
    identityId: trim(url.searchParams.get("identityId")),
    identityHandle: trim(url.searchParams.get("identityHandle")),
    sessionId: trim(url.searchParams.get("sessionId")),
  };

  const withContext = (payload = {}) => ({
    ...payload,
    ...(context.identityId ? {identityId: context.identityId} : {}),
    ...(context.identityHandle ? {identityHandle: context.identityHandle} : {}),
    ...(context.sessionId ? {sessionId: context.sessionId} : {}),
  });

  const requestJson = async (requestPath, options = {}) => {
    const method = options.method ?? "GET";
    const csrfToken = readCookie(csrfCookieName);
    const response = await fetch(requestPath, {
      credentials: "same-origin",
      ...options,
      method,
      headers: {
        ...(method === "GET" ? {} : {"content-type": "application/json"}),
        ...(csrfToken ? {"${input.csrfHeaderName}": csrfToken} : {}),
        ...(options.headers ?? {}),
      },
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!response.ok) {
      throw new Error((data && data.error) || \`Request failed (\${response.status})\`);
    }

    return data;
  };

  window.panda = {
    agentKey: route.agentKey,
    appSlug: route.appSlug,
    getContext() {
      return {...context};
    },
    setContext(next) {
      context = {
        ...context,
        ...(next && typeof next === "object" ? next : {}),
      };
      return {...context};
    },
    bootstrap() {
      const search = new URLSearchParams(withContext());
      return requestJson(\`\${apiBase}/bootstrap?\${search.toString()}\`);
    },
    view(viewName, options = {}) {
      return requestJson(\`\${apiBase}/views/\${encodeURIComponent(viewName)}\`, {
        method: "POST",
        body: JSON.stringify(withContext({
          params: options.params ?? {},
          pageSize: options.pageSize,
          offset: options.offset,
        })),
      });
    },
    action(actionName, input = {}) {
      return requestJson(\`\${apiBase}/actions/\${encodeURIComponent(actionName)}\`, {
        method: "POST",
        body: JSON.stringify(withContext({input})),
      });
    },
  };
})();`;
}
