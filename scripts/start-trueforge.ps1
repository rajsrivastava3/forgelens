# Starts TrueForge in local mode. ForgeLens hosts its MCP server on 127.0.0.1, and TrueForge's
# SSRF guard blocks loopback URLs unless they are allowlisted.
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'

# On Windows, call npx.cmd: npm's npx.ps1 shim re-runs its own invocation line in another scope,
# where @args is empty, so arguments such as --port would be lost.
$npx = if ($env:OS -eq 'Windows_NT') { 'npx.cmd' } else { 'npx' }

# The quotes matter: an unquoted leading @ is PowerShell splatting.
& $npx --yes "@truefoundry/trueforge@latest" @args
