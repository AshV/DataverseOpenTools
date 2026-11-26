<#
.SYNOPSIS
    DV Open Tools — Zero-Install PowerShell Local Dev Server & Dataverse Auth Proxy
.DESCRIPTION
    Serves index.html, dvot_host.html, and tools/dvot_*.html on http://127.0.0.1:8787
    and proxies /api/data/* requests to Dataverse using locally acquired OAuth Bearer tokens
    (`pac auth token`, `az account get-access-token`, or $env:DV_TOKEN).
.EXAMPLE
    .\dev-server\dev-server.ps1 -Env https://yourorg.crm.dynamics.com
.EXAMPLE
    .\dev-server\dev-server.ps1 -LocalOnly
#>
[CmdletBinding()]
param(
    [Alias('EnvUrl')]
    [string]$Env = $env:DV_ENV_URL,
    [int]$Port = $(if ($env:PORT -as [int]) { [int]$env:PORT } else { 8787 }),
    [ValidateSet('auto', 'pac', 'az', 'env')]
    [string]$Auth = $(if ($env:DV_AUTH_MODE) { $env:DV_AUTH_MODE.ToLowerInvariant() } else { 'auto' }),
    [switch]$LocalOnly,
    [switch]$BuildManifest,
    [switch]$BuildBundle,
    [string]$BundleOut = '',
    [switch]$Help,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Parse POSIX-style (--env, --port, ...) flags for parity with Node & .NET CLIs
if ($ExtraArgs) {
    for ($i = 0; $i -lt $ExtraArgs.Count; $i++) {
        $a = $ExtraArgs[$i]
        if ($a -in @('--help', '-h')) { $Help = $true }
        elseif ($a -eq '--local-only') { $LocalOnly = $true }
        elseif ($a -eq '--build-manifest') { $BuildManifest = $true }
        elseif ($a -eq '--build-bundle') {
            $BuildBundle = $true
            if (($i + 1) -lt $ExtraArgs.Count -and -not $ExtraArgs[$i + 1].StartsWith('--')) { $BundleOut = $ExtraArgs[++$i] }
        }
        elseif ($a.StartsWith('--build-bundle=')) { $BuildBundle = $true; $BundleOut = $a.Substring(15) }
        elseif ($a -eq '--env' -and ($i + 1) -lt $ExtraArgs.Count) { $Env = $ExtraArgs[++$i] }
        elseif ($a.StartsWith('--env=')) { $Env = $a.Substring(6) }
        elseif ($a -eq '--port' -and ($i + 1) -lt $ExtraArgs.Count) { $Port = [int]$ExtraArgs[++$i] }
        elseif ($a.StartsWith('--port=')) { $Port = [int]$a.Substring(7) }
        elseif ($a -eq '--auth' -and ($i + 1) -lt $ExtraArgs.Count) { $Auth = $ExtraArgs[++$i].ToLowerInvariant() }
        elseif ($a.StartsWith('--auth=')) { $Auth = $a.Substring(7).ToLowerInvariant() }
    }
}

if ($Help) {
    Write-Host @"
DV Open Tools — PowerShell Local Dev Server & Auth Proxy

Usage:
  .\dev-server\dev-server.ps1 [-Env https://yourorg.crm.dynamics.com] [-Port 8787] [-Auth auto|pac|az|env] [-LocalOnly]

Options:
  -Env <url>        Target Dataverse org URL (auto-detected via ``pac org who`` if omitted)
  -Port <num>       Local HTTP port (default: 8787)
  -Auth <mode>      Token source: auto (default), pac (``pac auth token``), az (``az account get-access-token``), or env (DV_TOKEN)
  -LocalOnly        Serve local HTML tools without proxying Dataverse API calls
  -BuildManifest    Regenerate tools/manifest.json from tools/dvot_*.html and exit
"@
    exit 0
}

Add-Type -AssemblyName System.Net.Http
try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
} catch {}

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ToolsDir = Join-Path $RootDir 'tools'
$Script:TokenTtlSeconds = 40 * 60
$Script:CachedToken = $null

function Normalize-EnvUrl([string]$Raw) {
    $s = if ($Raw) { $Raw.Trim() } else { '' }
    if (-not $s) { return '' }
    if ($s -notmatch '^https?://') { $s = "https://$s" }
    try {
        return ([System.Uri]$s).GetLeftPart([System.UriPartial]::Authority)
    } catch {
        return $s.TrimEnd('/')
    }
}

function Detect-PacOrgUrl {
    try {
        $out = & pac org who 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0 -and $out -match 'https://[a-zA-Z0-9.-]+\.(?:dynamics\.com|dynamics\.cn|microsoftdynamics\.us|appsplatform\.us)') {
            return $Matches[0]
        }
    } catch {}
    return ''
}

function Acquire-TokenFromCli([string]$EnvUrl, [string]$AuthMode) {
    $tryEnv = {
        $t = if ($env:DV_TOKEN) { $env:DV_TOKEN.Trim() -replace '^Bearer\s+', '' } else { '' }
        if ($t) { return @{ Value = $t; Source = 'DV_TOKEN env' } }
        return $null
    }

    $tryPac = {
        $lines = (& pac auth token 2>&1) | ForEach-Object { "$_".Trim() } | Where-Object { $_ }
        if ($LASTEXITCODE -ne 0) { throw "pac auth token exited with $LASTEXITCODE" }
        for ($idx = $lines.Count - 1; $idx -ge 0; $idx--) {
            $ln = $lines[$idx]
            if ($ln.Length -gt 40 -and ($ln -split '\.').Count -eq 3) {
                return @{ Value = $ln; Source = 'pac auth token' }
            }
        }
        throw 'Could not find JWT in `pac auth token` output.'
    }

    $tryAz = {
        if (-not $EnvUrl) { throw 'Environment URL is required for `az account get-access-token`.' }
        $tok = (& az account get-access-token --resource $EnvUrl --query accessToken -o tsv 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $tok -or ($tok -split '\.').Count -ne 3) {
            throw 'Invalid token returned by `az`.'
        }
        return @{ Value = $tok; Source = 'az account get-access-token' }
    }

    if ($AuthMode -eq 'env') { return (& $tryEnv) }
    if ($AuthMode -eq 'pac') { return (& $tryPac) }
    if ($AuthMode -eq 'az') { return (& $tryAz) }

    $envTok = & $tryEnv
    if ($envTok) { return $envTok }

    $errs = @()
    foreach ($fn in @($tryPac, $tryAz)) {
        try { return (& $fn) } catch { $errs += $_.Exception.Message }
    }
    throw "No token source succeeded:`n  - $($errs -join "`n  - ")"
}

function Get-BearerToken([string]$EnvUrl, [string]$AuthMode, [bool]$IsLocalOnly, [bool]$ForceRefresh = $false) {
    if ($IsLocalOnly -or -not $EnvUrl) { return $null }
    if (-not $ForceRefresh -and $Script:CachedToken) {
        $age = ([DateTimeOffset]::UtcNow - $Script:CachedToken.FetchedAt).TotalSeconds
        if ($age -lt $Script:TokenTtlSeconds) { return $Script:CachedToken.Value }
    }
    $acq = Acquire-TokenFromCli $EnvUrl $AuthMode
    if (-not $acq) { return $null }
    $Script:CachedToken = @{
        Value     = $acq.Value
        Source    = $acq.Source
        FetchedAt = [DateTimeOffset]::UtcNow
    }
    return $Script:CachedToken.Value
}

function Resolve-SafeLocalFile([string]$RelName, [string]$BaseDir) {
    $pathPart = ($RelName -split '\?', 2)[0]
    $clean = [System.Uri]::UnescapeDataString($pathPart).TrimStart('/') -replace '/', [System.IO.Path]::DirectorySeparatorChar
    $fullBase = [System.IO.Path]::GetFullPath($BaseDir)
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $fullBase $clean))
    $sep = [System.IO.Path]::DirectorySeparatorChar
    if (-not ($resolved.StartsWith("$fullBase$sep", [System.StringComparison]::OrdinalIgnoreCase) -or $resolved.Equals($fullBase, [System.StringComparison]::OrdinalIgnoreCase))) {
        return $null
    }
    if ([System.IO.File]::Exists($resolved)) { return $resolved }
    return $null
}

function Get-LocalToolWebResources([string]$Prefix = 'dvot_') {
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($dir in @($ToolsDir, $RootDir)) {
        if (-not [System.IO.Directory]::Exists($dir)) { continue }
        foreach ($f in [System.IO.Directory]::EnumerateFiles($dir, '*.html')) {
            $name = [System.IO.Path]::GetFileName($f)
            if ($name.StartsWith($Prefix, [System.StringComparison]::Ordinal) -and
                $name -ne "${Prefix}host.html" -and
                $name -ne "${Prefix}template.html") {
                [void]$seen.Add($name)
            }
        }
    }
    $sorted = $seen | Sort-Object
    $list = @()
    foreach ($n in $sorted) {
        $list += [ordered]@{
            name        = $n
            displayname = $n.Substring($Prefix.Length, $n.Length - $Prefix.Length - 5)
        }
    }
    return $list
}

function Build-ToolsManifest([string]$Prefix = 'dvot_') {
    $items = @()
    foreach ($wr in (Get-LocalToolWebResources $Prefix)) {
        $wrName = $wr.name
        $fullPath = Resolve-SafeLocalFile $wrName $ToolsDir
        if (-not $fullPath) { $fullPath = Resolve-SafeLocalFile $wrName $RootDir }
        if (-not $fullPath) { continue }
        $raw = [System.IO.File]::ReadAllText($fullPath, [System.Text.Encoding]::UTF8)
        $meta = $null
        if ($raw -match '(?si)<script[^>]+id=["'']dvopentools-manifest["''][^>]*>([\s\S]*?)<\/script>') {
            try { $meta = $Matches[1] | ConvertFrom-Json } catch {}
        }
        $fallback = $wr.displayname
        $items += [pscustomobject]@{
            wrName         = $wrName
            id             = if ($meta -and $meta.id) { $meta.id } else { $fallback.ToLowerInvariant() }
            name           = if ($meta -and $meta.name) { $meta.name } else { $fallback }
            icon           = if ($meta -and $meta.icon) { $meta.icon } else { '🔧' }
            category       = if ($meta -and $meta.category) { $meta.category } else { 'General' }
            version        = if ($meta -and $meta.version) { $meta.version } else { '1.0.0' }
            minHostVersion = if ($meta -and $meta.PSObject.Properties['minHostVersion']) { $meta.minHostVersion } else { $null }
            description    = if ($meta -and $meta.description) { $meta.description } else { '' }
            sizeBytes      = (Get-Item $fullPath).Length
        }
    }
    $sorted = $items | Sort-Object -Property category, name
    if ([System.IO.Directory]::Exists($ToolsDir)) {
        $json = ($sorted | ConvertTo-Json -Depth 10) + "`n"
        [System.IO.File]::WriteAllText((Join-Path $ToolsDir 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
    }
    return $sorted
}

function Build-ToolsBundle([string]$OutPath = '', [string]$Prefix = 'dvot_') {
    $manifest = Build-ToolsManifest $Prefix
    $bundleTools = @()
    $rows = New-Object System.Text.StringBuilder
    foreach ($item in $manifest) {
        $fullPath = Resolve-SafeLocalFile $item.wrName $ToolsDir
        if (-not $fullPath) { $fullPath = Resolve-SafeLocalFile $item.wrName $RootDir }
        if (-not $fullPath) { continue }
        $toolHtml = [System.IO.File]::ReadAllText($fullPath, [System.Text.Encoding]::UTF8)
        $bundleTools += [pscustomobject]@{
            id             = $item.id
            wrName         = $item.wrName
            name           = $item.name
            icon           = $item.icon
            category       = $item.category
            version        = $item.version
            minHostVersion = $item.minHostVersion
            description    = $item.description
            sizeBytes      = $item.sizeBytes
            html           = $toolHtml
        }
        $escIcon = [System.Net.WebUtility]::HtmlEncode($item.icon)
        $escName = [System.Net.WebUtility]::HtmlEncode($item.name)
        $escWr   = [System.Net.WebUtility]::HtmlEncode($item.wrName)
        $escCat  = [System.Net.WebUtility]::HtmlEncode($item.category)
        $escVer  = [System.Net.WebUtility]::HtmlEncode($item.version)
        $kb      = [Math]::Round($item.sizeBytes / 1024, 1)
        [void]$rows.AppendLine("      <tr><td>$escIcon $escName</td><td><code>$escWr</code></td><td>$escCat</td><td>v$escVer</td><td>$kb KB</td></tr>")
    }
    $payload = [ordered]@{
        bundleVersion = 1
        name          = 'DV Open Tools Complete Bundle'
        createdAt     = [DateTimeOffset]::UtcNow.ToString('O')
        tools         = $bundleTools
    }
    $safeJson = ($payload | ConvertTo-Json -Depth 10 -Compress).Replace('<', '\u003c')
    $html = @"
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DV Open Tools — Bundled Tool Pack ($($bundleTools.Count) tools)</title>
  <style>body{font-family:Segoe UI,system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#1e293b}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left}th{background:#f1f5f9}</style>
</head>
<body>
  <h1>📦 DV Open Tools — Bundled Tool Pack ($($bundleTools.Count) tools)</h1>
  <p>Upload this single HTML Web Resource alongside <code>dvot_host.html</code> (name starting with <code>dvot_</code>), or import it in the Host via <strong>Load Tool from File</strong>.</p>
  <table>
    <thead><tr><th>Tool</th><th>Source File</th><th>Category</th><th>Version</th><th>Size</th></tr></thead>
    <tbody>
$($rows.ToString())    </tbody>
  </table>
  <script type="application/json" id="dvopentools-bundle">$safeJson</script>
</body>
</html>
"@
    $resolvedOut = if ($OutPath) { [System.IO.Path]::GetFullPath((Join-Path $RootDir $OutPath)) } else { Join-Path (Join-Path $RootDir 'dist') 'dvot_bundle_all.html' }
    $outDir = [System.IO.Path]::GetDirectoryName($resolvedOut)
    if (-not [System.IO.Directory]::Exists($outDir)) { [void][System.IO.Directory]::CreateDirectory($outDir) }
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($html)
    [System.IO.File]::WriteAllBytes($resolvedOut, $bytes)
    return @{ OutPath = $resolvedOut; Count = $bundleTools.Count; Bytes = $bytes.Length }
}

function Get-MimeType([string]$FilePath) {
    switch ([System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()) {
        '.html' { return 'text/html; charset=utf-8' }
        '.htm'  { return 'text/html; charset=utf-8' }
        '.js'   { return 'application/javascript; charset=utf-8' }
        '.css'  { return 'text/css; charset=utf-8' }
        '.json' { return 'application/json; charset=utf-8' }
        '.md'   { return 'text/markdown; charset=utf-8' }
        default { return 'application/octet-stream' }
    }
}

function Apply-CorsHeaders($Req, $Res) {
    $Res.Headers['Access-Control-Allow-Origin'] = '*'
    $Res.Headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, PUT, DELETE, OPTIONS'
    $reqHdrs = $Req.Headers['Access-Control-Request-Headers']
    $Res.Headers['Access-Control-Allow-Headers'] = if ($reqHdrs) { $reqHdrs } else { 'Content-Type, Accept, OData-MaxVersion, OData-Version, Prefer, If-Match, If-None-Match' }
    $Res.Headers['Access-Control-Expose-Headers'] = '*'
    $Res.Headers['Access-Control-Allow-Private-Network'] = 'true'
}

function Write-ResponseBytes($Res, [int]$StatusCode, [string]$ContentType, [byte[]]$Bytes, [string]$CacheControl = $null) {
    $Res.StatusCode = $StatusCode
    $Res.ContentType = $ContentType
    if ($CacheControl) { $Res.Headers['Cache-Control'] = $CacheControl }
    $Res.ContentLength64 = $Bytes.Length
    $Res.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $Res.OutputStream.Close()
}

function Serve-LocalFile($Res, [string]$FilePath) {
    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    Write-ResponseBytes $Res 200 (Get-MimeType $FilePath) $bytes 'no-store'
}

function Read-RequestBody($Req) {
    if (-not $Req.HasEntityBody) { return [byte[]]@() }
    $ms = New-Object System.IO.MemoryStream
    try {
        $Req.InputStream.CopyTo($ms)
        return $ms.ToArray()
    } finally {
        $ms.Dispose()
    }
}

$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
$handler.AllowAutoRedirect = $false
$Script:HttpClient = New-Object System.Net.Http.HttpClient($handler)
$Script:HttpClient.Timeout = [TimeSpan]::FromSeconds(120)

function Invoke-DataverseProxy($Req, $Res, [string]$RawUrl, [string]$EnvUrl, [string]$AuthMode, [byte[]]$BodyBytes, [bool]$Retried = $false) {
    $token = $null
    try {
        $token = Get-BearerToken $EnvUrl $AuthMode $false $Retried
    } catch {
        $errJson = (@{ error = @{ message = "Local dev-server token error: $($_.Exception.Message)" } } | ConvertTo-Json -Compress)
        Write-ResponseBytes $Res 401 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($errJson))
        return
    }

    $targetUri = New-Object System.Uri((New-Object System.Uri($EnvUrl)), $RawUrl)
    $msg = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Req.HttpMethod)), $targetUri)
    try {
        $msg.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
        [void]$msg.Headers.TryAddWithoutValidation('Accept', $(if ($Req.Headers['Accept']) { $Req.Headers['Accept'] } else { 'application/json' }))
        [void]$msg.Headers.TryAddWithoutValidation('OData-MaxVersion', $(if ($Req.Headers['OData-MaxVersion']) { $Req.Headers['OData-MaxVersion'] } else { '4.0' }))
        [void]$msg.Headers.TryAddWithoutValidation('OData-Version', $(if ($Req.Headers['OData-Version']) { $Req.Headers['OData-Version'] } else { '4.0' }))
        if ($Req.Headers['Prefer']) { [void]$msg.Headers.TryAddWithoutValidation('Prefer', $Req.Headers['Prefer']) }
        if ($Req.Headers['If-Match']) { [void]$msg.Headers.TryAddWithoutValidation('If-Match', $Req.Headers['If-Match']) }
        if ($Req.Headers['If-None-Match']) { [void]$msg.Headers.TryAddWithoutValidation('If-None-Match', $Req.Headers['If-None-Match']) }

        if ($BodyBytes.Length -gt 0) {
            $msg.Content = New-Object System.Net.Http.ByteArrayContent(,$BodyBytes)
            if ($Req.ContentType) { [void]$msg.Content.Headers.TryAddWithoutValidation('Content-Type', $Req.ContentType) }
        }

        $proxyRes = $Script:HttpClient.SendAsync($msg).GetAwaiter().GetResult()
        try {
            $status = [int]$proxyRes.StatusCode
            if ($status -eq 401 -and -not $Retried) {
                Invoke-DataverseProxy $Req $Res $RawUrl $EnvUrl $AuthMode $BodyBytes $true
                return
            }

            $respBytes = $proxyRes.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            $skipHeaders = @('connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'set-cookie', 'content-type')
            foreach ($h in $proxyRes.Headers) {
                $lk = $h.Key.ToLowerInvariant()
                if ($lk -notin $skipHeaders -and -not $lk.StartsWith('access-control-')) {
                    try { $Res.Headers[$h.Key] = ($h.Value -join ', ') } catch {}
                }
            }
            foreach ($h in $proxyRes.Content.Headers) {
                $lk = $h.Key.ToLowerInvariant()
                if ($lk -notin $skipHeaders -and -not $lk.StartsWith('access-control-')) {
                    try { $Res.Headers[$h.Key] = ($h.Value -join ', ') } catch {}
                }
            }

            $isWrDisc = ($Req.HttpMethod -ieq 'GET') -and ($RawUrl -match '/api/data/v[^/]+/webresourceset')
            if ($isWrDisc -and $status -eq 200) {
                try {
                    $parsed = ([System.Text.Encoding]::UTF8.GetString($respBytes)) | ConvertFrom-Json
                    $prefix = 'dvot_'
                    $decodedUrl = [System.Uri]::UnescapeDataString($RawUrl)
                    if ($decodedUrl -match "startswith\(name,'([^']+)'\)") { $prefix = $Matches[1] }
                    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
                    $mergedList = New-Object System.Collections.ArrayList
                    if ($parsed.PSObject.Properties['value'] -and $parsed.value) {
                        foreach ($item in $parsed.value) {
                            if ($item.PSObject.Properties['name'] -and $item.name) { [void]$seen.Add([string]$item.name) }
                            [void]$mergedList.Add($item)
                        }
                    }
                    foreach ($wr in (Get-LocalToolWebResources $prefix)) {
                        if (-not $seen.Contains($wr.name)) { [void]$mergedList.Add($wr) }
                    }
                    $parsed.value = @($mergedList)
                    $outJson = $parsed | ConvertTo-Json -Depth 15 -Compress
                    Write-ResponseBytes $Res 200 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($outJson))
                    return
                } catch {}
            }

            $ct = if ($proxyRes.Content.Headers.ContentType) { $proxyRes.Content.Headers.ContentType.ToString() } else { 'application/octet-stream' }
            Write-ResponseBytes $Res $status $ct $respBytes
        } finally {
            $proxyRes.Dispose()
        }
    } catch {
        $errJson = (@{ error = @{ message = "Dataverse proxy error: $($_.Exception.Message)" } } | ConvertTo-Json -Compress)
        Write-ResponseBytes $Res 502 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($errJson))
    } finally {
        $msg.Dispose()
    }
}

if ($BuildManifest) {
    $built = Build-ToolsManifest
    Write-Host "[dev-server] Wrote tools/manifest.json ($($built.Count) tools)."
    exit 0
}

if ($BuildBundle) {
    $res = Build-ToolsBundle $BundleOut
    Write-Host "[dev-server] Wrote $($res.OutPath) ($($res.Count) tools, $([Math]::Round($res.Bytes / 1024, 1)) KB)."
    exit 0
}

$Env = Normalize-EnvUrl $Env
if (-not $LocalOnly -and -not $Env) {
    $detected = Detect-PacOrgUrl
    if ($detected) {
        $Env = $detected
        Write-Host "[dev-server] Auto-detected Dataverse org from ``pac org who``: $detected"
    } else {
        Write-Host '[dev-server] No -Env provided and `pac org who` unavailable; starting in -LocalOnly UI mode.'
        $LocalOnly = $true
    }
}

if (-not $LocalOnly) {
    try {
        [void](Get-BearerToken $Env $Auth $false $false)
        Write-Host "[dev-server] Server-side Bearer token acquired via $($Script:CachedToken.Source) (kept in PowerShell memory only)."
    } catch {
        Write-Warning "[dev-server] Initial token fetch failed ($($_.Exception.Message)). API calls will retry when requested."
    }
}

$listener = New-Object System.Net.HttpListener
$prefixUrl = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefixUrl)
$listener.Start()

try {
    Write-Host "`n⚡ DV Open Tools Local Server (PowerShell) running at: ${prefixUrl}dvot_host.html"
    Write-Host "   Mode: $(if ($LocalOnly) { 'Local UI only (no Dataverse proxy)' } else { "Proxying /api/data/* -> $Env" })"
    Write-Host "   Local tools auto-discovered: $((Get-LocalToolWebResources).Count)"
    Write-Host "   Press Ctrl+C to stop.`n"

    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        try {
            Apply-CorsHeaders $req $res
            if ($req.HttpMethod -ieq 'OPTIONS') {
                $res.StatusCode = 204
                $res.Close()
                continue
            }

            $rawUrl = if ($req.RawUrl) { $req.RawUrl } else { '/' }
            $reqPath = ($rawUrl -split '\?', 2)[0]

            if ($reqPath -eq '/_proxy/status') {
                $targetHost = ''
                if ($Env) { try { $targetHost = ([System.Uri]$Env).Host } catch {} }
                $statusJson = (@{
                    ok              = $true
                    localOnly       = [bool]$LocalOnly
                    targetUrl       = if ($Env) { $Env } else { '' }
                    targetHost      = $targetHost
                    localToolsCount = (Get-LocalToolWebResources).Count
                } | ConvertTo-Json -Compress)
                Write-ResponseBytes $res 200 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($statusJson)) 'no-store'
                continue
            }

            if ($reqPath -eq '/' -or $reqPath -eq '/index.html') {
                $homeFile = Resolve-SafeLocalFile 'index.html' $RootDir
                if (-not $homeFile) { $homeFile = Resolve-SafeLocalFile 'dvot_host.html' $RootDir }
                if ($homeFile) { Serve-LocalFile $res $homeFile; continue }
            }

            if ($reqPath -eq '/dvot_host.html') {
                $hostFile = Resolve-SafeLocalFile 'dvot_host.html' $RootDir
                if ($hostFile) { Serve-LocalFile $res $hostFile; continue }
            }

            if ($reqPath.StartsWith('/WebResources/', [System.StringComparison]::Ordinal)) {
                $wrName = $reqPath.Substring('/WebResources/'.Length)
                $localFile = Resolve-SafeLocalFile $wrName $ToolsDir
                if (-not $localFile) { $localFile = Resolve-SafeLocalFile $wrName $RootDir }
                if ($localFile) { Serve-LocalFile $res $localFile; continue }

                if (-not $LocalOnly -and $Env) {
                    $bodyBytes = Read-RequestBody $req
                    Invoke-DataverseProxy $req $res $rawUrl $Env $Auth $bodyBytes $false
                    continue
                }
            }

            if ($reqPath.StartsWith('/api/data/', [System.StringComparison]::Ordinal)) {
                $bodyBytes = Read-RequestBody $req
                if ($LocalOnly -or -not $Env) {
                    if ($reqPath -match '/webresourceset') {
                        $wrJson = (@{ value = @(Get-LocalToolWebResources) } | ConvertTo-Json -Depth 5 -Compress)
                        Write-ResponseBytes $res 200 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($wrJson))
                        continue
                    }
                    $errJson = (@{ error = @{ message = 'Running in local-only mode (pass -Env https://yourorg.crm.dynamics.com to proxy live Dataverse calls).' } } | ConvertTo-Json -Compress)
                    Write-ResponseBytes $res 503 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($errJson))
                    continue
                }
                Invoke-DataverseProxy $req $res $rawUrl $Env $Auth $bodyBytes $false
                continue
            }

            $otherFile = Resolve-SafeLocalFile $reqPath $RootDir
            if ($otherFile) { Serve-LocalFile $res $otherFile; continue }

            Write-ResponseBytes $res 404 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Not Found'))
        } catch {
            try {
                $errJson = (@{ error = @{ message = "Local PowerShell proxy error: $($_.Exception.Message)" } } | ConvertTo-Json -Compress)
                Write-ResponseBytes $res 500 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($errJson))
            } catch {}
        }
    }
} finally {
    if ($listener.IsListening) { $listener.Stop() }
    $listener.Close()
    $Script:HttpClient.Dispose()
}
