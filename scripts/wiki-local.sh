#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/wiki-local.sh up
  ./scripts/wiki-local.sh down
  ./scripts/wiki-local.sh ps
  ./scripts/wiki-local.sh logs
  ./scripts/wiki-local.sh bootstrap [agentKey...]
  ./scripts/wiki-local.sh init [agentKey...]

Defaults:
  agent keys: all values from PANDA_AGENTS
  namespace: agents/<agentKey>

Required env for bootstrap:
  WIKI_ADMIN_EMAIL
  WIKI_ADMIN_PASSWORD
  DATABASE_URL
  CREDENTIALS_MASTER_KEY

Optional env:
  WIKI_IMAGE=ghcr.io/requarks/wiki:2
  WIKI_HOST_PORT=3100
  WIKI_SITE_URL=http://localhost:3100
  WIKI_SEARCH_DICT_LANGUAGE=simple
  WIKI_DB=postgresql://user:pass@host:5432/panda_wiki
  WIKI_DB_SSL_CERT_FILE=/path/to/ca.crt
  WIKI_DB_SSL_CA=<single-line certificate body>
  WIKI_DB_HOST=host.docker.internal
  WIKI_DB_PORT=5432
  WIKI_DB_NAME=panda_wiki
  WIKI_DB_USER=<current macOS user>
  WIKI_DB_PASS=
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
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

