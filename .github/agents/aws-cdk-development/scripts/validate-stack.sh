#!/bin/bash

# AWS CDK Stack Validation Script — swim-meet
#
# Performs meta-level validation of CDK stacks before deployment.
# Run as part of pre-commit checks to ensure infrastructure quality.
#
# Focus areas:
# - CDK synthesis success (includes cdk-nag AwsSolutionsChecks)
# - CloudFormation template size and resource count checks
# - Integration with cdk-nag (applied at app level via Aspects)
#
# Usage:
#   .github/agents/aws-cdk-development/scripts/validate-stack.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

echo "🔍 AWS CDK Stack Validation — swim-meet"
echo "========================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

VALIDATION_PASSED=true

success() { echo -e "${GREEN}✓${NC} $1"; }
error()   { echo -e "${RED}✗${NC} $1"; VALIDATION_PASSED=false; }
warning() { echo -e "${YELLOW}⚠${NC} $1"; }
info()    { echo "ℹ $1"; }

# ── Prerequisites ─────────────────────────────────────────────────────────────

if ! command -v cdk &> /dev/null; then
  error "AWS CDK CLI not found. Install with: npm install -g aws-cdk"
  exit 1
fi
success "AWS CDK CLI found ($(cdk --version))"

if ! command -v pnpm &> /dev/null; then
  error "pnpm not found. Install with: npm install -g pnpm@10"
  exit 1
fi
success "pnpm found"

# ── Type check ────────────────────────────────────────────────────────────────

echo ""
info "Running TypeScript type check..."
if pnpm exec tsc --noEmit --project "${PROJECT_ROOT}/tsconfig.json" > /dev/null 2>&1; then
  success "TypeScript type check passed"
else
  error "TypeScript type check failed"
  echo ""
  echo "Run 'pnpm exec tsc --noEmit' for detailed error information"
  exit 1
fi

# ── cdk-nag check ─────────────────────────────────────────────────────────────

echo ""
info "Checking cdk-nag integration..."
if grep -q "cdk-nag" "${PROJECT_ROOT}/package.json" 2>/dev/null; then
  success "cdk-nag found in package.json"
else
  warning "cdk-nag not found — recommended for comprehensive CDK validation"
  warning "Install with: pnpm add --save-dev cdk-nag"
fi

# ── CDK Synthesis ─────────────────────────────────────────────────────────────

echo ""
info "Running CDK synthesis (includes cdk-nag checks)..."
CDK_SYNTH_OUTPUT=$(cdk synth --quiet 2>&1) || CDK_SYNTH_EXIT=$?

if [ "${CDK_SYNTH_EXIT:-0}" -ne 0 ]; then
  error "CDK synthesis failed"
  echo ""
  echo "${CDK_SYNTH_OUTPUT}"
  echo ""
  echo "Run 'cdk synth' for detailed error information"
  exit 1
fi
success "CDK synthesis successful (cdk-nag checks passed)"

# ── Template analysis ─────────────────────────────────────────────────────────

echo ""
info "Checking synthesised templates..."

TEMPLATES=()
while IFS= read -r -d '' file; do
  TEMPLATES+=("$file")
done < <(find "${PROJECT_ROOT}/cdk.out" -name "*.template.json" -print0 2>/dev/null)

if [ ${#TEMPLATES[@]} -eq 0 ]; then
  error "No CloudFormation templates found in cdk.out/"
  exit 1
fi

success "Found ${#TEMPLATES[@]} CloudFormation template(s)"

for template in "${TEMPLATES[@]}"; do
  STACK_NAME="$(basename "$template" .template.json)"

  TEMPLATE_SIZE="$(wc -c < "$template")"
  MAX_SIZE=51200 # 50 KB warning threshold
  if [ "$TEMPLATE_SIZE" -gt "$MAX_SIZE" ]; then
    warning "${STACK_NAME}: Template size (${TEMPLATE_SIZE} bytes) is large — consider nested stacks"
  fi

  if command -v jq &> /dev/null; then
    RESOURCE_COUNT="$(jq '.Resources | length' "$template" 2>/dev/null || echo 0)"
    if [ "$RESOURCE_COUNT" -gt 200 ]; then
      warning "${STACK_NAME}: High resource count (${RESOURCE_COUNT}) — consider splitting into multiple stacks"
    else
      success "${STACK_NAME}: ${RESOURCE_COUNT} resources"
    fi
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "========================================"

if [ "$VALIDATION_PASSED" = true ]; then
  echo -e "${GREEN}✓ Validation passed${NC}"
  echo ""
  info "Stack is ready for deployment"
  exit 0
else
  echo -e "${RED}✗ Validation failed${NC}"
  echo ""
  error "Please fix the errors above before deploying"
  exit 1
fi
