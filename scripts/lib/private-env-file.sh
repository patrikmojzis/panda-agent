#!/usr/bin/env bash

# Guard secret-bearing env files before a script sources or forwards them.

private_file_mode() {
  local file=$1 mode
  if mode="$(stat -f '%Lp' "$file" 2>/dev/null)" && [[ "$mode" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$mode"
    return
  fi

  mode="$(stat -c '%a' "$file")" || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  printf '%s\n' "$mode"
}

private_file_mode_display() {
  local mode=$1 mode_value
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  mode_value=$((8#$mode))
  printf '%04o' "$mode_value"
}

require_owned_regular_file() {
  local file=$1 label=$2
  if [[ -L "$file" ]]; then
    printf 'error: refusing to use symlinked %s: %s\n' "$label" "$file" >&2
    return 1
  fi
  if [[ ! -f "$file" ]]; then
    printf 'error: %s not found or not a regular file: %s\n' "$label" "$file" >&2
    return 1
  fi
  if [[ ! -O "$file" ]]; then
    printf 'error: refusing to use %s owned by another user: %s\n' "$label" "$file" >&2
    return 1
  fi
}

require_private_env_file() {
  local file=$1 repair_command=${2:-} mode mode_value mode_display quoted_file
  require_owned_regular_file "$file" "env file" || return 1

  mode="$(private_file_mode "$file")" || {
    printf 'error: could not read env file permissions: %s\n' "$file" >&2
    return 1
  }
  mode_display="$(private_file_mode_display "$mode")" || {
    printf 'error: unsupported env file permission mode %s: %s\n' "$mode" "$file" >&2
    return 1
  }
  mode_value=$((8#$mode))
  if (( (mode_value & 077) == 0 )); then
    return 0
  fi

  printf -v quoted_file '%q' "$file"
  printf 'error: refusing to load secret-bearing env file: %s\n' "$file" >&2
  printf '  current mode: %s\n' "$mode_display" >&2
  printf '  required: owner-only (0600 or stricter)\n' >&2
  printf 'Fix it yourself:\n' >&2
  printf '  chmod 600 %s\n' "$quoted_file" >&2
  if [[ -n "$repair_command" ]]; then
    printf 'Or let Panda repair its managed paths:\n' >&2
    printf '  %s\n' "$repair_command" >&2
  fi
  printf 'Normal commands never change permissions on an env file you supplied.\n' >&2
  return 1
}

repair_private_env_file() {
  local file=$1
  require_owned_regular_file "$file" "env file" || return 1
  chmod u=rw,go= "$file" || {
    printf 'error: failed to set owner-only permissions on env file: %s\n' "$file" >&2
    return 1
  }
  require_private_env_file "$file" || return 1
  printf 'Secured env file (0600): %s\n' "$file"
}

ensure_private_managed_directory() {
  local directory=$1
  if [[ -L "$directory" ]]; then
    printf 'error: refusing to use symlinked Panda-managed directory: %s\n' "$directory" >&2
    return 1
  fi
  if [[ -e "$directory" && ! -d "$directory" ]]; then
    printf 'error: Panda-managed path is not a directory: %s\n' "$directory" >&2
    return 1
  fi

  mkdir -p "$directory" || return 1
  if [[ ! -O "$directory" ]]; then
    printf 'error: refusing to change Panda-managed directory owned by another user: %s\n' "$directory" >&2
    return 1
  fi
  chmod 700 "$directory" || return 1
}

secure_private_managed_file() {
  local file=$1 announce=${2:-1}
  [[ -e "$file" || -L "$file" ]] || return 0
  require_owned_regular_file "$file" "Panda-managed file" || return 1
  chmod 600 "$file" || return 1
  if (( announce )); then
    printf 'Secured Panda-managed file (0600): %s\n' "$file"
  fi
}

remove_obsolete_private_managed_file() {
  local file=$1
  [[ -e "$file" || -L "$file" ]] || return 0
  if [[ -L "$file" ]]; then
    rm -- "$file" || return 1
  else
    require_owned_regular_file "$file" "obsolete Panda-managed file" || return 1
    rm -- "$file" || return 1
  fi
  printf 'Removed obsolete Panda-managed secret copy: %s\n' "$file"
}
