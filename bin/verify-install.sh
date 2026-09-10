#!/usr/bin/env bash
# ==============================================================================
# agyloop - Installation & Plugin Verification
# ==============================================================================
# Validates symlink resolution, manifest schema integrity, commands, and subagents.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET_DIR="${HOME}/.gemini/config/plugins"
TARGET_LINK="${TARGET_DIR}/agyloop"
PLUGIN_MANIFEST="${TARGET_LINK}/plugin.json"

FAILED=0

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

echo "=== AgyLoop: Installation Verification ==="
echo ""

# 1. Check symlink existence
echo "1. Checking plugin symlink..."
if [[ -L "${TARGET_LINK}" ]]; then
  RESOLVED="$(resolve_path "${TARGET_LINK}" || true)"
  if [[ "${RESOLVED}" == "${REPO_ROOT}" ]]; then
    echo "   ✓ Symlink valid: ${TARGET_LINK} -> ${RESOLVED}"
  else
    echo "   ✗ Symlink exists but points to wrong destination: ${RESOLVED}"
    echo "     Expected: ${REPO_ROOT}"
    FAILED=1
  fi
else
  echo "   ✗ Symlink missing at ${TARGET_LINK}."
  echo "     Run './bin/setup-symlink.sh' to establish link."
  FAILED=1
fi

# 2. Check plugin.json readability through symlink
echo "2. Checking manifest resolution through symlink..."
if [[ -f "${PLUGIN_MANIFEST}" ]]; then
  echo "   ✓ Manifest found at: ${PLUGIN_MANIFEST}"
else
  echo "   ✗ plugin.json not found via symlink path (${PLUGIN_MANIFEST})."
  FAILED=1
fi

# 3. Check JSON validity with jq
echo "3. Validating JSON syntax..."
if command -v jq &>/dev/null; then
  if jq empty "${PLUGIN_MANIFEST}" 2>/dev/null; then
    echo "   ✓ Valid JSON syntax."
  else
    echo "   ✗ Invalid JSON syntax in ${PLUGIN_MANIFEST}."
    FAILED=1
  fi
else
  echo "   ! jq not installed; skipping JSON syntax test."
fi

# 4. Check core plugin fields
echo "4. Validating Plugin V2 metadata & contracts..."
if command -v jq &>/dev/null; then
  PLUGIN_NAME="$(jq -r '.name // empty' "${PLUGIN_MANIFEST}")"
  PLUGIN_VERSION="$(jq -r '.version // empty' "${PLUGIN_MANIFEST}")"
  HAS_COMMAND="$(jq -r '.commands.agyloop.name // empty' "${PLUGIN_MANIFEST}")"
  PLANNER_SUBAGENT="$(jq -r '.subagents.planner.name // empty' "${PLUGIN_MANIFEST}")"
  IMPLEMENTER_SUBAGENT="$(jq -r '.subagents.implementer.name // empty' "${PLUGIN_MANIFEST}")"
  GATE_SUBAGENT="$(jq -r '.subagents.gate.name // empty' "${PLUGIN_MANIFEST}")"
  REVIEWER_SUBAGENT="$(jq -r '.subagents.reviewer.name // empty' "${PLUGIN_MANIFEST}")"

  if [[ "${PLUGIN_NAME}" == "agyloop" ]]; then
    echo "   ✓ Plugin Name: ${PLUGIN_NAME}"
  else
    echo "   ✗ Unexpected or missing plugin name: '${PLUGIN_NAME}'"
    FAILED=1
  fi

  if [[ -n "${PLUGIN_VERSION}" ]]; then
    echo "   ✓ Plugin Version: ${PLUGIN_VERSION}"
  else
    echo "   ✗ Plugin version missing."
    FAILED=1
  fi

  if [[ "${HAS_COMMAND}" == "agyloop" ]]; then
    echo "   ✓ Command '/agyloop' declared."
  else
    echo "   ✗ Command '/agyloop' missing in manifest."
    FAILED=1
  fi

  if [[ -n "${PLANNER_SUBAGENT}" && -n "${IMPLEMENTER_SUBAGENT}" && -n "${GATE_SUBAGENT}" && -n "${REVIEWER_SUBAGENT}" ]]; then
    echo "   ✓ All 4 subagents declared (planner, implementer, gate, reviewer)."
  else
    echo "   ✗ One or more required subagents missing from manifest."
    FAILED=1
  fi
fi

# 5. Antigravity Environment Check
echo "5. Checking Antigravity runtime environment..."
if command -v agy &>/dev/null; then
  echo "   ✓ Antigravity CLI ('agy') detected in PATH."
else
  echo "   ! 'agy' CLI binary not found in PATH (normal if running standalone Antigravity IDE/App)."
fi

echo ""
echo "--------------------------------------------------"
if [[ "${FAILED}" -eq 0 ]]; then
  echo "🎉 Verification PASSED! AgyLoop plugin is properly installed."
  echo "You can now reload Antigravity or type '/agyloop' in your chat canvas."
  exit 0
else
  echo "❌ Verification FAILED! Review errors above and run './bin/setup-symlink.sh'."
  exit 1
fi
