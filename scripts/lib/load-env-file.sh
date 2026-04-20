#!/usr/bin/env bash

trim_env_loader() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

load_env_file() {
  local file=$1
  local line key value

  [[ -f "$file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"

    if [[ -z "$(trim_env_loader "$line")" ]]; then
      continue
    fi
    if [[ "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi

    if [[ "$line" =~ ^[[:space:]]*export[[:space:]]+ ]]; then
      line="${line#export}"
      line="$(trim_env_loader "$line")"
    fi

    if [[ "$line" != *=* ]]; then
      continue
    fi

    key="$(trim_env_loader "${line%%=*}")"
    value="${line#*=}"

    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      continue
    fi

    case "$value" in
      \"*\")
        value="${value:1:${#value}-2}"
        ;;
      \'*\')
        value="${value:1:${#value}-2}"
        ;;
    esac

    export "$key=$value"
  done < "$file"
}
