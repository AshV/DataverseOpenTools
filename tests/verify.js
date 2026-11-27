'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(ROOT, 'tools');

const hostHtml = fs.readFileSync(path.join(ROOT, 'dvot_host.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, 'manifest.json'), 'utf8'));

// 1. Extract authoritative SHARED_TOOL_CSS variables & dvApi methods from dvot_host.html
const sharedCss = hostHtml.match(/const SHARED_TOOL_CSS = `([\s\S]*?)`;/)[1];
const sharedCssVars = new Set([...sharedCss.matchAll(/--([a-z0-9-]+)\s*:/gi)].map(m => '--' + m[1]));
const dvApiBlock = hostHtml.match(/const dvApi = \{([\s\S]*?)\n\s{8}\};/)[1];
const dvMethods = new Set(['version', 'esc', 'ui']);
for (const m of dvApiBlock.matchAll(/^\s{10}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(/gm)) dvMethods.add(m[1]);

const toolFiles = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.html')).sort();

// 2. Validate JS syntax across host, index, dev-server.js, and every tool
for (const rel of ['dvot_host.html', 'index.html']) {
  const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const scripts = [...txt.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  assert(scripts.length >= 1, `${rel} should contain inline <script>`);
  for (const s of scripts) new vm.Script(s, { filename: rel });
}
new vm.Script(fs.readFileSync(path.join(ROOT, 'dev-server', 'dev-server.js'), 'utf8'), { filename: 'dev-server.js' });
console.log('PASS: Host, Index, and dev-server.js JS syntax valid');

// 3. Validate every tool: script syntax, manifest JSON, zero undefined CSS vars, zero unknown DV.*, no top-level sync DV.onReady
for (const f of toolFiles) {
  const rel = path.join('tools', f);
  const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');

  const scripts = [...txt.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  assert(scripts.length >= 1, `${rel} missing <script>`);
  for (const s of scripts) new vm.Script(s, { filename: rel });

  if (f !== 'dvot_template.html') {
    const mm = txt.match(/<script[^>]+id=["']dvopentools-manifest["'][^>]*>([\s\S]*?)<\/script>/i);
    assert(mm, `${rel} missing dvopentools-manifest`);
    const meta = JSON.parse(mm[1]);
    assert(meta.id && meta.name && meta.category, `${rel} incomplete manifest metadata`);
  }

  const localVars = new Set([...txt.matchAll(/--([a-z0-9-]+)\s*:/gi)].map(m => '--' + m[1]));
  const usedVars = [...txt.matchAll(/var\((--[a-z0-9-]+)/gi)].map(m => m[1]);
  const missingVars = usedVars.filter(v => !sharedCssVars.has(v) && !localVars.has(v));
  assert.strictEqual(missingVars.length, 0, `${rel} uses undefined CSS vars: ${missingVars.join(', ')}`);

  const usedDv = [...new Set([...txt.matchAll(/\bDV\.([a-zA-Z0-9_]+)/g)].map(m => m[1]))];
  const unknownDv = usedDv.filter(m => !dvMethods.has(m));
  assert.strictEqual(unknownDv.length, 0, `${rel} calls unknown DV methods: ${unknownDv.join(', ')}`);

  assert(!/^\s*DV\.onReady\(/m.test(txt), `${rel} uses top-level sync DV.onReady() instead of TOOL_READY / CONTEXT_INIT`);
}
console.log(`PASS: All ${toolFiles.length} tools pass syntax, manifest, CSS token, DV SDK, and bootstrap checks`);

// 4. Exact manifest <-> index.html parity
const hostActualSize = fs.statSync(path.join(ROOT, 'dvot_host.html')).size;
const indexHostSize = Number(indexHtml.match(/const HOST_SIZE_BYTES = (\d+);/)[1]);
assert.strictEqual(indexHostSize, hostActualSize, `HOST_SIZE_BYTES mismatch: ${indexHostSize} !== ${hostActualSize}`);

const toolsArr = vm.runInNewContext(indexHtml.match(/const TOOLS = (\[[\s\S]*?\n    \]);/)[1]);
const devArr = vm.runInNewContext(indexHtml.match(/const DEV_SERVER_FILES = (\[[\s\S]*?\n    \]);/)[1]);
assert.strictEqual(toolsArr.length, manifest.length, `TOOLS count (${toolsArr.length}) !== manifest.json (${manifest.length})`);
for (const t of toolsArr) {
  const actual = fs.statSync(path.join(ROOT, t.file)).size;
  assert.strictEqual(t.sizeBytes, actual, `index.html size mismatch for ${t.file}: ${t.sizeBytes} !== ${actual}`);
  const mItem = manifest.find(m => m.id === t.id);
  assert(mItem && mItem.sizeBytes === actual, `manifest.json size mismatch for ${t.id}`);
}
for (const d of devArr) {
  const actual = fs.statSync(path.join(ROOT, d.path)).size;
  assert.strictEqual(d.sizeBytes, actual, `DEV_SERVER_FILES mismatch for ${d.path}: ${d.sizeBytes} !== ${actual}`);
}
console.log(`PASS: ${manifest.length}/${manifest.length} manifest, TOOLS, HOST_SIZE_BYTES, and DEV_SERVER_FILES exact byte parity`);

// 5. Dev-server MSCRMCallerID / CallerObjectId header forwarding presence
for (const f of ['dev-server/dev-server.js', 'dev-server/Program.cs', 'dev-server/dev-server.ps1']) {
  const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert(txt.includes('MSCRMCallerID') && txt.includes('CallerObjectId'), `${f} missing impersonation header forwarding`);
}
console.log('PASS: All 3 dev-servers include MSCRMCallerID and CallerObjectId');

// 6. Boot & CONTEXT_INIT smoke test across newest 9 tools
class FakeEl {
  constructor(id = '') {
    this.id = id; this.value = ''; this.checked = false; this.disabled = false;
    this.textContent = ''; this.innerHTML = ''; this.style = {}; this.dataset = {}; this.listeners = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  appendChild() {}
}

const recentTools = [
  'tools/dvot_personalviews.html',
  'tools/dvot_sql.html',
  'tools/dvot_fetchxmlbuilder.html',
  'tools/dvot_audithistory.html',
  'tools/dvot_fieldsecurity.html',
  'tools/dvot_customapi.html',
  'tools/dvot_solutioninspector.html',
  'tools/dvot_appsitemap.html',
  'tools/dvot_dataimporter.html'
];

(async () => {
  for (const rel of recentTools) {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const script = html.match(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/i)[1];
    const els = new Map();
    const handlers = [];
    const posted = [];
    const fetches = [];
    const mem = new Map();
    const ctx = {
      console, Math, Date, Map, Set, Promise, Uint8Array,
      Blob: function() {},
      URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
      encodeURIComponent, decodeURIComponent,
      atob: s => Buffer.from(s, 'base64').toString('binary'),
      location: { origin: 'https://org.crm.dynamics.com' },
      DOMParser: class { parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] }; } },
      XMLSerializer: class { serializeToString() { return '<fetch/>'; } },
      document: {
        getElementById: id => (els.has(id) ? els.get(id) : (els.set(id, new FakeEl(id)), els.get(id))),
        createElement: () => new FakeEl(),
        querySelectorAll: () => [],
        addEventListener() {}
      },
      DV: {
        esc: s => String(s ?? ''),
        notify() {}, copyText: async () => {}, exportCsv() {}, exportJson() {}, openTool() {}, setTitle() {},
        ui: { empty: s => s, error: s => s },
        store: () => ({ type: 'memory', get: (k, d = null) => (mem.has(k) ? mem.get(k) : d), set: (k, v) => mem.set(k, v) }),
        getEntityMap: async () => new Map([['account', { logicalName: 'account', entitySetName: 'accounts', displayName: 'Account', primaryId: 'accountid', primaryName: 'name' }]]),
        resolveEntitySet: async n => `${n}s`,
        fetchAll: async p => { fetches.push(p); return []; },
        fetchBatch: async p => { fetches.push(p); return { value: [] }; },
        async fetch(p) { fetches.push(p); return { value: [] }; }
      }
    };
    ctx.window = ctx;
    ctx.parent = { postMessage: msg => posted.push(msg) };
    ctx.addEventListener = (ev, fn) => { if (ev === 'message') handlers.push(fn); };

    vm.runInNewContext(script, ctx);
    assert(posted.some(m => m.type === 'TOOL_READY'), `${rel} must post TOOL_READY`);
    for (const fn of handlers) {
      await fn({ origin: 'https://org.crm.dynamics.com', data: { source: 'dvopentools-host', type: 'CONTEXT_INIT', payload: { environmentUrl: 'https://org.crm.dynamics.com', apiVersion: '9.2' } } });
    }
  }
  console.log(`PASS: All ${recentTools.length} recent tools complete TOOL_READY -> CONTEXT_INIT handshake`);
})();
