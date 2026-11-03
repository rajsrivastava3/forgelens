# ForgeLens

A VS Code coding agent whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge).

> Nothing touches disk until a human accepts a hunk, and the agent always shows what it read and why.

**Starting point:** from scratch. **Licence:** MIT.

Status: early scaffold. Full setup steps arrive with the first usable release.

## Start TrueForge locally

ForgeLens hosts its MCP server on `127.0.0.1`, and TrueForge blocks loopback URLs by default, so
TrueForge has to start with an allowlist. These scripts set it:

```powershell
# PowerShell
.\scripts\start-trueforge.ps1
```

```bash
# Git Bash, Linux, macOS
./scripts/start-trueforge.sh
```

Then open <http://localhost:8790>. Requires Node 22.14 or newer.

The scripts pin TrueForge to **0.183.0**, the same version as `@truefoundry/trueforge-sdk` in
`package.json`. Change both together, and rerun `npm run spike` if you do. To start it by hand:

```powershell
# PowerShell: the quotes around the package name are required
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'; npx.cmd "@truefoundry/trueforge@0.183.0"
```

```bash
# bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@0.183.0
```