titleize_agent_key() {
  local value words word result=""
  value="$(printf '%s' "$1" | tr '_-' '  ')"
  # shellcheck disable=SC2206
  words=($value)
  for word in "${words[@]}"; do
    [[ -n "$word" ]] || continue
    result+="${result:+ }$(tr '[:lower:]' '[:upper:]' <<<"${word:0:1}")${word:1}"
  done
  printf '%s\n' "$result"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

persist_wiki_binding() {
  local agent_key=$1 group_id=$2 namespace=$3 token=$4

  [[ -n "$(trim "${DATABASE_URL:-}")" ]] || die "DATABASE_URL is required to store Panda wiki bindings."
  [[ -n "$(trim "${CREDENTIALS_MASTER_KEY:-}")" ]] || die "CREDENTIALS_MASTER_KEY is required to encrypt Panda wiki bindings."
  require_command pnpm

  (
    cd "$repo_root"
    printf '%s' "$token" | pnpm exec tsx src/app/cli.ts \
      wiki binding set "$agent_key" \
      --group-id "$group_id" \
      --namespace "$namespace" \
      --stdin
  )
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
env_file="${WIKI_ENV_FILE:-$repo_root/.env}"
compose_file="$repo_root/examples/docker-compose.wiki.yml"
generated_dir="$repo_root/.generated/wiki"
generated_compose="$generated_dir/docker-compose.wiki.ssl.yml"
docker_bin="${WIKI_DOCKER_BIN:-docker}"
project_name="${WIKI_PROJECT_NAME:-panda-wiki}"

[[ -f "$compose_file" ]] || die "compose file not found: $compose_file"
command -v "$docker_bin" >/dev/null 2>&1 || die "$docker_bin is not installed or not on PATH."
require_command curl
require_command jq

if [[ -f "$env_file" ]]; then
  # shellcheck source=/dev/null
  set -a
  source "$env_file"
  set +a
fi

export WIKI_IMAGE="${WIKI_IMAGE:-ghcr.io/requarks/wiki:2}"
export WIKI_HOST_PORT="${WIKI_HOST_PORT:-3100}"
export WIKI_SITE_URL="${WIKI_SITE_URL:-http://localhost:${WIKI_HOST_PORT}}"
export WIKI_SEARCH_DICT_LANGUAGE="${WIKI_SEARCH_DICT_LANGUAGE:-simple}"
export WIKI_DB_HOST="${WIKI_DB_HOST:-host.docker.internal}"
export WIKI_DB_PORT="${WIKI_DB_PORT:-5432}"
export WIKI_DB_NAME="${WIKI_DB_NAME:-panda_wiki}"
export WIKI_DB_USER="${WIKI_DB_USER:-$(id -un)}"
export WIKI_DB_PASS="${WIKI_DB_PASS:-}"

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

render_generated_compose() {
  mkdir -p "$generated_dir"

  if [[ -z "${WIKI_DB_SSL_CERT_FILE:-}" ]]; then
    cat > "$generated_compose" <<'EOF'
services: {}
EOF
    return 0
  fi

  cat > "$generated_compose" <<EOF
services:
  wiki:
    volumes:
      - ${WIKI_DB_SSL_CERT_FILE}:/etc/ssl/certs/panda-postgres-ca.crt:ro
EOF
}

export WIKI_DB_SSL_CERT_FILE="${WIKI_DB_SSL_CERT_FILE:-$(resolve_wiki_ssl_cert_file)}"
render_generated_compose

compose_args=(
  "$docker_bin" compose
  --project-name "$project_name"
  -f "$compose_file"
  -f "$generated_compose"
)

run_compose() {
  (
    cd "$repo_root"
    "${compose_args[@]}" "$@"
  )
}

graphql_request() {
  local payload=$1
  local auth_header=${2:-}

  if [[ -n "$auth_header" ]]; then
    curl -fsS \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $auth_header" \
      -d "$payload" \
      "$WIKI_SITE_URL/graphql"
  else
    curl -fsS \
      -H 'Content-Type: application/json' \
      -d "$payload" \
      "$WIKI_SITE_URL/graphql"
  fi
}

wait_for_http() {
  local url=$1
  local seconds=${2:-90}
  local start
  start="$(date +%s)"

  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi

    if (( "$(date +%s)" - start >= seconds )); then
      die "timed out waiting for $url"
    fi
    sleep 2
  done
}

wiki_needs_setup() {
  local body
  body="$(curl -fsS "$WIKI_SITE_URL" || true)"
  grep -q 'Wiki.js Setup' <<<"$body"
}

finalize_setup() {
  [[ -n "${WIKI_ADMIN_EMAIL:-}" ]] || die "WIKI_ADMIN_EMAIL is required for bootstrap"
  [[ -n "${WIKI_ADMIN_PASSWORD:-}" ]] || die "WIKI_ADMIN_PASSWORD is required for bootstrap"

  if ! wiki_needs_setup; then
    return 0
  fi

  local response
  response="$(
    curl -fsS \
      -H 'Content-Type: application/json' \
      -d "$(jq -n \
        --arg adminEmail "$WIKI_ADMIN_EMAIL" \
        --arg adminPassword "$WIKI_ADMIN_PASSWORD" \
        --arg siteUrl "$WIKI_SITE_URL" \
        '{adminEmail: $adminEmail, adminPassword: $adminPassword, adminPasswordConfirm: $adminPassword, siteUrl: $siteUrl, telemetry: false}')" \
      "$WIKI_SITE_URL/finalize"
  )"

  jq -e '.ok == true' >/dev/null <<<"$response" || die "wiki setup failed: $(jq -r '.error // "unknown error"' <<<"$response")"

  # Setup restarts the app internally. Wait for the normal app to come back.
  wait_for_http "$WIKI_SITE_URL/login" 120
}

login_jwt() {
  local payload response jwt graph_error
  payload="$(jq -n \
    --arg username "$WIKI_ADMIN_EMAIL" \
    --arg password "$WIKI_ADMIN_PASSWORD" \
    '{query: "mutation ($username: String!, $password: String!, $strategy: String!) { authentication { login(username: $username, password: $password, strategy: $strategy) { jwt responseResult { succeeded message } } } }", variables: {username: $username, password: $password, strategy: "local"}}')"
  response="$(graphql_request "$payload")"
  jwt="$(jq -r '.data.authentication.login.jwt // empty' <<<"$response")"
  if [[ -n "$jwt" ]]; then
    printf '%s\n' "$jwt"
    return 0
  fi
  graph_error="$(jq -r '.data.authentication.login.responseResult.message // .errors[0].message // "unknown error"' <<<"$response")"

  response="$(
    curl -fsS \
      -D - \
      -o /dev/null \
      --data-urlencode "user=$WIKI_ADMIN_EMAIL" \
      --data-urlencode "pass=$WIKI_ADMIN_PASSWORD" \
      --data-urlencode 'strategy=local' \
      "$WIKI_SITE_URL/login?legacy=1"
  )"
  jwt="$(awk 'BEGIN{IGNORECASE=1} /^Set-Cookie: jwt=/ {sub(/^Set-Cookie: jwt=/, "", $0); sub(/;.*/, "", $0); print; exit}' <<<"$response")"
  [[ -n "$jwt" ]] || die "wiki login failed: $graph_error (legacy login did not return a jwt cookie)"
  printf '%s\n' "$jwt"
}

enable_api() {
  local jwt=$1 payload response
  payload='{"query":"mutation { authentication { setApiState(enabled: true) { responseResult { succeeded message } } } }"}'
  response="$(graphql_request "$payload" "$jwt")"
  jq -e '.data.authentication.setApiState.responseResult.succeeded == true' >/dev/null <<<"$response" || die "failed to enable Wiki.js API"
}

