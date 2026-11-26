# DV Open Tools — Local Dev Servers & Auth Proxies

Run any of the three equivalent local proxies in this folder to connect **DV Open Tools** (`dvot_host.html` or GitHub Pages) to a live Dataverse environment without storing credentials or tokens in the browser.

All three options implement the exact same protocol on `http://127.0.0.1:8787`:
- Serves workspace HTML files & `tools/dvot_*.html` (`Cache-Control: no-store`)
- Acquires OAuth Bearer tokens server-side (`pac auth token`, `az account get-access-token`, or `DV_TOKEN`)
- Exposes `GET /_proxy/status` and `/api/data/*` with CORS + Private Network Access headers
- Merges un-uploaded local tools into `/api/data/*/webresourceset`

## 1. Windows PowerShell (`dev-server.ps1`) — Zero Installs Required
Works out of the box with Windows PowerShell 5.1+ or PowerShell 7 (`pwsh`):
```powershell
.\dev-server\dev-server.ps1 -Env https://yourorg.crm.dynamics.com
```
*(If your machine enforces script signing, run `Unblock-File .\dev-server\dev-server.ps1` or pass `-ExecutionPolicy Bypass`.)*

## 2. C# / .NET (`DvOpenTools.Proxy.csproj`) — Native for C# Devs
Requires [.NET 8 SDK+](https://dotnet.microsoft.com/download) with zero external NuGet dependencies:
```powershell
dotnet run --project dev-server -- --env https://yourorg.crm.dynamics.com
```

## 3. Node.js (`dev-server.js`)
Requires Node.js 18+ with zero npm dependencies:
```bash
node dev-server/dev-server.js --env https://yourorg.crm.dynamics.com
```

## Common Flags
| Flag (`.cs` / `.js`) | PowerShell Parameter | Description |
|---|---|---|
| `--env <url>` | `-Env <url>` | Target Dataverse org URL (auto-detected via `pac org who` if omitted) |
| `--port <num>` | `-Port <num>` | Local HTTP port (default `8787`) |
| `--auth auto\|pac\|az\|env` | `-Auth auto\|pac\|az\|env` | Bearer token source |
| `--local-only` | `-LocalOnly` | Serve local HTML tools without proxying Dataverse APIs |
| `--build-manifest` | `-BuildManifest` | Regenerate `tools/manifest.json` from `tools/dvot_*.html` |
| `--build-bundle [path]` | `-BuildBundle [-BundleOut path]` | Bundle all tools (without host) into one HTML pack (default `dist/dvot_bundle_all.html`) |
