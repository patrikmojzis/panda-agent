#!/usr/bin/env bash

set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage:
  ./scripts/run-docker-runner.sh <agentKey> [options]

Options:
  --port <port>               Host port to bind to the bash server (default: 8080)
  --publish-host <address>    Host address for the published runner port
                              (default: 127.0.0.1; public binding is explicit)
  --network <name>            Dedicated Docker network for this runner
                              (default: panda-runner-<agentKey>-net)
  --image <image>             Docker image to run (default: panda:latest)
  --shared-root <path>        Host path mounted as /workspace/shared
                              (default: $HOME/.panda/shared)
  --name <container-name>     Container name override
  --node-major <20|22|24>     Node major for --build bash-runner image (default: 22)
  --build                     Build the image from the repo root before running
  --detach                    Run the container in the background
  --dry-run                   Print the commands without executing them
  -h, --help                  Show this help

Examples:
  ./scripts/run-docker-runner.sh panda
  ./scripts/run-docker-runner.sh jozef --port 18080 --detach
  BASH_SERVER_AUTH_TOKEN_FILE=$HOME/.panda-runner-secrets/persistent/panda.token ./scripts/run-docker-runner.sh panda --build
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

print_command() {
  printf '+'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

expand_home() {
  local value=$1
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
  local value normalized
  value="$1"
  normalized="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  if [[ ! "$normalized" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    die "agentKey must use lowercase letters, numbers, hyphens, or underscores."
  fi

  printf '%s\n' "$normalized"
}

validate_node_major() {
  local value=$1
  case "$value" in
    20|22|24)
      ;;
    *)
      die "node major must be one of: 20, 22, 24."
      ;;
  esac
}