configure_postgres_search() {
  local jwt=$1 engines_response engines_json payload response active_engine
  engines_response="$(graphql_request '{"query":"query { search { searchEngines { key isEnabled isAvailable config { key value } } } }"}' "$jwt")"
  jq -e '.data.search.searchEngines' >/dev/null <<<"$engines_response" || die "failed to query Wiki.js search engines"
  jq -e '.data.search.searchEngines[] | select(.key == "postgres" and .isAvailable == true)' >/dev/null <<<"$engines_response" \
    || die "Wiki.js postgres search engine is not available."

  engines_json="$(jq -c \
    --arg dictLanguage "$WIKI_SEARCH_DICT_LANGUAGE" \
    '
      .data.search.searchEngines
      | map(. as $engine | {
          key: $engine.key,
          isEnabled: ($engine.key == "postgres"),
          config: (($engine.config // []) | map({
            key,
            value: (
              if $engine.key == "postgres" and .key == "dictLanguage" then
                ({v: $dictLanguage} | tojson)
              else
                ({v: (try (.value | fromjson | .value) catch null)} | tojson)
              end
            )
          }))
        })
    ' <<<"$engines_response")"

  payload="$(jq -n \
    --argjson engines "$engines_json" \
    '{query: "mutation ($engines: [SearchEngineInput]) { search { updateSearchEngines(engines: $engines) { responseResult { succeeded message } } } }", variables: {engines: $engines}}')"
  response="$(graphql_request "$payload" "$jwt")"
  jq -e '.data.search.updateSearchEngines.responseResult.succeeded == true' >/dev/null <<<"$response" \
    || die "failed to switch Wiki.js search engine: $(jq -r '.data.search.updateSearchEngines.responseResult.message // .errors[0].message // "unknown error"' <<<"$response")"

  response="$(graphql_request '{"query":"query { search { searchEngines { key isEnabled } } }"}' "$jwt")"
  active_engine="$(jq -r '.data.search.searchEngines[] | select(.isEnabled == true) | .key' <<<"$response")"
  [[ "$active_engine" == "postgres" ]] || die "Wiki.js search engine switch did not stick (active=$active_engine)."

  response="$(graphql_request '{"query":"mutation { search { rebuildIndex { responseResult { succeeded message } } } }"}' "$jwt")"
  jq -e '.data.search.rebuildIndex.responseResult.succeeded == true' >/dev/null <<<"$response" \
    || die "failed to rebuild Wiki.js search index: $(jq -r '.data.search.rebuildIndex.responseResult.message // .errors[0].message // "unknown error"' <<<"$response")"
}

query_group_id() {
  local jwt=$1 group_name=$2 payload response
  payload="$(jq -n \
    --arg groupName "$group_name" \
    '{query: "query { groups { list { id name } } }", variables: {groupName: $groupName}}')"
  response="$(graphql_request "$payload" "$jwt")"
  jq -r --arg groupName "$group_name" '.data.groups.list[] | select(.name == $groupName) | .id' <<<"$response" | head -n1
}

create_group() {
  local jwt=$1 group_name=$2 payload response
  payload="$(jq -n \
    --arg groupName "$group_name" \
    '{query: "mutation ($name: String!) { groups { create(name: $name) { responseResult { succeeded message } group { id name } } } }", variables: {name: $groupName}}')"
  response="$(graphql_request "$payload" "$jwt")"
  jq -e '.data.groups.create.responseResult.succeeded == true' >/dev/null <<<"$response" || die "failed to create group: $(jq -r '.data.groups.create.responseResult.message // .errors[0].message // "unknown error"' <<<"$response")"
  jq -r '.data.groups.create.group.id' <<<"$response"
}

update_group() {
  local jwt=$1 group_id=$2 group_name=$3 namespace=$4
  local payload response

  payload="$(jq -n \
    --argjson id "$group_id" \
    --arg name "$group_name" \
    --arg namespace "$namespace" \
    '{
      query: "mutation ($id: Int!, $name: String!, $redirectOnLogin: String!, $permissions: [String]!, $pageRules: [PageRuleInput]!) { groups { update(id: $id, name: $name, redirectOnLogin: $redirectOnLogin, permissions: $permissions, pageRules: $pageRules) { responseResult { succeeded message } } } }",
      variables: {
        id: $id,
        name: $name,
        redirectOnLogin: "/",
        permissions: [
          "read:pages",
          "write:pages",
          "manage:pages",
          "delete:pages",
          "read:source",
          "read:history"
        ],
        pageRules: [
          {
            id: "allow-agent-namespace",
            deny: false,
            match: "START",
            roles: [
              "read:pages",
              "write:pages",
              "manage:pages",
              "delete:pages",
              "read:source",
              "read:history"
            ],
            path: $namespace,
            locales: []
          }
        ]
      }
    }')"

  response="$(graphql_request "$payload" "$jwt")"
  jq -e '.data.groups.update.responseResult.succeeded == true' >/dev/null <<<"$response" || die "failed to update group: $(jq -r '.data.groups.update.responseResult.message // .errors[0].message // "unknown error"' <<<"$response")"
}

