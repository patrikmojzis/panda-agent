#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/run-docker-runner.sh <agentKey> [options]

Options:
  --port <port>               Host port to bind to the runner (default: 8080)
  --image <image>             Docker image to run (default: panda:latest)
  --shared-root <path>        Host path mounted as /workspace/shared
                              (default: $HOME/.panda/shared)
  --name <container-name>     Container name override
  --build                     Build the image from the repo root before running
  --detach                    Run the container in the background
  --dry-run                   Print the commands without executing them
  -h, --help                  Show this help

Examples:
  ./scripts/run-docker-runner.sh panda
  ./scripts/run-docker-runner.sh jozef --port 18080 --detach
  ./scripts/run-docker-runner.sh panda --build
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

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"

host_port="${RUNNER_PORT:-8080}"
image="${RUNNER_IMAGE:-panda:latest}"
shared_root="${SHARED_ROOT:-$HOME/.panda/shared}"
detach=0
build=0
dry_run=0
container_name=""
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

shared_root="$(expand_home "$shared_root")"
agent_dir="$HOME/.panda/agents/$agent_key"
default_container_name="panda-runner-$agent_key"
if [[ "$host_port" != "8080" ]]; then
  default_container_name="${default_container_name}-${host_port}"
fi
container_name="${container_name:-$default_container_name}"

build_cmd=(docker build -t "$image" "$repo_root")
run_cmd=(
  docker run --rm
  --name "$container_name"
  -p "${host_port}:8080"
  -e "RUNNER_AGENT_KEY=$agent_key"
  -v "$agent_dir:/root/.panda/agents/$agent_key"
  -v "$shared_root:/workspace/shared"
)

if (( detach )); then
  run_cmd+=(-d)
fi

run_cmd+=("$image" runner)

printf 'Runner config:\n'
printf '  agentKey: %s\n' "$agent_key"
printf '  image: %s\n' "$image"
printf '  container: %s\n' "$container_name"
printf '  host port: %s\n' "$host_port"
printf '  agent dir: %s\n' "$agent_dir"
printf '  shared root: %s\n' "$shared_root"
printf '\n'
printf 'Local shell env for panda run:\n'
printf '  export BASH_EXECUTION_MODE=remote\n'
printf '  export RUNNER_URL_TEMPLATE=http://127.0.0.1:%s/{agentKey}\n' "$host_port"
printf '\n'

if (( dry_run )); then
  mkdir_cmd=(mkdir -p "$agent_dir" "$shared_root")
  print_command "${mkdir_cmd[@]}"
  if (( build )); then
    print_command "${build_cmd[@]}"
  fi
  print_command "${run_cmd[@]}"
  exit 0
fi

mkdir -p "$agent_dir" "$shared_root"

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