check_deprecated_bash_server_env() {
  local old_name new_name
  while [[ $# -gt 0 ]]; do
    old_name="$1"
    new_name="$2"
    if [[ -n "${!old_name+x}" ]]; then
      die "$old_name was renamed to $new_name; remove the old variable. BASH_SERVER_* is a hard cut with no RUNNER_* aliases."
    fi
    shift 2
  done
}

check_deprecated_bash_server_env \
  RUNNER_URL_TEMPLATE BASH_SERVER_URL_TEMPLATE \
  RUNNER_CWD_TEMPLATE BASH_SERVER_CWD_TEMPLATE \
  RUNNER_AGENT_KEY BASH_SERVER_AGENT_KEY \
  RUNNER_HOST BASH_SERVER_HOST \
  RUNNER_PORT BASH_SERVER_PORT \
  RUNNER_SHARED_SECRET BASH_SERVER_SHARED_SECRET \
  RUNNER_ALLOWED_ROOTS BASH_SERVER_ALLOWED_ROOTS \
  RUNNER_IMAGE BASH_SERVER_IMAGE \
  RUNNER_ENV_FILE BASH_SERVER_ENV_FILE

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
env_loader="$script_dir/lib/load-env-file.sh"
private_env_file_helper="$script_dir/lib/private-env-file.sh"
env_file="${BASH_SERVER_ENV_FILE:-$repo_root/.env}"

[[ -f "$private_env_file_helper" ]] || die "private env file helper not found: $private_env_file_helper"
# shellcheck source=/dev/null
source "$private_env_file_helper"
if [[ -f "$env_loader" && -f "$env_file" ]]; then
  env_file="$(cd "$(dirname "$env_file")" && pwd -P)/$(basename "$env_file")"
  require_private_env_file "$env_file" || exit "$?"
  # shellcheck source=/dev/null
  source "$env_loader"
  load_env_file "$env_file"
fi

check_deprecated_bash_server_env \
  RUNNER_URL_TEMPLATE BASH_SERVER_URL_TEMPLATE \
  RUNNER_CWD_TEMPLATE BASH_SERVER_CWD_TEMPLATE \
  RUNNER_AGENT_KEY BASH_SERVER_AGENT_KEY \
  RUNNER_HOST BASH_SERVER_HOST \
  RUNNER_PORT BASH_SERVER_PORT \
  RUNNER_SHARED_SECRET BASH_SERVER_SHARED_SECRET \
  RUNNER_ALLOWED_ROOTS BASH_SERVER_ALLOWED_ROOTS \
  RUNNER_IMAGE BASH_SERVER_IMAGE \
  RUNNER_ENV_FILE BASH_SERVER_ENV_FILE

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."

host_port="${BASH_SERVER_PORT:-8080}"
publish_host="${PANDA_RUNNER_PUBLISH_HOST:-127.0.0.1}"
image="${BASH_SERVER_IMAGE:-panda:latest}"
shared_root="${SHARED_ROOT:-$HOME/.panda/shared}"
runner_auth_token_host_file="${BASH_SERVER_AUTH_TOKEN_FILE:-}"
node_major="${PANDA_RUNNER_NODE_MAJOR:-22}"
node_major_set=0
detach=0
build=0
dry_run=0
container_name=""
network_name=""
agent_key=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --port)
      [[ $# -ge 2 ]] || die "--port requires a value."
      host_port="$2"
      shift 2
      ;;
    --publish-host)
      [[ $# -ge 2 ]] || die "--publish-host requires a value."
      publish_host="$2"
      shift 2
      ;;
    --network)
      [[ $# -ge 2 ]] || die "--network requires a value."
      network_name="$2"
      shift 2
      ;;
    --image)
      [[ $# -ge 2 ]] || die "--image requires a value."
      image="$2"
      shift 2
      ;;
    --shared-root)
      [[ $# -ge 2 ]] || die "--shared-root requires a value."
      shared_root="$2"
      shift 2
      ;;
    --name)
      [[ $# -ge 2 ]] || die "--name requires a value."
      container_name="$2"
      shift 2
      ;;
    --node-major)
      [[ $# -ge 2 ]] || die "--node-major requires a value."
      node_major="$2"
      node_major_set=1
      shift 2
      ;;
    --build)
      build=1
      shift
      ;;
    --detach)
      detach=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [[ -z "$agent_key" ]] || die "only one agentKey may be provided."
      agent_key="$1"
      shift
      ;;
  esac
done

[[ -n "$agent_key" ]] || die "agentKey is required."
agent_key="$(normalize_agent_key "$agent_key")"
[[ "$host_port" =~ ^[0-9]+$ ]] || die "port must be an integer."
(( host_port >= 1 && host_port <= 65535 )) || die "port must be between 1 and 65535."
if (( build || node_major_set )); then
  validate_node_major "$node_major"
fi

shared_root="$(expand_home "$shared_root")"
if [[ -n "${BASH_SERVER_AUTH_TOKEN:-}" ]]; then
  die "run-docker-runner.sh does not pass inline runner tokens through Docker metadata; use BASH_SERVER_AUTH_TOKEN_FILE."
fi
if [[ -n "$runner_auth_token_host_file" ]]; then
  runner_auth_token_host_file="$(expand_home "$runner_auth_token_host_file")"
  [[ "$runner_auth_token_host_file" == /* ]] || die "BASH_SERVER_AUTH_TOKEN_FILE must be an absolute path."
  require_owned_regular_file "$runner_auth_token_host_file" "runner auth token file" || exit "$?"
  runner_auth_token_mode="$(private_file_mode "$runner_auth_token_host_file")" \
    || die "could not read runner auth token file permissions: $runner_auth_token_host_file"
  runner_auth_token_mode_value=$((8#$runner_auth_token_mode))
  (( (runner_auth_token_mode_value & 077) == 0 )) \
    || die "runner auth token file must use owner-only permissions (0600 or stricter): $runner_auth_token_host_file"
elif [[ -z "${BASH_SERVER_SHARED_SECRET:-}" ]]; then
  die "runner authentication is required; set BASH_SERVER_AUTH_TOKEN_FILE (preferred). BASH_SERVER_SHARED_SECRET is migration-only."
fi
agent_dir="$HOME/.panda/agents/$agent_key"
runner_tz="${TZ:-UTC}"
default_container_name="panda-runner-$agent_key"
if [[ "$host_port" != "8080" ]]; then
  default_container_name="${default_container_name}-${host_port}"
fi
container_name="${container_name:-$default_container_name}"
network_name="${network_name:-panda-runner-${agent_key}-net}"

build_cmd=(env "DOCKER_BUILDKIT=${DOCKER_BUILDKIT:-1}" docker build --target bash-runner --build-arg "NODE_MAJOR=$node_major" -t "$image" "$repo_root")
run_cmd=(
  docker run --rm
  --name "$container_name"
  --network "$network_name"
  -p "${publish_host}:${host_port}:8080"
  -e "BASH_SERVER_AGENT_KEY=$agent_key"
  -e "TZ=$runner_tz"
  -v "$agent_dir:/root/.panda/agents/$agent_key"
  -v "$shared_root:/workspace/shared"
)

if [[ -n "$runner_auth_token_host_file" ]]; then
  run_cmd+=(
    -e "BASH_SERVER_AUTH_TOKEN_FILE=/run/secrets/panda-runner/token"
    -v "$runner_auth_token_host_file:/run/secrets/panda-runner/token:ro"
  )
fi
if [[ -z "$runner_auth_token_host_file" && -n "${BASH_SERVER_SHARED_SECRET:-}" ]]; then
  run_cmd+=(-e BASH_SERVER_SHARED_SECRET)
fi
if [[ -n "${BASH_SERVER_ALLOWED_ROOTS:-}" ]]; then
  run_cmd+=(-e "BASH_SERVER_ALLOWED_ROOTS=$BASH_SERVER_ALLOWED_ROOTS")
fi

if (( detach )); then
  run_cmd+=(-d)
fi

run_cmd+=("$image" bash-server)

printf 'Bash server config:\n'
printf '  agentKey: %s\n' "$agent_key"
printf '  image: %s\n' "$image"
printf '  container: %s\n' "$container_name"
printf '  published address: %s:%s\n' "$publish_host" "$host_port"
printf '  network: %s\n' "$network_name"
printf '  agent dir: %s\n' "$agent_dir"
printf '  shared root: %s\n' "$shared_root"
printf '  node major: %s%s\n' "$node_major" "$([[ $build -eq 1 ]] && printf ' (build)' || printf ' (not building)')"
printf '  timezone: %s\n' "$runner_tz"
printf '  runner auth: %s\n' "$([[ -n "$runner_auth_token_host_file" ]] && printf 'scoped token file' || printf 'legacy shared secret')"
printf '  allowed roots: %s\n' "${BASH_SERVER_ALLOWED_ROOTS:-not configured}"
printf '\n'
printf 'Local shell env for panda run:\n'
printf '  export BASH_EXECUTION_MODE=remote\n'
printf '  export BASH_SERVER_URL_TEMPLATE=http://127.0.0.1:%s/{agentKey}\n' "$host_port"
printf '\n'

if (( dry_run )); then
  mkdir_cmd=(mkdir -p "$agent_dir" "$shared_root")
  print_command "${mkdir_cmd[@]}"
  print_command docker network create "$network_name"
  if (( build )); then
    print_command "${build_cmd[@]}"
  fi
  print_command "${run_cmd[@]}"
  exit 0
fi

mkdir -p "$agent_dir" "$shared_root"

if ! docker network inspect "$network_name" >/dev/null 2>&1; then
  docker network create "$network_name" >/dev/null
fi

if (( build )); then
  print_command "${build_cmd[@]}"
  "${build_cmd[@]}"
fi

if docker container inspect "$container_name" >/dev/null 2>&1; then
  die "container $container_name already exists. Stop it first with: docker rm -f $container_name"
fi

print_command "${run_cmd[@]}"

if (( detach )); then
  container_id="$("${run_cmd[@]}")"
  printf 'Started container: %s\n' "$container_id"
  printf 'Health check: curl http://127.0.0.1:%s/health\n' "$host_port"
  exit 0
fi

exec "${run_cmd[@]}"
