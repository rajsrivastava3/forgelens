#!/usr/bin/env bash
# Starts TrueForge in local mode. ForgeLens hosts its MCP server on 127.0.0.1, and TrueForge's
# SSRF guard blocks loopback URLs unless they are allowlisted.
set -euo pipefail
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
exec npx --yes @truefoundry/trueforge@latest "$@"
