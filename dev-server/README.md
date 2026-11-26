# DV Open Tools — Local Dev Servers & Auth Proxies

Run any of the three equivalent local proxies in this folder to connect **DV Open Tools** (`dvot_host.html` or GitHub Pages) to a live Dataverse environment without storing credentials or tokens in the browser.

All three options implement the exact same protocol on `http://127.0.0.1:8787`:
- Serves workspace HTML files & `tools/dvot_*.html` (`Cache-Control: no-store`)
- Acquires OAuth Bearer tokens server-side (`pac auth token`, `az account get-access-token`, JSON config `"token"`, or `DV_TOKEN`)
- Exposes `GET /_proxy/status` and `/api/data/*` with CORS + Private Network Access headers
- Merges un-uploaded local tools into `/api/data/*/webresourceset`

---

## Quick Start Options

### 1. Windows PowerShell (`dev-server.ps1`) — Zero Installs Required
Works out of the box with Windows PowerShell 5.1+ or PowerShell 7 (`pwsh`):
```powershell
.\dev-server\dev-server.ps1 -Env https://yourorg.crm.dynamics.com
```
*(If your machine enforces script signing, run `Unblock-File .\dev-server\dev-server.ps1` or pass `-ExecutionPolicy Bypass`.)*

### 2. C# / .NET (`DvOpenTools.Proxy.csproj`) — Native for C# Devs
Requires [.NET 8 SDK+](https://dotnet.microsoft.com/download) with zero external NuGet dependencies:
```powershell
dotnet run --project dev-server -- --env https://yourorg.crm.dynamics.com
```

### 3. Node.js (`dev-server.js`)
Requires Node.js 18+ with zero npm dependencies:
```bash
node dev-server/dev-server.js --env https://yourorg.crm.dynamics.com
```

> **Note (`pac` in VS Code vs PowerShell/CMD):** The VS Code **Power Platform Tools** extension bundles `pac.exe` privately inside `%APPDATA%\Code\User\globalStorage\microsoft-isvexptools.powerplatform-vscode\pac\tools` and adds it to `PATH` only inside VS Code's integrated terminal. To use `pac` in regular PowerShell/CMD, run `dotnet tool install --global Microsoft.PowerApps.CLI.Tool` (or add VS Code's `pac\tools` folder to your Windows User `PATH`).

---

## Optional JSON Config (`dev-server.config.json`)

The config file is **completely optional**. If omitted, the dev servers work with CLI flags, environment variables, `pac org who` auto-detection, or `--local-only` mode.

To use a config file, create `dev-server.config.json` in the repo root or inside `dev-server/` (both locations are `.gitignore`d) or copy [`dev-server.config.example.json`](dev-server.config.example.json).

### Minimal Sample JSON (Single Environment)
```json
{
  "env": "https://yourorg.crm.dynamics.com"
}
```

### Multi-Environment Sample JSON (Copy & Paste)
```json
{
  "defaultEnvironment": "dev",
  "port": 8787,
  "auth": "auto",
  "localOnly": false,
  "environments": {
    "dev": {
      "url": "https://yourorg-dev.crm.dynamics.com",
      "auth": "pac",
      "token": ""
    },
    "uat": {
      "url": "https://yourorg-uat.crm.dynamics.com",
      "auth": "az",
      "bearerToken": ""
    }
  }
}
```

Then run without typing the URL (or switch profiles by name):
```powershell
dotnet run --project dev-server                # uses defaultEnvironment ("dev")
dotnet run --project dev-server -- --env uat   # switches to "uat" profile
.\dev-server\dev-server.ps1 -Env uat           # PowerShell equivalent
```

### JSON Parameter Reference
Every field is optional:

| Parameter | Scope | Default | Description |
|---|---|---|---|
| `defaultEnvironment` | Top-level | `""` | Profile key under `environments` to use when started without `--env` / `-Env`. |
| `env` / `envUrl` | Top-level | `""` | Direct Dataverse URL when you only target one environment (no `environments` block needed). |
| `port` | Top-level or Profile | `8787` | Local HTTP port (`http://127.0.0.1:<port>`). |
| `auth` | Top-level or Profile | `"auto"` | Bearer token source: `"auto"`, `"pac"`, `"az"`, `"config"`, or `"env"`. |
| `localOnly` | Top-level or Profile | `false` | If `true`, serves HTML tools from disk without proxying calls to Dataverse. |
| `environments` | Top-level | `{}` | Map of named environment profiles (e.g. `"dev"`, `"uat"`) selectable via `--env <name>`. |
| `url` | Profile | `""` | Dataverse org URL for that profile (aliases: `envUrl`, `env`). |
| `token` / `bearerToken` | Top-level or Profile | `""` | Optional static JWT Bearer token (`"Bearer "` prefix stripped automatically). Kept strictly in server memory and never returned to the browser. |

**Precedence order:** CLI flags → Environment variables (`DV_ENV_URL`, `DV_TOKEN`, `PORT`, `DV_AUTH_MODE`) → Active `environments.<name>` profile → Top-level JSON config → `pac org who` auto-detection.

---

## Auth Modes Explained (`--auth` / `-Auth` / `"auth"`)

| Mode | Token Source & Behavior | On HTTP `401` Expiry | Best Used When |
|---|---|---|---|
| **`auto`** *(default)* | Checks in order: `DV_TOKEN` env var → JSON config `token`/`bearerToken` → `pac auth token` → `az account get-access-token`. | Retries with a fresh token from the active source. | You want zero setup and automatic fallback. |
| **`pac`** | Runs `pac auth token` (requires `pac auth create` / `pac auth select`). Ignores JSON token and `az`. | Re-runs `pac auth token` (cached for 40 min). | You switch orgs via PAC CLI and want to avoid accidental `az` fallback. |
| **`az`** | Runs `az account get-access-token --resource <url> --query accessToken -o tsv` scoped strictly to the target org URL. | Fetches a fresh token from Azure CLI (`az login`). | Working across multiple tenants/environments or with service principals. |
| **`config`** | Reads strictly `"token"` / `"bearerToken"` from `dev-server.config.json` (fails if empty; never runs `pac` or `az`). | Re-reads `dev-server.config.json` from disk so you can paste a fresh token without restarting. | Neither `pac` nor `az` is available and you paste tokens manually. |
| **`env`** | Reads strictly the `DV_TOKEN` environment variable from process memory. | Re-reads `DV_TOKEN`. | Running from CI/scripts without writing tokens to disk (`$env:DV_TOKEN = "eyJ..."`). |

---

## Common CLI Flags
| Flag (`.cs` / `.js`) | PowerShell Parameter | Description |
|---|---|---|
| `--env <url\|profile>` | `-Env <url\|profile>` | Target Dataverse org URL or named profile in config JSON (auto-detected via `pac org who` if omitted) |
| `--config <path>` | `-Config <path>` | Explicit path to JSON config (defaults to `./dev-server.config.json` or `dev-server/dev-server.config.json`) |
| `--port <num>` | `-Port <num>` | Local HTTP port (default `8787`) |
| `--auth auto\|pac\|az\|env\|config` | `-Auth auto\|pac\|az\|env\|config` | Bearer token source |
| `--local-only` | `-LocalOnly` | Serve local HTML tools without proxying Dataverse APIs |
| `--build-manifest` | `-BuildManifest` | Regenerate `tools/manifest.json` from `tools/dvot_*.html` |
| `--build-bundle [path]` | `-BuildBundle [-BundleOut path]` | Bundle all tools (without host) into one HTML pack (default `dist/dvot_bundle_all.html`) |
