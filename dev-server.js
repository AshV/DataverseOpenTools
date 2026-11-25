#!/usr/bin/env node
/**
 * DV Open Tools — Zero-Dependency Local Development Server & Dataverse Auth Proxy
 *
 * Serves dvopentools_host.html and local dvopentools_*.html files on http://127.0.0.1:8787
 * and proxies /api/data/* requests server-side to Dataverse using a locally acquired
 * OAuth Bearer token (via `pac auth token`, `az account get-access-token`, or DV_TOKEN).
 *
 * No credentials or tokens are ever passed to or stored in the browser.
 *
 * Usage:
 *   node dev-server.js --env https://yourorg.crm.dynamics.com
 *   node dev-server.js --env https://yourorg.crm.dynamics.com --port 8787 --auth pac
 *   node dev-server.js --local-only
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname);
const TOKEN_TTL_MS = 40 * 60 * 1000;

/* ─── CLI Argument Parsing ─────────────────────────────────── */
function parseArgs(argv) {
  const opts = {
    envUrl: (process.env.DV_ENV_URL || '').trim().replace(/\/+$/, ''),
    port: parseInt(process.env.PORT || '8787', 10) || 8787,
    auth: (process.env.DV_AUTH_MODE || 'auto').toLowerCase(),
    localOnly: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--local-only') opts.localOnly = true;
    else if (arg === '--env' && argv[i + 1]) opts.envUrl = normalizeEnvUrl(argv[++i]);
    else if (arg.startsWith('--env=')) opts.envUrl = normalizeEnvUrl(arg.slice(6));
    else if (arg === '--port' && argv[i + 1]) opts.port = parseInt(argv[++i], 10) || 8787;
    else if (arg.startsWith('--port=')) opts.port = parseInt(arg.slice(7), 10) || 8787;
    else if (arg === '--auth' && argv[i + 1]) opts.auth = argv[++i].toLowerCase();
    else if (arg.startsWith('--auth=')) opts.auth = arg.slice(7).toLowerCase();
  }
  return opts;
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
function resolveSafeLocalFile(relName) {
  const clean = decodeURIComponent(relName.split('?')[0]).replace(/^\/+/, '');
  const resolved = path.resolve(ROOT_DIR, clean);
  if (resolved !== ROOT_DIR && !resolved.startsWith(ROOT_DIR + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function listLocalToolWebResources(prefix = 'dvopentools_') {
  return fs.readdirSync(ROOT_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.html') && f !== `${prefix}host.html` && f !== `${prefix}template.html`)
    .sort()
    .map(name => ({
      name,
      displayname: name.replace(prefix, '').replace(/\.html$/i, '')
    }));
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
          const prefix = prefixMatch ? prefixMatch[1] : 'dvopentools_';
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
    out[k] = v;
  }
  return out;
}

/* ─── HTTP Server Factory ──────────────────────────────────── */
function createDevServer(opts) {
  return http.createServer((req, res) => {
    const reqUrl = (req.url || '/').split('?')[0];

    // 1. Root -> Host HTML
    if (reqUrl === '/' || reqUrl === '/dvopentools_host.html') {
      const hostFile = resolveSafeLocalFile('dvopentools_host.html');
      if (hostFile) { serveFile(res, hostFile); return; }
    }

    // 2. /WebResources/* -> Local workspace file first (instant reload), else Dataverse proxy
    if (reqUrl.startsWith('/WebResources/')) {
      const wrName = reqUrl.slice('/WebResources/'.length);
      const localFile = resolveSafeLocalFile(wrName);
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
  node dev-server.js [--env https://yourorg.crm.dynamics.com] [--port 8787] [--auth auto|pac|az|env] [--local-only]

Options:
  --env <url>     Target Dataverse org URL (auto-detected via \`pac org who\` if omitted)
  --port <num>    Local HTTP port (default: 8787)
  --auth <mode>   Token source: auto (default), pac (\`pac auth token\`), az (\`az account get-access-token\`), or env (DV_TOKEN)
  --local-only    Serve local HTML tools without proxying Dataverse API calls
`);
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
    console.log(`\n⚡ DV Open Tools Local Server running at: http://127.0.0.1:${opts.port}/dvopentools_host.html`);
    console.log(`   Mode: ${opts.localOnly ? 'Local UI only (no Dataverse proxy)' : `Proxying /api/data/* -> ${opts.envUrl}`}`);
    console.log(`   Local tools auto-discovered: ${listLocalToolWebResources().length}\n`);
  });
}

module.exports = { parseArgs, createDevServer, listLocalToolWebResources, resolveSafeLocalFile };
