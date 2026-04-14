#!/usr/bin/env bash
# =============================================================================
# validate-package.sh — Validates the DFW Automation vRO package
# =============================================================================
# Checks that all referenced action source files exist, the package manifest
# is valid JSON, and all workflow XMLs are well-formed.
#
# Usage:
#   ./validate-package.sh
#
# Exit codes:
#   0 — All checks passed
#   1 — One or more checks failed
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PACKAGE_DIR="${SCRIPT_DIR}/../com.dfw.automation"
MANIFEST="${PACKAGE_DIR}/package.json"
WORKFLOW_DIR="${PACKAGE_DIR}/elements/workflows"
CONFIG_DIR="${PACKAGE_DIR}/elements/config"

ERRORS=0
WARNINGS=0
CHECKS=0

# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

log_info() {
  echo "[INFO]    $1"
}

log_pass() {
  echo "[PASS]    $1"
  CHECKS=$((CHECKS + 1))
}

log_fail() {
  echo "[FAIL]    $1"
  ERRORS=$((ERRORS + 1))
  CHECKS=$((CHECKS + 1))
}

log_warn() {
  echo "[WARN]    $1"
  WARNINGS=$((WARNINGS + 1))
}

separator() {
  echo ""
  echo "--- $1 ---"
  echo ""
}

# ---------------------------------------------------------------------------
# Check 1: Package manifest is valid JSON
# ---------------------------------------------------------------------------
check_manifest() {
  separator "Package Manifest Validation"

  if [ ! -f "${MANIFEST}" ]; then
    log_fail "Package manifest not found: ${MANIFEST}"
    return
  fi

  log_pass "Package manifest exists: ${MANIFEST}"

  # Validate JSON syntax
  if jq empty "${MANIFEST}" 2>/dev/null; then
    log_pass "Package manifest is valid JSON"
  else
    log_fail "Package manifest is not valid JSON"
    return
  fi

  # Check required fields
  local required_fields=("name" "displayName" "version" "description" "vendor" "platform" "actions")
  for field in "${required_fields[@]}"; do
    local value
    value=$(jq -r ".${field}" "${MANIFEST}" 2>/dev/null)
    if [ "${value}" = "null" ] || [ -z "${value}" ]; then
      log_fail "Missing required field in manifest: ${field}"
    else
      log_pass "Manifest field present: ${field}"
    fi
  done

  # Validate platform versions
  local vro_version
  vro_version=$(jq -r '.platform.vro' "${MANIFEST}" 2>/dev/null)
  if [ "${vro_version}" != "null" ] && [ -n "${vro_version}" ]; then
    log_pass "Platform vRO version specified: ${vro_version}"
  else
    log_fail "Missing platform.vro version"
  fi
}

# ---------------------------------------------------------------------------
# Check 2: All referenced action files exist in src/
# ---------------------------------------------------------------------------
check_action_sources() {
  separator "Action Source File Validation"

  if [ ! -f "${MANIFEST}" ]; then
    log_fail "Cannot check action sources: manifest missing"
    return
  fi

  # Source directory mapping: module -> source directory
  declare -A MODULE_SRC_MAP=(
    ["com.dfw.shared"]="src/vro/actions/shared"
    ["com.dfw.tags"]="src/vro/actions/tags"
    ["com.dfw.groups"]="src/vro/actions/groups"
    ["com.dfw.dfw"]="src/vro/actions/dfw"
    ["com.dfw.cmdb"]="src/vro/actions/cmdb"
    ["com.dfw.lifecycle"]="src/vro/actions/lifecycle"
    ["com.dfw.adapters"]="src/adapters"
  )

  local total_actions=0
  local found_actions=0
  local missing_actions=0

  # Parse each module's actions from the manifest
  for module in $(jq -r '.actions | keys[]' "${MANIFEST}" 2>/dev/null); do
    local src_dir="${MODULE_SRC_MAP[$module]:-}"

    if [ -z "${src_dir}" ]; then
      log_warn "No source directory mapping for module: ${module}"
      continue
    fi

    for action in $(jq -r ".actions[\"${module}\"][]" "${MANIFEST}" 2>/dev/null); do
      total_actions=$((total_actions + 1))
      local source_file="${REPO_ROOT}/${src_dir}/${action}.js"

      if [ -f "${source_file}" ]; then
        log_pass "Source exists: ${module}/${action} -> ${src_dir}/${action}.js"
        found_actions=$((found_actions + 1))
      else
        log_fail "Source MISSING: ${module}/${action} -> ${src_dir}/${action}.js"
        missing_actions=$((missing_actions + 1))
      fi
    done
  done

  echo ""
  log_info "Action summary: ${found_actions}/${total_actions} found, ${missing_actions} missing"
}

