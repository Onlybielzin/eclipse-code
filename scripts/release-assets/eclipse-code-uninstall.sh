#!/bin/sh

set -eu

INSTALL_ROOT="${ECLIPSE_CODE_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/eclipse-code}"
BIN_DIR="${ECLIPSE_CODE_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER_PATH="${BIN_DIR}/eclipse-code"
CLI_WRAPPER_MARKER="__ECLIPSE_CODE_CLI_WRAPPER__"
CLI_WRAPPER_OWNER_KEY="ECLIPSE_CODE_INSTALL_OWNER"
CLI_WRAPPER_OWNER_STANDALONE="standalone"

read_launcher_metadata() {
  key="$1"
  if [ ! -f "${LAUNCHER_PATH}" ]; then
    return 1
  fi

  awk -v key="${key}" '
    {
      line = $0
      sub(/^[[:space:]]*#[[:space:]]*/, "", line)
      prefix = key "="
      if (index(line, prefix) == 1) {
        print substr(line, length(prefix) + 1)
        exit
      }
    }
  ' "${LAUNCHER_PATH}"
}

is_standalone_launcher() {
  owner="$(read_launcher_metadata "${CLI_WRAPPER_OWNER_KEY}" || true)"
  if [ "${owner}" = "${CLI_WRAPPER_OWNER_STANDALONE}" ]; then
    return 0
  fi

  if [ -n "${owner}" ]; then
    return 1
  fi

  electron_bin="$(read_launcher_metadata "ECLIPSE_CODE_ELECTRON_BIN" || true)"
  case "${electron_bin}" in
    "${INSTALL_ROOT}"/*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -f "${LAUNCHER_PATH}" ]; then
  if ! grep -q "${CLI_WRAPPER_MARKER}" "${LAUNCHER_PATH}" 2>/dev/null; then
    printf "Refusing to remove existing non-Eclipse Code launcher at %s\n" "${LAUNCHER_PATH}" >&2
    exit 1
  fi

  if is_standalone_launcher; then
    rm -f "${LAUNCHER_PATH}"
    printf "Removed Eclipse Code CLI launcher at %s\n" "${LAUNCHER_PATH}"
  else
    printf "Leaving non-standalone Eclipse Code launcher at %s\n" "${LAUNCHER_PATH}"
  fi
fi

if [ -L "${INSTALL_ROOT}/current" ] || [ -e "${INSTALL_ROOT}/current" ]; then
  rm -rf "${INSTALL_ROOT}/current"
fi

for bundle_path in "${INSTALL_ROOT}"/eclipse-code-server-*; do
  if [ -e "${bundle_path}" ]; then
    rm -rf "${bundle_path}"
  fi
done

rmdir "${INSTALL_ROOT}" 2>/dev/null || true
printf "Removed Eclipse Code standalone runtime bundles from %s\n" "${INSTALL_ROOT}"
