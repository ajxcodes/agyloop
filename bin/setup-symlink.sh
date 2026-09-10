#!/usr/bin/env bash
# ==============================================================================
# agyloop - Antigravity Plugin Symlink Setup
# ==============================================================================
# Symlinks the current agyloop repository root into the global Antigravity
# plugins directory (~/.gemini/config/plugins/agyloop).
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET_DIR="${HOME}/.gemini/config/plugins"
TARGET_LINK="${TARGET_DIR}/agyloop"

resolve_path() {
  local target="$1"
  if command -v realpath &>/dev/null; then
    realpath "${target}"
  elif command -v greadlink &>/dev/null; then
    greadlink -f "${target}"
  else
    readlink -f "${target}" 2>/dev/null || readlink "${target}"
  fi
}

echo "=== AgyLoop: Plugin Symlink Setup ==="
echo "Source repository : ${REPO_ROOT}"
echo "Target symlink    : ${TARGET_LINK}"
echo ""

# Ensure manifest exists in repository
if [[ ! -f "${REPO_ROOT}/plugin.json" ]]; then
  echo "Error: plugin.json not found in ${REPO_ROOT}." >&2
  exit 1
fi

# Ensure parent directory exists
mkdir -p "${TARGET_DIR}"

# Check if target already exists
if [[ -L "${TARGET_LINK}" ]]; then
  CURRENT_DEST="$(resolve_path "${TARGET_LINK}" || true)"
  if [[ "${CURRENT_DEST}" == "${REPO_ROOT}" ]]; then
    echo "✓ Symlink already exists and points to this repository:"
    echo "  ${TARGET_LINK} -> ${CURRENT_DEST}"
    echo "Setup complete (idempotent)."
    exit 0
  else
    echo "Notice: Symlink exists but points to ${CURRENT_DEST}. Updating to ${REPO_ROOT}..."
    ln -sfn "${REPO_ROOT}" "${TARGET_LINK}"
  fi
elif [[ -e "${TARGET_LINK}" ]]; then
  echo "Warning: Target '${TARGET_LINK}' exists and is not a symlink." >&2
  BACKUP_PATH="${TARGET_LINK}.backup.$(date +%s)"
  echo "Backing up existing directory to ${BACKUP_PATH}..."
  mv "${TARGET_LINK}" "${BACKUP_PATH}"
  ln -sfn "${REPO_ROOT}" "${TARGET_LINK}"
else
  echo "Creating symlink: ${TARGET_LINK} -> ${REPO_ROOT}"
  ln -sfn "${REPO_ROOT}" "${TARGET_LINK}"
fi

# Verify resolution
RESOLVED="$(resolve_path "${TARGET_LINK}")"
if [[ "${RESOLVED}" == "${REPO_ROOT}" ]]; then
  echo "✓ Successfully symlinked agyloop plugin!"
  echo "  ${TARGET_LINK} -> ${RESOLVED}"
  echo ""
  echo "Run './bin/verify-install.sh' to validate plugin registration."
else
  echo "Error: Symlink created but does not resolve to ${REPO_ROOT}." >&2
  exit 1
fi
