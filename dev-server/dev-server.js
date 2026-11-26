#!/usr/bin/env node
/**
 * DV Open Tools — Zero-Dependency Local Development Server & Dataverse Auth Proxy
 *
 * Serves dvot_host.html and local dvot_*.html files on http://127.0.0.1:8787
 * and proxies /api/data/* requests server-side to Dataverse using a locally acquired
 * OAuth Bearer token (via `pac auth token`, `az account get-access-token`, or DV_TOKEN).
 *
 * No credentials or tokens are ever passed to or stored in the browser.
 *
 * Usage:
 *   node dev-server/dev-server.js --env https://yourorg.crm.dynamics.com
 *   node dev-server/dev-server.js --env https://yourorg.crm.dynamics.com --port 8787 --auth pac
 *   node dev-server/dev-server.js --local-only
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(ROOT_DIR, 'tools');
const TOKEN_TTL_MS = 40 * 60 * 1000;

/* ─── CLI Argument & JSON Config Parsing ──────────────────── */
function loadDevServerConfig(explicitPath = '') {
  const candidates = [];
  if (explicitPath) {
    candidates.push(path.isAbsolute(explicitPath) ? explicitPath : path.resolve(process.cwd(), explicitPath));
  } else {
    candidates.push(
      path.join(ROOT_DIR, 'dev-server.config.json'),
      path.join(__dirname, 'dev-server.config.json')
    );
  }
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const raw = fs.readFileSync(p, 'utf8');
      return { path: p, data: JSON.parse(raw) };
    }
  }
  if (explicitPath) {
    throw new Error(`Config file not found: ${explicitPath}`);
  }
  return null;
}

function findNamedEnvironment(envsObj, rawName) {
  if (!envsObj || typeof envsObj !== 'object' || !rawName) return null;
  const target = String(rawName).trim().toLowerCase();
  for (const [key, val] of Object.entries(envsObj)) {
    if (key.toLowerCase() === target && val && typeof val === 'object') {
      return { name: key, profile: val };
    }
  }
  return null;
}

function parseArgs(argv) {
  const cli = {
    configPath: (process.env.DV_CONFIG || '').trim(),
    rawEnv: '',
    port: null,
    auth: '',
    localOnly: null,
    buildManifest: false,
    buildBundle: false,
    bundleOut: '',
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') cli.help = true;
    else if (arg === '--local-only') cli.localOnly = true;
    else if (arg === '--build-manifest') cli.buildManifest = true;
    else if (arg === '--build-bundle') {
      cli.buildBundle = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) cli.bundleOut = argv[++i];
    }
    else if (arg.startsWith('--build-bundle=')) { cli.buildBundle = true; cli.bundleOut = arg.slice(15); }
    else if (arg === '--config' && argv[i + 1]) cli.configPath = argv[++i];
    else if (arg.startsWith('--config=')) cli.configPath = arg.slice(9);
    else if (arg === '--env' && argv[i + 1]) cli.rawEnv = argv[++i];
    else if (arg.startsWith('--env=')) cli.rawEnv = arg.slice(6);
    else if (arg === '--port' && argv[i + 1]) cli.port = parseInt(argv[++i], 10) || null;
    else if (arg.startsWith('--port=')) cli.port = parseInt(arg.slice(7), 10) || null;
    else if (arg === '--auth' && argv[i + 1]) cli.auth = argv[++i].toLowerCase();
    else if (arg.startsWith('--auth=')) cli.auth = arg.slice(7).toLowerCase();
  }

  const loadedCfg = cli.help || cli.buildManifest || cli.buildBundle ? null : loadDevServerConfig(cli.configPath);
  const cfg = loadedCfg ? loadedCfg.data : {};

  const envVarUrl = (process.env.DV_ENV_URL || '').trim();
  const envVarPort = parseInt(process.env.PORT || '', 10) || null;
  const envVarAuth = (process.env.DV_AUTH_MODE || '').trim().toLowerCase();

  let activeEnvName = '';
  let profile = null;
  const requestedEnv = cli.rawEnv || envVarUrl;
  if (requestedEnv) {
    const named = findNamedEnvironment(cfg.environments, requestedEnv);
    if (named) {
      activeEnvName = named.name;
      profile = named.profile;
    }
  } else if (cfg.defaultEnvironment) {
    const named = findNamedEnvironment(cfg.environments, cfg.defaultEnvironment);
    if (named) {
      activeEnvName = named.name;
      profile = named.profile;
    }
  }

  const rawResolvedEnv = profile
    ? (profile.url || profile.envUrl || profile.env || '')
    : (requestedEnv || cfg.envUrl || cfg.env || '');

  return {
    configFile: loadedCfg ? path.relative(ROOT_DIR, loadedCfg.path) : '',
    activeEnvName,
    envUrl: rawResolvedEnv ? normalizeEnvUrl(rawResolvedEnv) : '',
    port: cli.port || envVarPort || (profile && parseInt(profile.port, 10)) || parseInt(cfg.port, 10) || 8787,
    auth: cli.auth || envVarAuth || (profile && String(profile.auth || '').toLowerCase()) || String(cfg.auth || 'auto').toLowerCase(),
    localOnly: cli.localOnly !== null ? cli.localOnly : Boolean(profile?.localOnly ?? cfg.localOnly ?? false),
    buildManifest: cli.buildManifest,
    buildBundle: cli.buildBundle,
    bundleOut: cli.bundleOut,
    help: cli.help
  };
}

function normalizeEnvUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).origin; } catch { return s.replace(/\/+$/, ''); }
}

function detectPacOrgUrl() {
  try {
    const out = execFileSync('pac', ['org', 'who'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    const match = out.match(/https:\/\/[a-zA-Z0-9.-]+\.(?:dynamics\.com|dynamics\.cn|microsoftdynamics\.us|appsplatform\.us)/i);
    return match ? match[0] : '';
  } catch {
    return '';
  }
}

/* ─── Server-Side Token Acquisition ────────────────────────── */
let cachedToken = null; // { value, source, fetchedAt }

function acquireTokenFromCli(envUrl, authMode) {
  const tryEnv = () => {
    const t = (process.env.DV_TOKEN || '').trim().replace(/^Bearer\s+/i, '');
    return t ? { value: t, source: 'DV_TOKEN env' } : null;
  };

  const tryPac = () => {
    const out = execFileSync('pac', ['auth', 'token'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const jwt = [...lines].reverse().find(l => l.split('.').length === 3 && l.length > 40);
    if (!jwt) throw new Error('Could not find JWT in `pac auth token` output.');
    return { value: jwt, source: 'pac auth token' };
  };

  const tryAz = () => {
    if (!envUrl) throw new Error('Environment URL is required for `az account get-access-token`.');
    const out = execFileSync('az', ['account', 'get-access-token', '--resource', envUrl, '--query', 'accessToken', '-o', 'tsv'], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (!out || out.split('.').length !== 3) throw new Error('Invalid token returned by `az`.');
    return { value: out, source: 'az account get-access-token' };
  };

  if (authMode === 'env') return tryEnv();
  if (authMode === 'pac') return tryPac();
  if (authMode === 'az') return tryAz();

  // Auto order: DV_TOKEN -> pac -> az
  const envTok = tryEnv();
  if (envTok) return envTok;

  const errs = [];
  for (const fn of [tryPac, tryAz]) {
    try { return fn(); } catch (e) { errs.push(e.message); }
  }
  throw new Error(`No token source succeeded:\n  - ${errs.join('\n  - ')}`);
}

function getBearerToken(opts, forceRefresh = false) {
  if (opts.localOnly || !opts.envUrl) return null;
  if (!forceRefresh && cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_TTL_MS) {
    return cachedToken.value;
  }
  const acquired = acquireTokenFromCli(opts.envUrl, opts.auth);
  if (!acquired) return null;
  cachedToken = { ...acquired, fetchedAt: Date.now() };
  return cachedToken.value;
}

/* ─── Local File Helpers ───────────────────────────────────── */
function resolveSafeLocalFile(relName, baseDir = ROOT_DIR) {
  const clean = decodeURIComponent(relName.split('?')[0]).replace(/^\/+/, '');
  const resolved = path.resolve(baseDir, clean);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function listLocalToolWebResources(prefix = 'dvot_') {
  const dirs = [TOOLS_DIR, ROOT_DIR].filter(d => fs.existsSync(d) && fs.statSync(d).isDirectory());
  const seen = new Set();
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix) && f.endsWith('.html') && f !== `${prefix}host.html` && f !== `${prefix}template.html`) {
        seen.add(f);
      }
    }
  }
  return [...seen].sort().map(name => ({
    name,
    displayname: name.replace(prefix, '').replace(/\.html$/i, '')
  }));
}

function buildToolsManifest(prefix = 'dvot_') {
  const dir = fs.existsSync(TOOLS_DIR) && fs.statSync(TOOLS_DIR).isDirectory() ? TOOLS_DIR : ROOT_DIR;
  const items = [];
  for (const wrName of listLocalToolWebResources(prefix).map(x => x.name)) {
    const fullPath = resolveSafeLocalFile(wrName, TOOLS_DIR) || resolveSafeLocalFile(wrName, ROOT_DIR);
    if (!fullPath) continue;
    const raw = fs.readFileSync(fullPath, 'utf8');
    const m = raw.match(/<script[^>]+id=["']dvopentools-manifest["'][^>]*>([\s\S]*?)<\/script>/i);
    let meta = {};
    if (m) {
      try { meta = JSON.parse(m[1]); } catch {}
    }
    items.push({
      wrName,
      id: meta.id || wrName.replace(prefix, '').replace(/\.html$/i, '').toLowerCase(),
      name: meta.name || wrName.replace(prefix, '').replace(/\.html$/i, ''),
      icon: meta.icon || '🔧',
      category: meta.category || 'General',
      version: meta.version || '1.0.0',
      minHostVersion: meta.minHostVersion || null,
      description: meta.description || '',
      sizeBytes: fs.statSync(fullPath).size
    });
  }
  items.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  if (fs.existsSync(TOOLS_DIR)) {
    fs.writeFileSync(path.join(TOOLS_DIR, 'manifest.json'), JSON.stringify(items, null, 2) + '\n', 'utf8');
  }
  return items;
}

function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildToolsBundle(outPath = '', prefix = 'dvot_') {
  const manifest = buildToolsManifest(prefix);
  const bundledTools = [];
  for (const item of manifest) {
    const fullPath = resolveSafeLocalFile(item.wrName, TOOLS_DIR) || resolveSafeLocalFile(item.wrName, ROOT_DIR);
    if (!fullPath) continue;
    bundledTools.push({
      id: item.id,
      wrName: item.wrName,
      name: item.name,
      icon: item.icon,
      category: item.category,
      version: item.version,
      minHostVersion: item.minHostVersion,
      description: item.description,
      sizeBytes: item.sizeBytes,
      html: fs.readFileSync(fullPath, 'utf8')
    });
  }
  const payload = {
    bundleVersion: 1,
    name: 'DV Open Tools Complete Bundle',
    createdAt: new Date().toISOString(),
    tools: bundledTools
  };
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  const rowsHtml = bundledTools.map(t =>
    `<tr><td>${escapeHtmlText(t.icon)} ${escapeHtmlText(t.name)}</td><td><code>${escapeHtmlText(t.wrName)}</code></td><td>${escapeHtmlText(t.category)}</td><td>v${escapeHtmlText(t.version)}</td><td>${(t.sizeBytes / 1024).toFixed(1)} KB</td></tr>`
  ).join('\n      ');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DV Open Tools — Bundled Tool Pack (${bundledTools.length} tools)</title>
  <style>body{font-family:Segoe UI,system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#1e293b}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left}th{background:#f1f5f9}</style>
</head>
<body>
  <h1>📦 DV Open Tools — Bundled Tool Pack (${bundledTools.length} tools)</h1>
  <p>Upload this single HTML Web Resource alongside <code>dvot_host.html</code> (name starting with <code>dvot_</code>), or import it in the Host via <strong>Load Tool from File</strong>.</p>
  <table>
    <thead><tr><th>Tool</th><th>Source File</th><th>Category</th><th>Version</th><th>Size</th></tr></thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
  <script type="application/json" id="dvopentools-bundle">${safeJson}</script>
</body>
</html>\n`;

  const resolvedOut = outPath ? path.resolve(ROOT_DIR, outPath) : path.join(ROOT_DIR, 'dist', 'dvot_bundle_all.html');
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, html, 'utf8');
  return { outPath: resolvedOut, count: bundledTools.length, bytes: Buffer.byteLength(html, 'utf8') };
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  return 'application/octet-stream';
}

function applyCorsHeaders(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Accept, OData-MaxVersion, OData-Version, Prefer, If-Match, If-None-Match');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function serveFile(res, filePath) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mimeTypeFor(filePath),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* ─── Dataverse HTTPS Proxy ────────────────────────────────── */
function proxyToDataverse(req, res, opts, reqBodyBuffer, retried = false) {
  let token;
  try {
    token = getBearerToken(opts, retried);
  } catch (err) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Local dev-server token error: ${err.message}` } }));
    return;
  }

  const target = new URL(req.url, opts.envUrl);
  const isWebResourceDiscovery = req.method === 'GET' && /\/api\/data\/v[^/]+\/webresourceset/i.test(req.url);
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': req.headers['accept'] || 'application/json',
    'OData-MaxVersion': req.headers['odata-maxversion'] || '4.0',
    'OData-Version': req.headers['odata-version'] || '4.0'
  };
  if (isWebResourceDiscovery) headers['Accept-Encoding'] = 'identity';
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers['prefer']) headers['Prefer'] = req.headers['prefer'];
  if (reqBodyBuffer.length > 0) headers['Content-Length'] = reqBodyBuffer.length;

  const proxyReq = https.request(target, { method: req.method, headers }, proxyRes => {
    // Retry once with refreshed CLI token on 401
    if (proxyRes.statusCode === 401 && !retried) {
      proxyRes.resume();
      proxyToDataverse(req, res, opts, reqBodyBuffer, true);
      return;
    }

    if (isWebResourceDiscovery && proxyRes.statusCode === 200) {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const prefixMatch = decodeURIComponent(req.url).match(/startswith\(name,'([^']+)'\)/i);
          const prefix = prefixMatch ? prefixMatch[1] : 'dvot_';
          const localWrs = listLocalToolWebResources(prefix);
          const seen = new Set((parsed.value || []).map(x => x.name.toLowerCase()));
          for (const wr of localWrs) {
            if (!seen.has(wr.name.toLowerCase())) parsed.value.push(wr);
          }
          const out = Buffer.from(JSON.stringify(parsed), 'utf8');
          const respHdrs = sanitizeResponseHeaders(proxyRes.headers);
          respHdrs['content-type'] = 'application/json; charset=utf-8';
          respHdrs['content-length'] = out.length;
          res.writeHead(200, respHdrs);
          res.end(out);
        } catch {
          res.writeHead(200, sanitizeResponseHeaders(proxyRes.headers));
          res.end(Buffer.concat(chunks));
        }
      });
      return;
    }

    res.writeHead(proxyRes.statusCode || 502, sanitizeResponseHeaders(proxyRes.headers));
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Dataverse proxy error: ${err.message}` } }));
  });

  if (reqBodyBuffer.length > 0) proxyReq.write(reqBodyBuffer);
  proxyReq.end();
}

function sanitizeResponseHeaders(hdrs) {
  const out = {};
  for (const [k, v] of Object.entries(hdrs)) {
    const lk = k.toLowerCase();
    if (['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'set-cookie'].includes(lk)) continue;
    if (lk.startsWith('access-control-')) continue;
    out[k] = v;
  }
  return out;
}

/* ─── HTTP Server Factory ──────────────────────────────────── */
function createDevServer(opts) {
  return http.createServer((req, res) => {
    applyCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = (req.url || '/').split('?')[0];

    // 0. Proxy metadata status (non-secret; never exposes tokens)
    if (reqUrl === '/_proxy/status') {
      let targetHost = '';
      try { if (opts.envUrl) targetHost = new URL(opts.envUrl).hostname; } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        localOnly: !!opts.localOnly,
        targetUrl: opts.envUrl || '',
        targetHost,
        localToolsCount: listLocalToolWebResources().length
      }));
      return;
    }

    // 1. Home page & Host HTML
    if (reqUrl === '/' || reqUrl === '/index.html') {
      const homeFile = resolveSafeLocalFile('index.html') || resolveSafeLocalFile('dvot_host.html');
      if (homeFile) { serveFile(res, homeFile); return; }
    }
    if (reqUrl === '/dvot_host.html') {
      const hostFile = resolveSafeLocalFile('dvot_host.html');
      if (hostFile) { serveFile(res, hostFile); return; }
    }

    // 2. /WebResources/* -> Local tools/ (or root) file first (instant reload), else Dataverse proxy
    if (reqUrl.startsWith('/WebResources/')) {
      const wrName = reqUrl.slice('/WebResources/'.length);
      const localFile = resolveSafeLocalFile(wrName, TOOLS_DIR) || resolveSafeLocalFile(wrName, ROOT_DIR);
      if (localFile) {
        serveFile(res, localFile);
        return;
      }
      if (!opts.localOnly && opts.envUrl) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => proxyToDataverse(req, res, opts, Buffer.concat(chunks)));
        return;
      }
    }

    // 3. /api/data/* -> Proxy to Dataverse with server-side Bearer token (or local-only discovery fallback)
    if (reqUrl.startsWith('/api/data/')) {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (opts.localOnly || !opts.envUrl) {
          if (/\/webresourceset/i.test(reqUrl)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ value: listLocalToolWebResources() }));
            return;
          }
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Running in local-only mode (pass --env https://yourorg.crm.dynamics.com to proxy live Dataverse calls).' } }));
          return;
        }
        proxyToDataverse(req, res, opts, Buffer.concat(chunks));
      });
      return;
    }

    // 4. Other local files inside workspace
    const localFile = resolveSafeLocalFile(reqUrl);
    if (localFile) { serveFile(res, localFile); return; }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
}

/* ─── Entry Point ──────────────────────────────────────────── */
if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`
DV Open Tools — Local Dev Server & Auth Proxy

