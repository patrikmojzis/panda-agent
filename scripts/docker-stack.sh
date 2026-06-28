#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/docker-stack.sh up [--build]
  ./scripts/docker-stack.sh down
  ./scripts/docker-stack.sh ps
  ./scripts/docker-stack.sh logs [core|browser|gateway|telegram|discord|whatsapp|wiki|<agentKey>|<service>]
  ./scripts/docker-stack.sh panda <panda args...>
  ./scripts/docker-stack.sh restart

Primary flow:
  1. Set PANDA_AGENTS=claw,luna in .env
  2. Set WIKI_ADMIN_EMAIL and WIKI_ADMIN_PASSWORD in .env
  3. Run ./scripts/docker-stack.sh up --build

Notes:
  - One bash runner container is created per agent in PANDA_AGENTS.
  - Disposable worker runners are enabled only when PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true.
  - The browser runner is shared.
  - Telegram polling is enabled when TELEGRAM_ENABLED=true; it runs all enabled Telegram connector accounts.
  - Discord all-enabled workers are enabled when DISCORD_ENABLED=true in .env.
  - WhatsApp polling is enabled when WHATSAPP_ENABLED=true in .env.
  - Wiki.js is part of the stack.
  - Wiki bootstrap follows PANDA_AGENTS.
  - Public Caddy edge is auto-enabled when PANDA_APPS_BASE_URL or PANDA_GATEWAY_BASE_URL is set.
  - Panda Trace collector integration is labels-only and opt-in via PANDA_TRACE_COLLECTOR_ENABLED=true.
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

expand_home_variable() {
  local value
  value="$(trim "$1")"
  if [[ "$value" == "\$HOME" ]] || [[ "$value" == "\${HOME}" ]]; then
    printf '%s\n' "$HOME"
    return
  fi
  if [[ "$value" == "\$HOME/"* ]]; then
    printf '%s/%s\n' "$HOME" "${value#\$HOME/}"
    return
  fi
  if [[ "$value" == "\${HOME}/"* ]]; then
    printf '%s/%s\n' "$HOME" "${value#\$\{HOME\}/}"
    return
  fi

  printf '%s\n' "$value"
}