# ---------------------------------------------------------------------------
# Check 3: Workflow XML files are well-formed
# ---------------------------------------------------------------------------
check_workflows() {
  separator "Workflow XML Validation"

  if [ ! -d "${WORKFLOW_DIR}" ]; then
    log_fail "Workflow directory not found: ${WORKFLOW_DIR}"
    return
  fi

  local xml_count=0
  local valid_count=0

  for xml_file in "${WORKFLOW_DIR}"/*.xml; do
    if [ ! -f "${xml_file}" ]; then
      log_warn "No XML files found in ${WORKFLOW_DIR}"
      break
    fi

    xml_count=$((xml_count + 1))
    local filename
    filename=$(basename "${xml_file}")

    # Check well-formedness using xmllint if available, otherwise basic checks
    if command -v xmllint &>/dev/null; then
      if xmllint --noout "${xml_file}" 2>/dev/null; then
        log_pass "Well-formed XML: ${filename}"
        valid_count=$((valid_count + 1))
      else
        log_fail "Malformed XML: ${filename}"
      fi
    else
      # Fallback: basic checks without xmllint
      if head -1 "${xml_file}" | grep -q '<?xml'; then
        log_pass "XML declaration present: ${filename}"
        valid_count=$((valid_count + 1))
      else
        log_fail "Missing XML declaration: ${filename}"
      fi
    fi

    # Check for required elements
    if grep -q '<display-name>' "${xml_file}"; then
      log_pass "Display name present: ${filename}"
    else
      log_fail "Missing display-name element: ${filename}"
    fi

    if grep -q '<description>' "${xml_file}"; then
      log_pass "Description present: ${filename}"
    else
      log_warn "Missing description element: ${filename}"
    fi
  done

  echo ""
  log_info "Workflow summary: ${valid_count}/${xml_count} valid XML files"
}

# ---------------------------------------------------------------------------
# Check 4: Config files are present and valid
# ---------------------------------------------------------------------------
check_config() {
  separator "Configuration File Validation"

  # Check properties file
  local props_file="${CONFIG_DIR}/dfw-config.properties"
  if [ -f "${props_file}" ]; then
    log_pass "Properties file exists: dfw-config.properties"

    # Check for vault references (should NOT contain plain-text passwords)
    if grep -qE 'password=\{\{vault:' "${props_file}"; then
      log_pass "Passwords use vault references (no plain-text credentials)"
    else
      log_warn "Could not verify vault reference pattern for passwords"
    fi
  else
    log_fail "Properties file missing: ${props_file}"
  fi

  # Check site config JSON
  local site_config="${CONFIG_DIR}/site-config.json"
  if [ -f "${site_config}" ]; then
    log_pass "Site config file exists: site-config.json"

    if jq empty "${site_config}" 2>/dev/null; then
      log_pass "Site config is valid JSON"
    else
      log_fail "Site config is not valid JSON"
    fi
  else
    log_fail "Site config file missing: ${site_config}"
  fi
}

# ---------------------------------------------------------------------------
# Check 5: ServiceNow artifacts
# ---------------------------------------------------------------------------
check_servicenow() {
  separator "ServiceNow Artifact Validation"

  local snow_dir="${SCRIPT_DIR}/../servicenow"

  # Check catalog items
  local catalog_dir="${snow_dir}/catalog-items"
  local expected_catalogs=("vm-build-request.json" "tag-update-request.json" "bulk-tag-request.json" "quarantine-request.json" "rule-request.json")

  for catalog in "${expected_catalogs[@]}"; do
    local catalog_file="${catalog_dir}/${catalog}"
    if [ -f "${catalog_file}" ]; then
      if jq empty "${catalog_file}" 2>/dev/null; then
        log_pass "Valid catalog item: ${catalog}"
      else
        log_fail "Invalid JSON in catalog item: ${catalog}"
      fi
    else
      log_fail "Missing catalog item: ${catalog}"
    fi
  done

  # Check scheduled jobs
  local jobs_dir="${snow_dir}/scheduled-jobs"
  local expected_jobs=("cmdb-validation-weekly.json" "drift-scan-daily.json" "rule-review-weekly.json")

  for job in "${expected_jobs[@]}"; do
    local job_file="${jobs_dir}/${job}"
    if [ -f "${job_file}" ]; then
      if jq empty "${job_file}" 2>/dev/null; then
        log_pass "Valid scheduled job: ${job}"
      else
        log_fail "Invalid JSON in scheduled job: ${job}"
      fi
    else
      log_fail "Missing scheduled job: ${job}"
    fi
  done

  # Check custom table
  local table_file="${snow_dir}/custom-tables/x_dfw_rule_registry.json"
  if [ -f "${table_file}" ]; then
    if jq empty "${table_file}" 2>/dev/null; then
      log_pass "Valid custom table definition: x_dfw_rule_registry.json"
    else
      log_fail "Invalid JSON in custom table: x_dfw_rule_registry.json"
    fi
  else
    log_fail "Missing custom table definition: x_dfw_rule_registry.json"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "============================================================"
echo "DFW Automation Package Validation"
echo "============================================================"
echo ""
echo "Repository root: ${REPO_ROOT}"
echo "Package directory: ${PACKAGE_DIR}"
echo ""

check_manifest
check_action_sources
check_workflows
check_config
check_servicenow

echo ""
echo "============================================================"
echo "Validation Summary"
echo "============================================================"
echo ""
echo "  Total checks: ${CHECKS}"
echo "  Passed:       $((CHECKS - ERRORS))"
echo "  Failed:       ${ERRORS}"
echo "  Warnings:     ${WARNINGS}"
echo ""

if [ "${ERRORS}" -gt 0 ]; then
  echo "RESULT: FAILED (${ERRORS} errors)"
  exit 1
else
  echo "RESULT: PASSED"
  exit 0
fi