revoke_keys_named() {
  local jwt=$1 key_name=$2 payload response ids id
  payload='{"query":"query { authentication { apiKeys { id name isRevoked } } }"}'
  response="$(graphql_request "$payload" "$jwt")"
  ids="$(jq -r --arg keyName "$key_name" '.data.authentication.apiKeys[] | select(.name == $keyName and .isRevoked == false) | .id' <<<"$response")"

  if [[ -z "$ids" ]]; then
    return 0
  fi

  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    response="$(graphql_request "{\"query\":\"mutation (\$id: Int!) { authentication { revokeApiKey(id: \$id) { responseResult { succeeded message } } } }\",\"variables\":{\"id\":$id}}" "$jwt")"
    jq -e '.data.authentication.revokeApiKey.responseResult.succeeded == true' >/dev/null <<<"$response" || die "failed to revoke existing api key id=$id"
  done <<<"$ids"
}

create_group_token() {
  local jwt=$1 group_id=$2 key_name=$3 payload response
  payload="$(jq -n \
    --arg name "$key_name" \
    --argjson group "$group_id" \
    '{query: "mutation ($name: String!, $expiration: String!, $fullAccess: Boolean!, $group: Int) { authentication { createApiKey(name: $name, expiration: $expiration, fullAccess: $fullAccess, group: $group) { key responseResult { succeeded message } } } }", variables: {name: $name, expiration: "1y", fullAccess: false, group: $group}}')"
  response="$(graphql_request "$payload" "$jwt")"
  jq -e '.data.authentication.createApiKey.responseResult.succeeded == true' >/dev/null <<<"$response" || die "failed to create group token: $(jq -r '.data.authentication.createApiKey.responseResult.message // .errors[0].message // "unknown error"' <<<"$response")"
  jq -r '.data.authentication.createApiKey.key' <<<"$response"
}

resolve_bootstrap_agents() {
  if (( $# > 0 )); then
    while [[ $# -gt 0 ]]; do
      normalize_agent_key "$1"
      shift
    done
    return 0
  fi

  if ((${#normalized_agents[@]} == 0)); then
    die "No agent keys provided and PANDA_AGENTS is empty."
  fi

  printf '%s\n' "${normalized_agents[@]}"
}

bootstrap_one() {
  local jwt=$1
  local agent_key=$2
  local namespace="agents/${agent_key}"
  local group_name
  local key_name
  local group_id
  local token

  group_name="$(titleize_agent_key "$agent_key") Agent"
  key_name="${agent_key}-agent-local"

  group_id="$(query_group_id "$jwt" "$group_name")"
  if [[ -z "$group_id" ]]; then
    group_id="$(create_group "$jwt" "$group_name")"
  fi
  update_group "$jwt" "$group_id" "$group_name" "$namespace"

  revoke_keys_named "$jwt" "$key_name"
  token="$(create_group_token "$jwt" "$group_id" "$key_name")"
  persist_wiki_binding "$agent_key" "$group_id" "$namespace" "$token"
}

bootstrap() {
  local jwt
  local -a agents_to_bootstrap=()
  local agent_key
  while IFS= read -r agent_key; do
    [[ -n "$agent_key" ]] || continue
    agents_to_bootstrap+=("$agent_key")
  done < <(resolve_bootstrap_agents "$@")

  wait_for_http "$WIKI_SITE_URL" 120
  finalize_setup
  jwt="$(login_jwt)"
  enable_api "$jwt"
  configure_postgres_search "$jwt"

  for agent_key in "${agents_to_bootstrap[@]}"; do
    bootstrap_one "$jwt" "$agent_key"
  done
}

cmd="${1:-}"
case "$cmd" in
  up)
    run_compose up -d
    ;;
  down)
    run_compose down
    ;;
  ps)
    run_compose ps
    ;;
  logs)
    run_compose logs -f wiki
    ;;
  bootstrap)
    shift || true
    bootstrap "$@"
    ;;
  init)
    run_compose up -d
    shift || true
    bootstrap "$@"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    usage
    die "unknown command: $cmd"
    ;;
esac