resolve_environment_host_root() {
  local value expanded
  value="${PANDA_ENVIRONMENTS_HOST_ROOT:-$HOME/.panda/environments}"
  expanded="$(expand_home "$(expand_home_variable "$value")")"
  [[ "$expanded" != *'$'* ]] \
    || die "PANDA_ENVIRONMENTS_HOST_ROOT must not contain shell variables other than HOME."
  case "$expanded" in
    /*)
      printf '%s\n' "$expanded"
      ;;
    *)
      die "PANDA_ENVIRONMENTS_HOST_ROOT must be an absolute path."
      ;;
  esac
}

docker_socket_path_from_host() {
  local docker_host
  docker_host="$(trim "${PANDA_DOCKER_HOST:-unix:///var/run/docker.sock}")"
  case "$docker_host" in
    unix://*)
      printf '%s\n' "${docker_host#unix://}"
      ;;
    /*)
      printf '%s\n' "$docker_host"
      ;;
    *)
      printf '\n'
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

validate_node_major() {
  local value=$1
  local label=$2
  case "$value" in
    20|22|24)
      ;;
    *)
      die "$label must be one of: 20, 22, 24."
      ;;
  esac
}

read_runner_node_major() {
  local value
  value="$(trim "${PANDA_RUNNER_NODE_MAJOR:-22}")"
  validate_node_major "$value" "PANDA_RUNNER_NODE_MAJOR"
  printf '%s\n' "$value"
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
env_file="${PANDA_STACK_ENV_FILE:-$repo_root/.env}"
base_compose="$repo_root/examples/docker-compose.remote-bash.external-db.yml"
wiki_compose="$repo_root/examples/docker-compose.wiki.yml"
apps_edge_compose="$repo_root/examples/docker-compose.apps-edge.yml"
generated_dir="$repo_root/.generated"
generated_compose="$generated_dir/docker-compose.remote-bash.external-db.runners.yml"
generated_wiki_compose="$generated_dir/docker-compose.wiki.ssl.yml"
generated_public_caddyfile="$generated_dir/Caddyfile.public-edge"
docker_bin="${PANDA_DOCKER_BIN:-docker}"
wiki_local_script="${PANDA_WIKI_LOCAL_SCRIPT:-$repo_root/scripts/wiki-local.sh}"
wait_timeout_sec="${PANDA_STACK_WAIT_TIMEOUT_SEC:-120}"
env_loader="$script_dir/lib/load-env-file.sh"

[[ -f "$env_file" ]] || die "env file not found: $env_file"
[[ -f "$base_compose" ]] || die "base compose file not found: $base_compose"
[[ -f "$env_loader" ]] || die "env loader not found: $env_loader"
command -v "$docker_bin" >/dev/null 2>&1 || die "$docker_bin is not installed or not on PATH."

env_file="$(cd "$(dirname "$env_file")" && pwd -P)/$(basename "$env_file")"
export PANDA_STACK_SERVICE_ENV_FILE="$env_file"

# shellcheck source=/dev/null
source "$env_loader"
load_env_file "$env_file"

normalized_environment_host_root="$(resolve_environment_host_root)" || exit "$?"
export PANDA_ENVIRONMENTS_HOST_ROOT="$normalized_environment_host_root"

declare -a normalized_agents=()
declare -a panda_trace_services=()
declare -a panda_trace_source_ids=()

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
  local wiki_db_ssl_cert_file wiki_publish_port
  mkdir -p "$generated_dir"
  wiki_db_ssl_cert_file="$(trim "${WIKI_DB_SSL_CERT_FILE:-}")"
  wiki_publish_port="$(trim "${WIKI_PUBLISH_PORT:-}")"

  if [[ -z "$wiki_db_ssl_cert_file" && -z "$wiki_publish_port" ]] && (( ! enable_discord_profile )); then
    cat > "$generated_wiki_compose" <<'EOF'
services: {}
EOF
    return 0
  fi

  cat > "$generated_wiki_compose" <<EOF
services:
  wiki:
EOF

  if (( enable_discord_profile )); then
    cat >> "$generated_wiki_compose" <<'EOF'
    depends_on:
      panda-discord:
        condition: service_started
EOF
  fi

  if [[ -n "$wiki_db_ssl_cert_file" ]]; then
    cat >> "$generated_wiki_compose" <<EOF
    volumes:
      - ${wiki_db_ssl_cert_file}:/etc/ssl/certs/panda-postgres-ca.crt:ro
EOF
  fi

  if [[ -n "$wiki_publish_port" ]]; then
    cat >> "$generated_wiki_compose" <<EOF
    ports:
      - "127.0.0.1:${wiki_publish_port}:3000"
EOF
  fi
}

export WIKI_DB_SSL_CERT_FILE="${WIKI_DB_SSL_CERT_FILE:-$(resolve_wiki_ssl_cert_file)}"

agents_declared() {
  [[ -n "$(trim "${PANDA_AGENTS:-}")" ]]
}

env_truthy() {
  local enabled_raw
  enabled_raw="$(trim "$1")"
  case "$enabled_raw" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

env_falsey() {
  local enabled_raw
  enabled_raw="$(trim "$1")"
  case "$enabled_raw" in
    0|false|FALSE|False|no|NO|No|off|OFF|Off)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_truthy() {
  local value
  value="$(trim "$1")"
  case "$value" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

trace_compose_service_name() {
  local token
  token="$(printf '%s' "$(trim "$1")" | tr '[:upper:]' '[:lower:]')"
  case "$token" in
    core|panda-core)
      printf 'panda-core\n'
      ;;
    browser|panda-browser-runner)
      printf 'panda-browser-runner\n'
      ;;
    telegram|panda-telegram)
      printf 'panda-telegram\n'
      ;;
    discord|panda-discord)
      printf 'panda-discord\n'
      ;;
    whatsapp|panda-whatsapp)
      printf 'panda-whatsapp\n'
      ;;
    gateway|panda-gateway)
      printf 'panda-gateway\n'
      ;;
    environment-manager|env|panda-environment-manager)
      printf 'panda-environment-manager\n'
      ;;
    runners|runner|panda-runners)
      printf 'panda-runners\n'
      ;;
    wiki)
      printf 'wiki\n'
      ;;
    caddy|edge)
      printf 'caddy\n'
      ;;
    *)
      die "PANDA_TRACE_COLLECTOR_SERVICES contains unsupported service: $1. Supported services: core, telegram, discord, whatsapp, environment-manager, runners, wiki, caddy."
      ;;
  esac
}

trace_source_env_suffix() {
  case "$1" in
    panda-core)
      printf 'CORE\n'
      ;;
    panda-browser-runner)
      printf 'BROWSER\n'
      ;;
    panda-telegram)
      printf 'TELEGRAM\n'
      ;;
    panda-discord)
      printf 'DISCORD\n'
      ;;
    panda-whatsapp)
      printf 'WHATSAPP\n'
      ;;
    panda-gateway)
      printf 'GATEWAY\n'
      ;;
    panda-environment-manager)
      printf 'ENVIRONMENT_MANAGER\n'
      ;;
    panda-runners)
      printf 'RUNNERS\n'
      ;;
    wiki)
      printf 'WIKI\n'
      ;;
    caddy)
      printf 'CADDY\n'
      ;;
    *)
      die "Unsupported Panda Trace service: $1"
      ;;
  esac
}

trace_service_index() {
  local compose_service=$1 index
  for index in "${!panda_trace_services[@]}"; do
    if [[ "${panda_trace_services[$index]}" == "$compose_service" ]]; then
      printf '%s\n' "$index"
      return 0
    fi
  done

  return 1
}

trace_service_selected() {
  trace_service_index "$1" >/dev/null
}

trace_service_source_id() {
  local index
  index="$(trace_service_index "$1")" || return 1
  printf '%s\n' "${panda_trace_source_ids[$index]}"
}

parse_trace_collector_services() {
  local raw_list token compose_service source_suffix source_var source_id
  raw_list="$(trim "${PANDA_TRACE_COLLECTOR_SERVICES:-}")"
  [[ -n "$raw_list" ]] \
    || die "PANDA_TRACE_COLLECTOR_ENABLED=true requires PANDA_TRACE_COLLECTOR_SERVICES (supported: core, telegram, discord, whatsapp, environment-manager, runners, wiki, caddy)."

  local IFS=','
  read -r -a raw_services <<< "$raw_list"
  for token in "${raw_services[@]}"; do
    token="$(trim "$token")"
    [[ -n "$token" ]] || continue
    compose_service="$(trace_compose_service_name "$token")"
    if trace_service_selected "$compose_service"; then
      die "PANDA_TRACE_COLLECTOR_SERVICES contains duplicate service: $token"
    fi
    source_suffix="$(trace_source_env_suffix "$compose_service")"
    source_var="PANDA_TRACE_SOURCE_$source_suffix"
    source_id="$(trim "${!source_var:-}")"
    [[ -n "$source_id" ]] \
      || die "$source_var is required when PANDA_TRACE_COLLECTOR_SERVICES includes $token."
    panda_trace_services+=("$compose_service")
    panda_trace_source_ids+=("$source_id")
  done

  ((${#panda_trace_services[@]} > 0)) \
    || die "PANDA_TRACE_COLLECTOR_ENABLED=true requires at least one selected service."
}

validate_trace_collector_config() {
  local service
  [[ -z "$(trim "${PANDA_TRACE_KEY:-}")" ]] \
    || die "PANDA_TRACE_KEY must not be set in the Panda Agent stack env. Put the collector logs:write key in the host-level panda_trace_collector env instead."

  if (( ! enable_trace_collector )); then
    return
  fi

  for service in "${panda_trace_services[@]}"; do
    if [[ "$service" == "panda-gateway" ]] && (( ! enable_gateway_edge )); then
      die "PANDA_TRACE_COLLECTOR_SERVICES includes gateway, but panda-gateway is generated only when PANDA_GATEWAY_ENABLED=true or PANDA_GATEWAY_BASE_URL is set."
    fi
    if [[ "$service" == "caddy" ]] && (( ! enable_apps_edge && ! enable_gateway_edge )); then
      die "PANDA_TRACE_COLLECTOR_SERVICES includes caddy, but caddy is generated only when PANDA_APPS_BASE_URL or PANDA_GATEWAY_BASE_URL is set."
    fi
  done
}

render_trace_labels() {
  local compose_service=$1 indent source_id environment
  indent="${2:-    }"
  if ! trace_service_selected "$compose_service"; then
    return
  fi

  source_id="$(trace_service_source_id "$compose_service")"
  environment="$(trim "${PANDA_TRACE_ENVIRONMENT:-prod}")"
  [[ -n "$environment" ]] || environment="prod"
  cat <<EOF
${indent}labels:
${indent}  panda_trace.enabled: "true"
${indent}  panda_trace.source_id: "$source_id"
${indent}  panda_trace.service: "$compose_service"
${indent}  panda_trace.environment: "$environment"
EOF
}

trace_service_has_generated_section() {
  case "$1" in
    panda-core)
      (( enable_apps_edge || enable_disposable_environments || enable_control ))
      ;;
    panda-browser-runner)
      (( enable_disposable_environments ))
      ;;
    panda-gateway)
      (( enable_gateway_edge ))
      ;;
    panda-environment-manager)
      (( enable_disposable_environments ))
      ;;
    panda-runners)
      agents_declared
      ;;
    caddy)
      (( enable_public_edge ))
      ;;
    *)
      return 1
      ;;
  esac
}

render_trace_label_only_services() {
  local service
  if (( ! enable_trace_collector )); then
    return
  fi

  for service in "${panda_trace_services[@]}"; do
    if trace_service_has_generated_section "$service"; then
      continue
    fi
    printf '  %s:\n' "$service"
    render_trace_labels "$service" "    "
  done
}

extract_https_url_host() {
  local value without_scheme host
  value="$(trim "$1")"
  [[ "$value" == https://* ]] || return 1
  without_scheme="${value#https://}"
  [[ "$without_scheme" != *"@"* ]] || return 1
  [[ "$without_scheme" != *"?"* ]] || return 1
  [[ "$without_scheme" != *"#"* ]] || return 1
  host="${without_scheme%%/*}"
  [[ "$without_scheme" == "$host" || "$without_scheme" == "$host/" ]] || return 1
  host="${host%%:*}"
  [[ -n "$host" ]] || return 1
  printf '%s\n' "$host"
}

validate_apps_edge_config() {
  local base_url public_host base_host
  if (( ! enable_apps_edge )); then
    return
  fi

  base_url="$(trim "${PANDA_APPS_BASE_URL:-}")"
  public_host="$(trim "${PANDA_APPS_PUBLIC_HOST:-}")"
  base_host="$(extract_https_url_host "$base_url")" \
    || die "PANDA_APPS_BASE_URL must be a plain https:// origin when exposing public apps."
  [[ -n "$public_host" ]] \
    || die "PANDA_APPS_PUBLIC_HOST is required when exposing public apps."
  [[ "$base_host" == "$public_host" ]] \
    || die "PANDA_APPS_PUBLIC_HOST must match PANDA_APPS_BASE_URL host ($base_host)."
}

validate_gateway_edge_config() {
  local base_url public_host base_host allowlist guard_model edge_subnet
  if (( ! enable_gateway_edge )); then
    return
  fi

  base_url="$(trim "${PANDA_GATEWAY_BASE_URL:-}")"
  public_host="$(trim "${PANDA_GATEWAY_PUBLIC_HOST:-}")"
  allowlist="$(trim "${GATEWAY_IP_ALLOWLIST:-}")"
  guard_model="$(trim "${GATEWAY_GUARD_MODEL:-}")"
  edge_subnet="$(trim "${PANDA_GATEWAY_EDGE_SUBNET:-172.31.94.0/24}")"
  base_host="$(extract_https_url_host "$base_url")" \
    || die "PANDA_GATEWAY_BASE_URL must be a plain https:// origin when exposing public gateway."
  [[ -n "$public_host" ]] \
    || die "PANDA_GATEWAY_PUBLIC_HOST is required when exposing public gateway."
  [[ "$base_host" == "$public_host" ]] \
    || die "PANDA_GATEWAY_PUBLIC_HOST must match PANDA_GATEWAY_BASE_URL host ($base_host)."
  [[ -n "$allowlist" ]] \
    || die "GATEWAY_IP_ALLOWLIST is required when exposing public gateway."
  if is_truthy "${GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST:-}"; then
    die "GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST must not be enabled for the docker public gateway edge."
  fi
  [[ -n "$guard_model" ]] \
    || die "GATEWAY_GUARD_MODEL is required when exposing public gateway."
  [[ -n "$edge_subnet" ]] \
    || die "PANDA_GATEWAY_EDGE_SUBNET is required when exposing public gateway."

  if [[ -z "$(trim "${GATEWAY_TRUSTED_PROXY_IPS:-}")" ]]; then
    export GATEWAY_TRUSTED_PROXY_IPS="$edge_subnet"
  fi
  if [[ -z "$(trim "${PANDA_GATEWAY_EDGE_SUBNET:-}")" ]]; then
    export PANDA_GATEWAY_EDGE_SUBNET="$edge_subnet"
  fi
}

validate_public_edge_config() {
  if (( enable_apps_edge && enable_gateway_edge )); then
    if [[ "$(trim "${PANDA_APPS_PUBLIC_HOST:-}")" == "$(trim "${PANDA_GATEWAY_PUBLIC_HOST:-}")" ]]; then
      die "PANDA_GATEWAY_PUBLIC_HOST must not match PANDA_APPS_PUBLIC_HOST."
    fi
  fi
}

render_generated_public_caddyfile() {
  local apps_port gateway_port
  apps_port="$(trim "${PANDA_APPS_PORT:-8092}")"
  gateway_port="$(trim "${GATEWAY_PORT:-8094}")"
  mkdir -p "$generated_dir"
  if (( ! enable_public_edge )); then
    cat > "$generated_public_caddyfile" <<'EOF'
# Generated by scripts/docker-stack.sh. Public edge is disabled.
EOF
    return
  fi

  : > "$generated_public_caddyfile"
  if (( enable_apps_edge )); then
    cat >> "$generated_public_caddyfile" <<EOF
${PANDA_APPS_PUBLIC_HOST} {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
	}

	@unsafeDotSegments vars_regexp {http.request.orig_uri.path} (?i)(^|/)(?:[.]|%2e){1,2}(?:/|$)
	handle @unsafeDotSegments {
		respond "Bad request" 400
	}

	handle {
		reverse_proxy panda-core:${apps_port} {
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Host {host}
			header_up X-Forwarded-Proto {scheme}
		}
	}
}

EOF
  fi

  if (( enable_gateway_edge )); then
    cat >> "$generated_public_caddyfile" <<EOF
${PANDA_GATEWAY_PUBLIC_HOST} {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
	}

	@unsafeDotSegments vars_regexp {http.request.orig_uri.path} (?i)(^|/)(?:[.]|%2e){1,2}(?:/|$)
	handle @unsafeDotSegments {
		respond "Bad request" 400
	}

	handle {
		reverse_proxy panda-gateway:${gateway_port} {
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Host {host}
			header_up X-Forwarded-Proto {scheme}
		}
	}
}

EOF
  fi
}

enable_telegram_profile=0
if is_truthy "${TELEGRAM_ENABLED:-}"; then
  enable_telegram_profile=1
fi

enable_whatsapp_profile=0
if is_truthy "${WHATSAPP_ENABLED:-}"; then
  enable_whatsapp_profile=1
fi

enable_discord_profile=0
if is_truthy "${DISCORD_ENABLED:-}"; then
  enable_discord_profile=1
fi

enable_apps_edge=0
if [[ -n "$(trim "${PANDA_APPS_BASE_URL:-}")" ]]; then
  enable_apps_edge=1
fi
enable_gateway_edge=0
if [[ -n "$(trim "${PANDA_GATEWAY_BASE_URL:-}")" ]] || is_truthy "${PANDA_GATEWAY_ENABLED:-}"; then
  enable_gateway_edge=1
fi

enable_control=0
if is_truthy "${PANDA_CONTROL_ENABLED:-}"; then
  enable_control=1
fi

enable_trace_collector=0
if is_truthy "${PANDA_TRACE_COLLECTOR_ENABLED:-}"; then
  enable_trace_collector=1
  parse_trace_collector_services
fi

enable_public_edge=0
if (( enable_apps_edge || enable_gateway_edge )); then
  enable_public_edge=1
fi

disposable_environments_enabled() {
  if env_falsey "${PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED:-}"; then
    return 1
  fi

  env_truthy "${PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED:-}"
}

default_compose_project_name() {
  local explicit
  explicit="$(trim "${COMPOSE_PROJECT_NAME:-}")"
  if [[ -n "$explicit" ]]; then
    printf '%s\n' "$explicit"
    return
  fi

  basename "$(dirname "$base_compose")"
}

enable_disposable_environments=0
if disposable_environments_enabled; then
  enable_disposable_environments=1
fi
use_managed_environment_manager=0
if (( enable_disposable_environments )) && [[ -z "$(trim "${PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL:-}")" ]]; then
  use_managed_environment_manager=1
fi

configure_disposable_environment_defaults() {
  local compose_project
  if (( ! enable_disposable_environments )); then
    return
  fi

  compose_project="$(default_compose_project_name)"
  export PANDA_DISPOSABLE_RUNNER_NETWORK="${PANDA_DISPOSABLE_RUNNER_NETWORK:-${compose_project}_disposable_runner_net}"
  export PANDA_DISPOSABLE_LOCAL_ONLY_NETWORK="${PANDA_DISPOSABLE_LOCAL_ONLY_NETWORK:-${compose_project}_disposable_local_only_net}"
  export PANDA_EXECUTION_ENVIRONMENT_MANAGER_NETWORK="${PANDA_EXECUTION_ENVIRONMENT_MANAGER_NETWORK:-${compose_project}_execution_manager_net}"
  if (( use_managed_environment_manager )); then
    export PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL="http://panda-environment-manager:${PANDA_EXECUTION_ENVIRONMENT_MANAGER_PORT:-8095}"
  fi
}

validate_disposable_environment_config() {
  local token
  if (( ! enable_disposable_environments )); then
    return
  fi

  token="$(trim "${PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN:-}")"
  [[ -n "$token" ]] \
    || die "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN is required when disposable environments are enabled."
}

configure_disposable_environment_defaults
validate_apps_edge_config
validate_gateway_edge_config
validate_public_edge_config
validate_trace_collector_config
render_generated_wiki_compose

compose_args=(
  "$docker_bin" compose
  --env-file "$env_file"
  -f "$base_compose"
  -f "$generated_compose"
)
[[ -f "$wiki_compose" ]] || die "wiki compose file not found: $wiki_compose"
compose_args+=(-f "$wiki_compose")
compose_args+=(-f "$generated_wiki_compose")
if (( enable_public_edge )); then
  [[ -f "$apps_edge_compose" ]] || die "apps edge compose file not found: $apps_edge_compose"
  compose_args+=(-f "$apps_edge_compose")
fi
if (( enable_telegram_profile )); then
  compose_args+=(--profile telegram)
fi
if (( enable_whatsapp_profile )); then
  compose_args+=(--profile whatsapp)
fi
if (( enable_discord_profile )); then
  compose_args+=(--profile discord)
fi

run_compose() {
  (
    cd "$repo_root"
    "${compose_args[@]}" "$@"
  )
}

run_docker_build() {
  (
    cd "$repo_root"
    DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}" "$docker_bin" build "$@"
  )
}

workspace_runner_stage() {
  local stage
  if ! stage="$(awk '
    /^FROM ubuntu:24[.]04 AS workspace-runner$/ {
      found = 1
    }
    found && /^FROM[[:space:]]/ && $0 !~ /^FROM ubuntu:24[.]04 AS workspace-runner$/ {
      exit
    }
    found {
      print
    }
    END {
      if (!found) {
        exit 1
      }
    }
  ' "$repo_root/Dockerfile")"; then
    printf 'error: Could not extract workspace-runner stage from Dockerfile.\n' >&2
    return 1
  fi

  if [[ -z "$(trim "$stage")" ]]; then
    printf 'error: Extracted workspace-runner stage from Dockerfile is empty.\n' >&2
    return 1
  fi
  printf '%s\n' "$stage"
}

workspace_image_hash() {
  local stage
  stage="$(workspace_runner_stage)" || return
  {
    printf 'panda-workspace-cache-v1\n'
    printf 'target=workspace-runner\n'
    printf '%s\n' "$stage"
  } | sha256sum | awk '{print substr($1, 1, 16)}'
}

workspace_default_image() {
  local hash
  hash="$(workspace_image_hash)" || die "Could not compute workspace image hash."
  printf 'panda-workspace:%s\n' "$hash"
}

workspace_selected_image() {
  local explicit
  explicit="$(trim "${PANDA_DISPOSABLE_WORKSPACE_IMAGE:-}")"
  if [[ -n "$explicit" ]]; then
    printf '%s\n' "$explicit"
    return
  fi

  workspace_default_image
}

docker_image_exists() {
  local image=$1
  "$docker_bin" image inspect "$image" >/dev/null 2>&1
}

ensure_workspace_image() {
  local image explicit force=0
  image="$(workspace_selected_image)" || return
  explicit="$(trim "${PANDA_DISPOSABLE_WORKSPACE_IMAGE:-}")"

  if is_truthy "${PANDA_BUILD_WORKSPACE:-}" || is_truthy "${PANDA_REFRESH_WORKSPACE:-}"; then
    force=1
  fi

  if [[ -n "$explicit" && "$force" -eq 0 ]]; then
    printf 'Using explicit PANDA_DISPOSABLE_WORKSPACE_IMAGE=%s; skipping workspace image build. Set PANDA_BUILD_WORKSPACE=true or PANDA_REFRESH_WORKSPACE=true to rebuild it.\n' "$image" >&2
    return 0
  fi

  if [[ "$force" -eq 0 ]] && docker_image_exists "$image"; then
    printf 'Workspace image %s already exists; skipping rebuild. Set PANDA_REFRESH_WORKSPACE=true to force refresh.\n' "$image" >&2
    return 0
  fi

  run_docker_build --target workspace-runner -t "$image" "$repo_root"
}

build_stack_images() {
  local failed=0
  local pid
  local runner_node_major
  local build_pids=()

  if agents_declared || (( enable_disposable_environments )); then
    runner_node_major="$(read_runner_node_major)"
  fi

  run_docker_build --target app -t panda-app:latest "$repo_root"

  run_docker_build --target browser-runner -t panda-browser-runner:latest "$repo_root" &
  build_pids+=("$!")

  if agents_declared || (( enable_disposable_environments )); then
    run_docker_build --target bash-runner --build-arg "NODE_MAJOR=$runner_node_major" -t panda-runner:latest "$repo_root" &
    build_pids+=("$!")
  fi

  if (( enable_disposable_environments )); then
    ensure_workspace_image &
    build_pids+=("$!")
  fi

  for pid in "${build_pids[@]}"; do
    if ! wait "$pid"; then
      failed=1
    fi
  done

  return "$failed"
}

ensure_host_dirs() {
  local core_root shared_root browser_root environments_root agent_key
  core_root="$HOME/.panda"
  shared_root="$(expand_home "${SHARED_ROOT:-$HOME/.panda/shared}")"
  browser_root="$(expand_home "${BROWSER_RUNNER_ROOT:-$HOME/.panda-browser-runner}")"
  environments_root="$(expand_home "${PANDA_ENVIRONMENTS_HOST_ROOT:-$HOME/.panda/environments}")"

  mkdir -p "$core_root" "$shared_root" "$browser_root" "$environments_root"
  if ! agents_declared; then
    return
  fi

  for agent_key in "${normalized_agents[@]}"; do
    mkdir -p "$core_root/agents/$agent_key" "$environments_root/$agent_key"
  done
}

render_generated_compose() {
  local agent_key gateway_port manager_docker_socket workspace_image_default
  mkdir -p "$generated_dir"
  gateway_port="$(trim "${GATEWAY_PORT:-8094}")"
  manager_docker_socket=""
  if (( use_managed_environment_manager )); then
    manager_docker_socket="$(docker_socket_path_from_host)"
  fi
  if (( enable_disposable_environments )); then
    workspace_image_default="$(workspace_default_image)"
  fi
  if ! agents_declared && (( ! enable_apps_edge && ! enable_gateway_edge && ! enable_disposable_environments && ! enable_control && ! enable_trace_collector )); then
    cat > "$generated_compose" <<'EOF'
services: {}
EOF
    return
  fi

  {
    printf 'services:\n'
    if (( enable_apps_edge || enable_disposable_environments || enable_control )); then
      cat <<EOF
  panda-core:
EOF
      render_trace_labels "panda-core" "    "
      if (( enable_apps_edge || enable_disposable_environments || enable_control )); then
        cat <<EOF
    environment:
EOF
      fi
      if (( enable_apps_edge )); then
        cat <<EOF
      PANDA_APPS_AUTH: required
      PANDA_APPS_BASE_URL: \${PANDA_APPS_BASE_URL}
EOF
      fi
      if (( enable_control )); then
        cat <<EOF
      PANDA_CONTROL_ENABLED: "true"
      PANDA_CONTROL_HOST: 0.0.0.0
      PANDA_CONTROL_PORT: \${PANDA_CONTROL_PORT:-4767}
      PANDA_CONTROL_UI_DIR: \${PANDA_CONTROL_UI_DIR:-/app/control-ui}
EOF
      fi
      if (( enable_disposable_environments )); then
        cat <<EOF
      PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL: \${PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL}
      PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN: \${PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN}
      PANDA_ENVIRONMENTS_ROOT: \${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}
      PANDA_CORE_ENVIRONMENTS_ROOT: \${PANDA_CORE_ENVIRONMENTS_ROOT:-\${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}}
      PANDA_RUNNER_ENVIRONMENTS_ROOT: \${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}
EOF
      fi
      if (( enable_control )); then
        cat <<EOF
    ports:
      - "\${PANDA_CONTROL_PUBLISH_HOST:-127.0.0.1}:\${PANDA_CONTROL_PUBLISH_PORT:-\${PANDA_CONTROL_PORT:-4767}}:\${PANDA_CONTROL_PORT:-4767}"
EOF
      fi
      if (( use_managed_environment_manager )); then
        cat <<EOF
    depends_on:
      panda-environment-manager:
        condition: service_healthy
EOF
      fi
      if (( enable_apps_edge || enable_disposable_environments )); then
        cat <<EOF
    networks:
EOF
      fi
      if (( enable_apps_edge )); then
        cat <<EOF
      - apps_edge_net
EOF
      fi
      if (( use_managed_environment_manager )); then
        cat <<EOF
      - execution_manager_net
EOF
      fi
      if (( enable_disposable_environments )); then
        cat <<EOF
      - disposable_runner_net
      - disposable_local_only_net
EOF
      fi
    fi

    if (( use_managed_environment_manager )); then
      cat <<EOF
  panda-environment-manager:
    image: panda-app:latest
EOF
      render_trace_labels "panda-environment-manager" "    "
      cat <<EOF
    command: ["environment-manager"]
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp
    environment:
      PANDA_EXECUTION_ENVIRONMENT_MANAGER_HOST: 0.0.0.0
      PANDA_EXECUTION_ENVIRONMENT_MANAGER_PORT: \${PANDA_EXECUTION_ENVIRONMENT_MANAGER_PORT:-8095}
      PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL: \${PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL}
      PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN: \${PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN}
      PANDA_DOCKER_HOST: \${PANDA_DOCKER_HOST:-unix:///var/run/docker.sock}
      PANDA_DISPOSABLE_CONTROL_RUNNER_IMAGE: \${PANDA_DISPOSABLE_CONTROL_RUNNER_IMAGE:-\${PANDA_DISPOSABLE_RUNNER_IMAGE:-panda-runner:latest}}
      PANDA_DISPOSABLE_WORKSPACE_IMAGE: \${PANDA_DISPOSABLE_WORKSPACE_IMAGE:-$workspace_image_default}
      PANDA_DISPOSABLE_RUNNER_NETWORK: \${PANDA_DISPOSABLE_RUNNER_NETWORK}
      PANDA_DISPOSABLE_LOCAL_ONLY_NETWORK: \${PANDA_DISPOSABLE_LOCAL_ONLY_NETWORK}
      PANDA_DISPOSABLE_RUNNER_PORT: \${PANDA_DISPOSABLE_RUNNER_PORT:-8080}
      PANDA_DISPOSABLE_RUNNER_CWD: \${PANDA_DISPOSABLE_RUNNER_CWD:-/workspace}
      PANDA_ENVIRONMENTS_HOST_ROOT: $PANDA_ENVIRONMENTS_HOST_ROOT
      PANDA_ENVIRONMENTS_ROOT: \${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}
      PANDA_CORE_ENVIRONMENTS_ROOT: \${PANDA_CORE_ENVIRONMENTS_ROOT:-\${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}}
      PANDA_RUNNER_ENVIRONMENTS_ROOT: \${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}
      PANDA_DISPOSABLE_CONTAINER_PREFIX: \${PANDA_DISPOSABLE_CONTAINER_PREFIX:-panda-env}
      PANDA_DISPOSABLE_CREATE_TIMEOUT_MS: \${PANDA_DISPOSABLE_CREATE_TIMEOUT_MS:-300000}
      BASH_SERVER_SHARED_SECRET: \${BASH_SERVER_SHARED_SECRET:-}
      TZ: \${TZ:-UTC}
    volumes:
EOF
      if [[ -n "$manager_docker_socket" ]]; then
        cat <<EOF
      - "$manager_docker_socket:$manager_docker_socket"
EOF
      fi
      cat <<EOF
      - "$PANDA_ENVIRONMENTS_HOST_ROOT:\${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}"
    networks:
      - execution_manager_net
      - disposable_runner_net
      - disposable_local_only_net
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:\${PANDA_EXECUTION_ENVIRONMENT_MANAGER_PORT:-8095}/health"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 5s
EOF
    fi

    if (( enable_gateway_edge )); then
      cat <<EOF
  panda-gateway:
EOF
      render_trace_labels "panda-gateway" "    "
      cat <<EOF
    image: panda-app:latest
    command: ["gateway", "run"]
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp
    stop_grace_period: 30s
    environment:
      DATABASE_URL: \${DATABASE_URL}
      CREDENTIALS_MASTER_KEY: \${CREDENTIALS_MASTER_KEY:-}
      CODEX_HOME: /root/.codex
      DATA_DIR: /root/.panda
      GATEWAY_HOST: 0.0.0.0
      GATEWAY_PORT: \${GATEWAY_PORT:-8094}
      GATEWAY_IP_ALLOWLIST: \${GATEWAY_IP_ALLOWLIST}
      GATEWAY_TRUSTED_PROXY_IPS: \${GATEWAY_TRUSTED_PROXY_IPS}
      GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST: ""
      GATEWAY_GUARD_MODEL: \${GATEWAY_GUARD_MODEL}
      GATEWAY_GUARD_TIMEOUT_MS: \${GATEWAY_GUARD_TIMEOUT_MS:-}
      GATEWAY_ACCESS_TOKEN_TTL_MS: \${GATEWAY_ACCESS_TOKEN_TTL_MS:-}
      GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE: \${GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE:-}
      GATEWAY_MAX_TEXT_BYTES: \${GATEWAY_MAX_TEXT_BYTES:-}
      GATEWAY_RATE_LIMIT_PER_MINUTE: \${GATEWAY_RATE_LIMIT_PER_MINUTE:-}
      GATEWAY_TEXT_BYTES_PER_HOUR: \${GATEWAY_TEXT_BYTES_PER_HOUR:-}
      GATEWAY_MAX_ATTACHMENT_BYTES: \${GATEWAY_MAX_ATTACHMENT_BYTES:-}
      GATEWAY_MAX_ATTACHMENTS_PER_EVENT: \${GATEWAY_MAX_ATTACHMENTS_PER_EVENT:-}
      GATEWAY_MAX_EVENT_ATTACHMENT_BYTES: \${GATEWAY_MAX_EVENT_ATTACHMENT_BYTES:-}
      GATEWAY_ATTACHMENT_BYTES_PER_HOUR: \${GATEWAY_ATTACHMENT_BYTES_PER_HOUR:-}
      GATEWAY_MAX_PENDING_ATTACHMENTS_PER_SOURCE: \${GATEWAY_MAX_PENDING_ATTACHMENTS_PER_SOURCE:-}
      GATEWAY_ATTACHMENT_UPLOAD_TTL_MS: \${GATEWAY_ATTACHMENT_UPLOAD_TTL_MS:-}
      GATEWAY_ATTACHMENT_RETENTION_MS: \${GATEWAY_ATTACHMENT_RETENTION_MS:-}
      GATEWAY_ATTACHMENT_QUARANTINE_TTL_MS: \${GATEWAY_ATTACHMENT_QUARANTINE_TTL_MS:-}
      GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES: \${GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES:-}
      GATEWAY_HAE_JSON_TOKEN: \${GATEWAY_HAE_JSON_TOKEN:-}
      GATEWAY_HAE_JSON_INBOX_DIR: \${GATEWAY_HAE_JSON_INBOX_DIR:-}
      GATEWAY_HAE_JSON_MAX_BYTES: \${GATEWAY_HAE_JSON_MAX_BYTES:-}
      GATEWAY_HAE_JSON_SOURCE: \${GATEWAY_HAE_JSON_SOURCE:-}
      OPENAI_API_KEY: \${OPENAI_API_KEY:-}
      OPENAI_OAUTH_TOKEN: \${OPENAI_OAUTH_TOKEN:-}
      OPENAI_MODEL: \${OPENAI_MODEL:-gpt-5.1}
      OPENAI_CODEX_MODEL: \${OPENAI_CODEX_MODEL:-gpt-5.4}
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-}
      ANTHROPIC_AUTH_TOKEN: \${ANTHROPIC_AUTH_TOKEN:-}
      ANTHROPIC_OAUTH_TOKEN: \${ANTHROPIC_OAUTH_TOKEN:-}
      CLAUDE_CODE_OAUTH_TOKEN: \${CLAUDE_CODE_OAUTH_TOKEN:-}
      ANTHROPIC_MODEL: \${ANTHROPIC_MODEL:-claude-sonnet-4-5}
      PI_CACHE_RETENTION: \${PI_CACHE_RETENTION:-long}
      TZ: \${TZ:-UTC}
    volumes:
      - \${CODEX_HOST_HOME:-\${HOME}/.codex}:/root/.codex:ro
      - \${HOME}/.panda/agents:/root/.panda/agents
      - /etc/ssl/certs/panda-postgres-ca.crt:/etc/ssl/certs/panda-postgres-ca.crt:ro
    networks:
      - gateway_edge_net
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:${gateway_port}/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
EOF
    fi

    if (( enable_public_edge )); then
      cat <<EOF
  caddy:
EOF
      render_trace_labels "caddy" "    "
      cat <<EOF
    depends_on:
EOF
      if (( enable_apps_edge )); then
        cat <<EOF
      panda-core:
        condition: service_healthy
EOF
      fi
      if (( enable_gateway_edge )); then
        cat <<EOF
      panda-gateway:
        condition: service_healthy
EOF
      fi
      cat <<EOF
    networks:
EOF
      if (( enable_apps_edge )); then
        cat <<EOF
      - apps_edge_net
EOF
      fi
      if (( enable_gateway_edge )); then
        cat <<EOF
      - gateway_edge_net
EOF
      fi
    fi

    if (( enable_disposable_environments )); then
      cat <<'EOF'
  panda-browser-runner:
EOF
      render_trace_labels "panda-browser-runner" "    "
      cat <<'EOF'
    networks:
      - runner_net
      - disposable_runner_net
      - disposable_local_only_net
EOF
    fi

    if agents_declared; then
      for agent_key in "${normalized_agents[@]}"; do
        cat <<EOF
  panda-runner-$agent_key:
    image: panda-runner:latest
EOF
        render_trace_labels "panda-runners" "    "
        cat <<EOF
    command: ["bash-server"]
    restart: unless-stopped
    environment:
      BASH_SERVER_AGENT_KEY: $agent_key
      BASH_SERVER_PORT: 8080
      BASH_SERVER_SHARED_SECRET: \${BASH_SERVER_SHARED_SECRET:-}
      BASH_SERVER_ALLOWED_ROOTS: \${BASH_SERVER_ALLOWED_ROOTS:-}
      TZ: \${TZ:-UTC}
    volumes:
      - \${HOME}/.panda/agents/$agent_key:/root/.panda/agents/$agent_key
      - \${SHARED_ROOT:-\${HOME}/.panda/shared}:/workspace/shared
      - "$PANDA_ENVIRONMENTS_HOST_ROOT/$agent_key:\${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}"
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
    fi

    render_trace_label_only_services

    if (( enable_apps_edge || enable_gateway_edge || enable_disposable_environments )); then
      printf '\nnetworks:\n'
      if (( enable_apps_edge )); then
        cat <<'EOF'
  apps_edge_net:
EOF
      fi
      if (( use_managed_environment_manager )); then
        cat <<'EOF'
  execution_manager_net:
    name: ${PANDA_EXECUTION_ENVIRONMENT_MANAGER_NETWORK}
    internal: true
EOF
      fi
      if (( enable_disposable_environments )); then
        cat <<'EOF'
  disposable_runner_net:
    name: ${PANDA_DISPOSABLE_RUNNER_NETWORK}
  disposable_local_only_net:
    name: ${PANDA_DISPOSABLE_LOCAL_ONLY_NETWORK}
    internal: true
EOF
      fi
      if (( enable_gateway_edge )); then
        cat <<'EOF'
  gateway_edge_net:
    ipam:
      config:
        - subnet: ${PANDA_GATEWAY_EDGE_SUBNET:-172.31.94.0/24}
EOF
      fi
    fi
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
    env|environment|environment-manager|panda-environment-manager)
      printf 'panda-environment-manager\n'
      return
      ;;
    wiki)
      printf 'wiki\n'
      return
      ;;
    apps|app|edge|caddy)
      printf 'caddy\n'
      return
      ;;
    gateway|panda-gateway)
      printf 'panda-gateway\n'
      return
      ;;
    telegram|panda-telegram)
      printf 'panda-telegram\n'
      return
      ;;
    whatsapp|panda-whatsapp)
      printf 'panda-whatsapp\n'
      return
      ;;
    discord|panda-discord)
      printf 'panda-discord\n'
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

wiki_host_http_configured() {
  [[ -n "$(trim "${WIKI_SITE_URL:-}")" ]] || [[ -n "$(trim "${WIKI_PUBLISH_PORT:-}")" ]]
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

  if ! wiki_host_http_configured; then
    printf 'Warning: Wiki.js auto-bootstrap skipped because neither WIKI_SITE_URL nor WIKI_PUBLISH_PORT is configured for host-side HTTP access.\n'
    printf 'Set WIKI_SITE_URL or WIKI_PUBLISH_PORT in %s, then run:\n' "$env_file"
    printf '  WIKI_ENV_FILE=%s %s bootstrap %s\n' "$env_file" "$wiki_local_script" "${normalized_agents[*]}"
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
  if (( use_managed_environment_manager )); then
    printf '  ./scripts/docker-stack.sh logs environment-manager\n'
  fi
  printf '  ./scripts/docker-stack.sh logs wiki\n'
  if (( enable_apps_edge )); then
    printf '  ./scripts/docker-stack.sh logs apps\n'
  fi
  if (( enable_control )); then
    printf '  Control: http://%s:%s (host bind; set PANDA_CONTROL_PUBLISH_HOST to your Tailscale IP when needed)\n' "${PANDA_CONTROL_PUBLISH_HOST:-127.0.0.1}" "${PANDA_CONTROL_PUBLISH_PORT:-${PANDA_CONTROL_PORT:-4767}}"
  fi
  if (( enable_gateway_edge )); then
    printf '  ./scripts/docker-stack.sh logs gateway\n'
  fi
  if (( enable_telegram_profile )); then
    printf '  ./scripts/docker-stack.sh logs telegram\n'
  fi
  if (( enable_whatsapp_profile )); then
    printf '  ./scripts/docker-stack.sh logs whatsapp\n'
  fi
  if (( enable_discord_profile )); then
    printf '  ./scripts/docker-stack.sh logs discord\n'
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
  validate_disposable_environment_config
  ensure_host_dirs
  render_generated_public_caddyfile
  render_generated_compose
  if (( build_flag )); then
    build_stack_images
    run_compose up -d --no-build --remove-orphans
  else
    run_compose up -d --remove-orphans
  fi
  wait_for_core_health
  ensure_declared_agents
  bootstrap_wiki_if_configured
  print_up_summary
}

run_down() {
  render_generated_public_caddyfile
  render_generated_compose
  run_compose down --remove-orphans
}

run_ps() {
  render_generated_public_caddyfile
  render_generated_compose
  run_compose ps
}

run_logs() {
  local service_name
  render_generated_public_caddyfile
  render_generated_compose
  service_name="$(resolve_service_name "${1:-}")"
  if [[ -n "$service_name" ]]; then
    run_compose logs -f "$service_name"
    return
  fi

  run_compose logs -f
}

run_panda() {
  render_generated_public_caddyfile
  render_generated_compose
  run_compose exec -T panda-core panda "$@"
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
  panda)
    shift || true
    [[ $# -gt 0 ]] || die "panda requires arguments."
    run_panda "$@"
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
