#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/docker-stack.sh up [--build]
  ./scripts/docker-stack.sh down
  ./scripts/docker-stack.sh ps
  ./scripts/docker-stack.sh logs [core|browser|telegram|wiki|<agentKey>|<service>]
  ./scripts/docker-stack.sh restart

Primary flow:
  1. Set PANDA_AGENTS=claw,luna in .env
  2. Set WIKI_ADMIN_EMAIL and WIKI_ADMIN_PASSWORD in .env
  3. Run ./scripts/docker-stack.sh up --build

Notes:
  - One bash runner container is created per agent in PANDA_AGENTS.
  - The browser runner is shared.
  - Telegram polling is auto-enabled when TELEGRAM_BOT_TOKEN is set in .env.
  - Wiki.js is part of the stack.
  - Wiki bootstrap follows PANDA_AGENTS.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

expand_home() {
  local value
  value="$(trim "$1")"
  case "$value" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s%s\n' "$HOME" "${value:1}"
      ;;
    *)
      printf '%s\n' "$value"
      ;;
  esac
}

normalize_agent_key() {
  local normalized
  normalized="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  normalized="$(trim "$normalized")"

  if [[ -z "$normalized" ]]; then
    die "Agent key must not be empty."
  fi

  if [[ ! "$normalized" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    die "Agent key must use lowercase letters, numbers, hyphens, or underscores."
  fi

  printf '%s\n' "$normalized"
}

array_contains() {
  local needle=$1
  shift || true
  local candidate
  for candidate in "$@"; do
    if [[ "$candidate" == "$needle" ]]; then
      return 0
    fi
  done

  return 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
env_file="${PANDA_STACK_ENV_FILE:-$repo_root/.env}"
base_compose="$repo_root/examples/docker-compose.remote-bash.external-db.yml"
wiki_compose="$repo_root/examples/docker-compose.wiki.yml"
generated_dir="$repo_root/.generated"
generated_compose="$generated_dir/docker-compose.remote-bash.external-db.runners.yml"
generated_wiki_compose="$generated_dir/docker-compose.wiki.ssl.yml"
docker_bin="${PANDA_DOCKER_BIN:-docker}"
wiki_local_script="${PANDA_WIKI_LOCAL_SCRIPT:-$repo_root/scripts/wiki-local.sh}"
wait_timeout_sec="${PANDA_STACK_WAIT_TIMEOUT_SEC:-120}"

[[ -f "$env_file" ]] || die "env file not found: $env_file"
[[ -f "$base_compose" ]] || die "base compose file not found: $base_compose"
command -v "$docker_bin" >/dev/null 2>&1 || die "$docker_bin is not installed or not on PATH."

# shellcheck source=/dev/null
set -a
source "$env_file"
set +a

declare -a normalized_agents=()

parse_agents() {
  local raw_list token normalized
  raw_list="$(trim "${PANDA_AGENTS:-}")"
  if [[ -z "$raw_list" ]]; then
    return
  fi

  local IFS=','
  read -r -a raw_agents <<< "$raw_list"
  for token in "${raw_agents[@]}"; do
    token="$(trim "$token")"
    [[ -n "$token" ]] || continue
    normalized="$(normalize_agent_key "$token")"
    if ((${#normalized_agents[@]} > 0)) && array_contains "$normalized" "${normalized_agents[@]}"; then
      die "PANDA_AGENTS contains duplicate agent key after normalization: $normalized"
    fi
    normalized_agents+=("$normalized")
  done
}

parse_agents

resolve_wiki_ssl_cert_file() {
  local explicit
  explicit="$(trim "${WIKI_DB_SSL_CERT_FILE:-}")"
  if [[ -n "$explicit" ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi

  if [[ -f /etc/ssl/certs/panda-postgres-ca.crt ]]; then
    printf '/etc/ssl/certs/panda-postgres-ca.crt\n'
    return 0
  fi

  if [[ -f "$HOME/.panda/ca.crt" ]]; then
    printf '%s\n' "$HOME/.panda/ca.crt"
    return 0
  fi

  printf '\n'
}

render_generated_wiki_compose() {
  mkdir -p "$generated_dir"

  if [[ -z "${WIKI_DB_SSL_CERT_FILE:-}" ]]; then
    cat > "$generated_wiki_compose" <<'EOF'
services: {}
EOF
    return 0
  fi

  cat > "$generated_wiki_compose" <<EOF
services:
  wiki:
    volumes:
      - ${WIKI_DB_SSL_CERT_FILE}:/etc/ssl/certs/panda-postgres-ca.crt:ro
EOF
}

export WIKI_DB_SSL_CERT_FILE="${WIKI_DB_SSL_CERT_FILE:-$(resolve_wiki_ssl_cert_file)}"
render_generated_wiki_compose

agents_declared() {
  [[ -n "$(trim "${PANDA_AGENTS:-}")" ]]
}

enable_telegram_profile=0
if [[ -n "$(trim "${TELEGRAM_BOT_TOKEN:-}")" ]]; then
  enable_telegram_profile=1
fi

compose_args=(
  "$docker_bin" compose
  --env-file "$env_file"
  -f "$base_compose"
  -f "$generated_compose"
)
[[ -f "$wiki_compose" ]] || die "wiki compose file not found: $wiki_compose"
compose_args+=(-f "$wiki_compose")
compose_args+=(-f "$generated_wiki_compose")
if (( enable_telegram_profile )); then
  compose_args+=(--profile telegram)
fi

run_compose() {
  (
    cd "$repo_root"
    "${compose_args[@]}" "$@"
  )
}

ensure_host_dirs() {
  local core_root shared_root browser_root agent_key
  core_root="$HOME/.panda"
  shared_root="$(expand_home "${SHARED_ROOT:-$HOME/.panda/shared}")"
  browser_root="$(expand_home "${BROWSER_RUNNER_ROOT:-$HOME/.panda-browser-runner}")"

  mkdir -p "$core_root" "$shared_root" "$browser_root"
  if ! agents_declared; then
    return
  fi

  for agent_key in "${normalized_agents[@]}"; do
    mkdir -p "$core_root/agents/$agent_key"
  done
}

render_generated_compose() {
  local agent_key
  mkdir -p "$generated_dir"

  if ! agents_declared; then
    cat > "$generated_compose" <<'EOF'
services: {}
EOF
    return
  fi

  {
    printf 'services:\n'
    for agent_key in "${normalized_agents[@]}"; do
      cat <<EOF
  panda-runner-$agent_key:
    image: panda:latest
    command: ["runner"]
    environment:
      RUNNER_AGENT_KEY: $agent_key
      RUNNER_PORT: 8080
    volumes:
      - \${HOME}/.panda/agents/$agent_key:/root/.panda/agents/$agent_key
      - \${SHARED_ROOT:-\${HOME}/.panda/shared}:/workspace/shared
    networks:
      - runner_net
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 5s
EOF
    done
  } > "$generated_compose"
}

resolve_service_name() {
  local input agent_key normalized_input
  input="${1:-}"
  if [[ -z "$input" ]]; then
    printf '\n'
    return
  fi

  case "$input" in
    core|panda-core)
      printf 'panda-core\n'
      return
      ;;
    browser|panda-browser-runner)
      printf 'panda-browser-runner\n'
      return
      ;;
    wiki)
      printf 'wiki\n'
      return
      ;;
    telegram|panda-telegram)
      printf 'panda-telegram\n'
      return
      ;;
  esac

  if ! agents_declared; then
    printf '%s\n' "$input"
    return
  fi

  normalized_input=""
  if normalized_input="$(normalize_agent_key "$input" 2>/dev/null)"; then
    for agent_key in "${normalized_agents[@]}"; do
      if [[ "$agent_key" == "$normalized_input" ]]; then
        printf 'panda-runner-%s\n' "$agent_key"
        return
      fi
    done
  fi

  printf '%s\n' "$input"
}

wait_for_core_health() {
  local started_at container_id status
  started_at="$(date +%s)"

  while true; do
    container_id="$(run_compose ps -q panda-core 2>/dev/null | head -n 1 || true)"
    if [[ -n "$container_id" ]]; then
      status="$("$docker_bin" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      case "$status" in
        healthy)
          return
          ;;
        exited|dead)
          die "panda-core exited before becoming healthy. Check ./scripts/docker-stack.sh logs core"
          ;;
      esac
    fi

    if (( "$(date +%s)" - started_at >= wait_timeout_sec )); then
      die "Timed out waiting for panda-core to become healthy. Check ./scripts/docker-stack.sh logs core"
    fi

    sleep 2
  done
}

ensure_declared_agents() {
  local agent_key
  if ! agents_declared; then
    return
  fi

  for agent_key in "${normalized_agents[@]}"; do
    run_compose exec -T panda-core panda agent ensure "$agent_key"
  done
}

bootstrap_wiki_if_configured() {
  if [[ -z "$(trim "${WIKI_ADMIN_EMAIL:-}")" ]] || [[ -z "$(trim "${WIKI_ADMIN_PASSWORD:-}")" ]]; then
    printf 'Wiki.js is running but not bootstrapped yet.\n'
    printf 'Set WIKI_ADMIN_EMAIL and WIKI_ADMIN_PASSWORD in %s, then run:\n' "$env_file"
    printf '  WIKI_ENV_FILE=%s %s bootstrap\n' "$env_file" "$wiki_local_script"
    return
  fi

  if ! agents_declared; then
    printf 'Wiki.js is running, but PANDA_AGENTS is empty, so agent wiki bootstrap was skipped.\n'
    return
  fi

  (
    cd "$repo_root"
    WIKI_ENV_FILE="$env_file" "$wiki_local_script" bootstrap "${normalized_agents[@]}"
  )
}

print_up_summary() {
  local agent_key
  printf 'Stack is up.\n'
  if ! agents_declared; then
    printf 'Agents: none declared in PANDA_AGENTS yet.\n'
  else
    printf 'Agents: %s\n' "${normalized_agents[*]}"
  fi
  printf 'Follow-up:\n'
  printf '  ./scripts/docker-stack.sh ps\n'
  printf '  ./scripts/docker-stack.sh logs core\n'
  printf '  ./scripts/docker-stack.sh logs browser\n'
  printf '  ./scripts/docker-stack.sh logs wiki\n'
  if (( enable_telegram_profile )); then
    printf '  ./scripts/docker-stack.sh logs telegram\n'
  fi
  if ! agents_declared; then
    return
  fi

  for agent_key in "${normalized_agents[@]}"; do
    printf '  ./scripts/docker-stack.sh logs %s\n' "$agent_key"
  done
}

run_up() {
  local build_flag=$1
  ensure_host_dirs
  render_generated_compose
  if (( build_flag )); then
    run_compose up -d --build --remove-orphans
  else
    run_compose up -d --remove-orphans
  fi
  wait_for_core_health
  ensure_declared_agents
  bootstrap_wiki_if_configured
  print_up_summary
}

run_down() {
  render_generated_compose
  run_compose down --remove-orphans
}

run_ps() {
  render_generated_compose
  run_compose ps
}

run_logs() {
  local service_name
  render_generated_compose
  service_name="$(resolve_service_name "${1:-}")"
  if [[ -n "$service_name" ]]; then
    run_compose logs -f "$service_name"
    return
  fi

  run_compose logs -f
}

run_restart() {
  run_up 0
}

command_name="${1:-}"
case "$command_name" in
  up)
    shift || true
    build_flag=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --build)
          build_flag=1
          shift
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "unknown option for up: $1"
          ;;
      esac
    done
    run_up "$build_flag"
    ;;
  down)
    shift || true
    [[ $# -eq 0 ]] || die "down does not take arguments."
    run_down
    ;;
  ps)
    shift || true
    [[ $# -eq 0 ]] || die "ps does not take arguments."
    run_ps
    ;;
  logs)
    shift || true
    [[ $# -le 1 ]] || die "logs accepts at most one service or agent key."
    run_logs "${1:-}"
    ;;
  restart)
    shift || true
    [[ $# -eq 0 ]] || die "restart does not take arguments."
    run_restart
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    die "unknown command: $command_name"
    ;;
esac