Usage:
  node dev-server/dev-server.js [--env <url|profile>] [--config dev-server.config.json] [--port 8787] [--auth auto|pac|az|env] [--local-only]

Options:
  --env <val>       Target Dataverse org URL or named environment in dev-server.config.json (auto-detected via \`pac org who\` if omitted)
  --config <path>   Path to JSON environment config (default: ./dev-server.config.json or dev-server/dev-server.config.json)
  --port <num>      Local HTTP port (default: 8787)
  --auth <mode>     Token source: auto (default), pac (\`pac auth token\`), az (\`az account get-access-token\`), or env (DV_TOKEN)
  --local-only      Serve local HTML tools without proxying Dataverse API calls
  --build-manifest  Regenerate tools/manifest.json from tools/dvot_*.html and exit
  --build-bundle    Generate a single-file tool bundle HTML (default: dist/dvot_bundle_all.html)
`);
    process.exit(0);
  }

  if (opts.configFile) {
    const profMsg = opts.activeEnvName ? ` (profile: ${opts.activeEnvName})` : '';
    console.log(`[dev-server] Loaded config: ${opts.configFile}${profMsg}`);
  }

  if (opts.buildManifest) {
    const items = buildToolsManifest();
    console.log(`[dev-server] Wrote tools/manifest.json (${items.length} tools).`);
    process.exit(0);
  }

  if (opts.buildBundle) {
    const res = buildToolsBundle(opts.bundleOut);
    console.log(`[dev-server] Wrote ${path.relative(ROOT_DIR, res.outPath)} (${res.count} tools, ${(res.bytes / 1024).toFixed(1)} KB).`);
    process.exit(0);
  }

  if (!opts.localOnly && !opts.envUrl) {
    const detected = detectPacOrgUrl();
    if (detected) {
      opts.envUrl = detected;
      console.log(`[dev-server] Auto-detected Dataverse org from \`pac org who\`: ${detected}`);
    } else {
      console.log('[dev-server] No --env provided and `pac org who` unavailable; starting in --local-only UI mode.');
      opts.localOnly = true;
    }
  }

  if (!opts.localOnly) {
    try {
      getBearerToken(opts);
      console.log(`[dev-server] Server-side Bearer token acquired via ${cachedToken.source} (kept in Node memory only).`);
    } catch (err) {
      console.warn(`[dev-server] Warning: Initial token fetch failed (${err.message}). API calls will retry when requested.`);
    }
  }

  const server = createDevServer(opts);
  server.listen(opts.port, '127.0.0.1', () => {
    console.log(`\n⚡ DV Open Tools Local Server running at: http://127.0.0.1:${opts.port}/dvot_host.html`);
    console.log(`   Mode: ${opts.localOnly ? 'Local UI only (no Dataverse proxy)' : `Proxying /api/data/* -> ${opts.envUrl}`}`);
    console.log(`   Local tools auto-discovered: ${listLocalToolWebResources().length}\n`);
  });
}

module.exports = { parseArgs, createDevServer, listLocalToolWebResources, resolveSafeLocalFile, buildToolsManifest, buildToolsBundle };
