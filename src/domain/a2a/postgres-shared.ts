export interface A2ATableNames {
  prefix: string;
  a2aSessionBindings: string;
}

export function buildA2ATableNames(): A2ATableNames {
  return {
    prefix: "a2a",
    a2aSessionBindings: `"runtime"."a2a_session_bindings"`,
  };
}
