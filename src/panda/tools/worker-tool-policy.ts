export const WORKER_CONTROL_TOOL_NAMES = new Set([
  "worker_spawn",
  "worker_stop",
  "environment_create",
  "environment_stop",
]);

export const DEFAULT_WORKER_ALLOWED_TOOL_NAMES = [
  "bash",
  "background_job_status",
  "background_job_wait",
  "background_job_cancel",
  "message_agent",
  "current_datetime",
  "view_media",
  "web_fetch",
  "brave_search",
  "browser",
  "agent_skill",
  "image_generate",
] as const;

export const POSTGRES_READONLY_TOOL_NAME = "postgres_readonly_query";

export const KNOWN_WORKER_TOOL_NAMES = new Set([
  ...DEFAULT_WORKER_ALLOWED_TOOL_NAMES,
  POSTGRES_READONLY_TOOL_NAME,
  "thinking_set",
  "spawn_subagent",
  "agent_prompt",
  "app_create",
  "app_list",
  "app_link_create",
  "app_check",
  "app_view",
  "app_action",
  "scheduled_task_create",
  "scheduled_task_update",
  "scheduled_task_cancel",
  "watch_schema_get",
  "watch_create",
  "watch_update",
  "watch_disable",
  "email_send",
  "outbound",
  "telegram_react",
  "wiki",
  "set_env_value",
  "clear_env_value",
  "telepathy_screenshot",
  "web_research",
  "whisper",
  "read_file",
  "glob_files",
  "grep_files",
]);

export function normalizeToolName(value: string): string {
  return value.trim();
}

export function buildDefaultWorkerAllowedTools(options: {
  allowReadonlyPostgres?: boolean;
  extraTools?: readonly string[];
} = {}): string[] {
  return [
    ...new Set([
      ...DEFAULT_WORKER_ALLOWED_TOOL_NAMES,
      ...(options.allowReadonlyPostgres ? [POSTGRES_READONLY_TOOL_NAME] : []),
      ...(options.extraTools ?? []).map(normalizeToolName).filter(Boolean),
    ]),
  ];
}
