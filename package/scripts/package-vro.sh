#!/usr/bin/env bash
# =============================================================================
# package-vro.sh — Build script for DFW Automation vRO package
# =============================================================================
# Creates a ZIP archive suitable for import into vRealize Orchestrator 8.x
# or Aria Automation Orchestrator.
#
# Usage:
#   ./package-vro.sh <version>
#   ./package-vro.sh 2.0.0
#
# Output:
#   dist/com.dfw.automation-<version>.zip
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PACKAGE_DIR="${SCRIPT_DIR}/../com.dfw.automation"
DIST_DIR="${REPO_ROOT}/dist"
MANIFEST="${PACKAGE_DIR}/package.json"

# Source-to-package action mapping
declare -A ACTION_SOURCE_MAP=(
  # com.dfw.shared
  ["com.dfw.shared/ConfigLoader"]="src/vro/actions/shared/ConfigLoader.js"
  ["com.dfw.shared/Logger"]="src/vro/actions/shared/Logger.js"
  ["com.dfw.shared/CorrelationContext"]="src/vro/actions/shared/CorrelationContext.js"
  ["com.dfw.shared/RetryHandler"]="src/vro/actions/shared/RetryHandler.js"
  ["com.dfw.shared/CircuitBreaker"]="src/vro/actions/shared/CircuitBreaker.js"
  ["com.dfw.shared/RestClient"]="src/vro/actions/shared/RestClient.js"
  ["com.dfw.shared/PayloadValidator"]="src/vro/actions/shared/PayloadValidator.js"
  ["com.dfw.shared/ErrorFactory"]="src/vro/actions/shared/ErrorFactory.js"
  ["com.dfw.shared/RateLimiter"]="src/vro/actions/shared/RateLimiter.js"

  # com.dfw.tags
  ["com.dfw.tags/TagOperations"]="src/vro/actions/tags/TagOperations.js"
  ["com.dfw.tags/TagCardinalityEnforcer"]="src/vro/actions/tags/TagCardinalityEnforcer.js"
  ["com.dfw.tags/TagPropagationVerifier"]="src/vro/actions/tags/TagPropagationVerifier.js"
  ["com.dfw.tags/UntaggedVMScanner"]="src/vro/actions/tags/UntaggedVMScanner.js"

  # com.dfw.groups
  ["com.dfw.groups/GroupMembershipVerifier"]="src/vro/actions/groups/GroupMembershipVerifier.js"
  ["com.dfw.groups/GroupReconciler"]="src/vro/actions/groups/GroupReconciler.js"

  # com.dfw.dfw
  ["com.dfw.dfw/DFWPolicyValidator"]="src/vro/actions/dfw/DFWPolicyValidator.js"
  ["com.dfw.dfw/PolicyDeployer"]="src/vro/actions/dfw/PolicyDeployer.js"
  ["com.dfw.dfw/RuleConflictDetector"]="src/vro/actions/dfw/RuleConflictDetector.js"
  ["com.dfw.dfw/RuleLifecycleManager"]="src/vro/actions/dfw/RuleLifecycleManager.js"
  ["com.dfw.dfw/RuleRegistry"]="src/vro/actions/dfw/RuleRegistry.js"
  ["com.dfw.dfw/RuleReviewScheduler"]="src/vro/actions/dfw/RuleReviewScheduler.js"

  # com.dfw.cmdb
  ["com.dfw.cmdb/CMDBValidator"]="src/vro/actions/cmdb/CMDBValidator.js"

  # com.dfw.lifecycle
  ["com.dfw.lifecycle/LifecycleOrchestrator"]="src/vro/actions/lifecycle/LifecycleOrchestrator.js"
  ["com.dfw.lifecycle/Day0Orchestrator"]="src/vro/actions/lifecycle/Day0Orchestrator.js"
  ["com.dfw.lifecycle/Day2Orchestrator"]="src/vro/actions/lifecycle/Day2Orchestrator.js"
  ["com.dfw.lifecycle/DayNOrchestrator"]="src/vro/actions/lifecycle/DayNOrchestrator.js"
  ["com.dfw.lifecycle/BulkTagOrchestrator"]="src/vro/actions/lifecycle/BulkTagOrchestrator.js"
  ["com.dfw.lifecycle/DriftDetectionWorkflow"]="src/vro/actions/lifecycle/DriftDetectionWorkflow.js"
  ["com.dfw.lifecycle/ImpactAnalysisAction"]="src/vro/actions/lifecycle/ImpactAnalysisAction.js"
  ["com.dfw.lifecycle/LegacyOnboardingOrchestrator"]="src/vro/actions/lifecycle/LegacyOnboardingOrchestrator.js"
  ["com.dfw.lifecycle/MigrationVerifier"]="src/vro/actions/lifecycle/MigrationVerifier.js"
  ["com.dfw.lifecycle/MigrationBulkTagger"]="src/vro/actions/lifecycle/MigrationBulkTagger.js"
  ["com.dfw.lifecycle/QuarantineOrchestrator"]="src/vro/actions/lifecycle/QuarantineOrchestrator.js"
  ["com.dfw.lifecycle/SagaCoordinator"]="src/vro/actions/lifecycle/SagaCoordinator.js"
  ["com.dfw.lifecycle/DeadLetterQueue"]="src/vro/actions/lifecycle/DeadLetterQueue.js"

  # com.dfw.adapters
  ["com.dfw.adapters/NsxApiAdapter"]="src/adapters/NsxApiAdapter.js"
  ["com.dfw.adapters/SnowPayloadAdapter"]="src/adapters/SnowPayloadAdapter.js"
  ["com.dfw.adapters/VcenterApiAdapter"]="src/adapters/VcenterApiAdapter.js"
)

# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

usage() {
  echo "Usage: $0 <version>"
  echo ""
  echo "Arguments:"
  echo "  version   Package version (e.g., 2.0.0)"
  echo ""
  echo "Examples:"
  echo "  $0 2.0.0"
  echo "  $0 2.1.0-rc1"
  exit 1
}

log_info() {
  echo "[INFO]  $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_error() {
  echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

log_success() {
  echo "[OK]    $(date '+%Y-%m-%d %H:%M:%S') $1"
}

validate_prerequisites() {
  if ! command -v zip &>/dev/null; then
    log_error "zip command not found. Install it with: apt-get install zip"
    exit 1
  fi

  if ! command -v jq &>/dev/null; then
    log_error "jq command not found. Install it with: apt-get install jq"
    exit 1
  fi

  if [ ! -f "${MANIFEST}" ]; then
    log_error "Package manifest not found: ${MANIFEST}"
    exit 1
  fi
}

copy_action_files() {
  local version="$1"
  local copied=0
  local failed=0

  log_info "Copying action files from src/ into package..."

  for action_key in "${!ACTION_SOURCE_MAP[@]}"; do
    local module_name="${action_key%%/*}"
    local action_name="${action_key##*/}"
    local source_file="${REPO_ROOT}/${ACTION_SOURCE_MAP[$action_key]}"
    local target_dir="${PACKAGE_DIR}/elements/actions/${module_name}"
    local target_file="${target_dir}/${action_name}.js"

    if [ ! -f "${source_file}" ]; then
      log_error "Source file missing: ${source_file} (action: ${action_key})"
      failed=$((failed + 1))
      continue
    fi

    mkdir -p "${target_dir}"
    cp "${source_file}" "${target_file}"
    copied=$((copied + 1))
  done

  log_info "Copied ${copied} action files, ${failed} failures"

  if [ "${failed}" -gt 0 ]; then
    log_error "Some source files are missing. Run validate-package.sh for details."
    return 1
  fi
}

update_manifest_version() {
  local version="$1"
  local tmp_manifest="${MANIFEST}.tmp"

  log_info "Updating package manifest version to ${version}..."

  jq --arg v "${version}" '.version = $v' "${MANIFEST}" > "${tmp_manifest}"
  mv "${tmp_manifest}" "${MANIFEST}"
}

create_zip() {
  local version="$1"
  local zip_name="com.dfw.automation-${version}.zip"
  local zip_path="${DIST_DIR}/${zip_name}"

  mkdir -p "${DIST_DIR}"

  log_info "Creating ZIP archive: ${zip_path}"

  cd "${PACKAGE_DIR}/.."
  zip -r "${zip_path}" "com.dfw.automation/" \
    -x "com.dfw.automation/elements/actions/*/README.md" \
    -x "com.dfw.automation/certificates/README.md"
  cd "${REPO_ROOT}"

  log_success "Package created: ${zip_path}"
  echo ""
  echo "Package details:"
  echo "  Name:    com.dfw.automation"
  echo "  Version: ${version}"
  echo "  File:    ${zip_path}"
  echo "  Size:    $(du -h "${zip_path}" | cut -f1)"
  echo ""
  echo "Import via:"
  echo "  1. vRO Client: Packages > Import Package > Select ${zip_name}"
  echo "  2. Aria Automation Assembler: Orchestrator > Packages > Import"
}

cleanup_copied_js() {
  log_info "Cleaning up copied JS files from package directory..."
  find "${PACKAGE_DIR}/elements/actions" -name "*.js" -type f -delete
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if [ $# -lt 1 ]; then
  usage
fi

VERSION="$1"

if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  log_error "Invalid version format: ${VERSION}"
  log_error "Expected format: MAJOR.MINOR.PATCH[-prerelease] (e.g., 2.0.0, 2.1.0-rc1)"
  exit 1
fi

log_info "Building DFW Automation vRO package v${VERSION}..."
echo ""

validate_prerequisites
copy_action_files "${VERSION}"
update_manifest_version "${VERSION}"
create_zip "${VERSION}"

# Clean up JS files (they live in src/, not in package/)
cleanup_copied_js

log_success "Build complete."
