#!/usr/bin/env node
// sur-rest.js — SurStor REST API server
// Exposes all SurStor operations over HTTP/JSON for ChatGPT, Gemini, and any HTTP client.
//
// Env vars:
//   SURSTOR_API_KEY   required — Bearer token / X-SurStor-Key header value
//   SURSTOR_PORT      optional — port to listen on (default 3000)
//   DLFS_URL          optional — DLFS server URL (default http://127.0.0.1:8765)
//   COVIA_URL         optional — Covia venue URL (activates Grid mode)
//   COVIA_TOKEN       optional — Covia Bearer token
//
// Start: node sur-rest.js
// Docs:  openapi.yaml (Swagger UI at /api/v1/docs when running)

import http from 'http';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { coviaEnabled, coviaStoreAsset, coviaListAssets, coviaGetAsset } from './covia-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = join(__dirname, 'store.db');
const PORT      = parseInt(process.env.SURSTOR_PORT || '3000', 10);
const API_KEY   = process.env.SURSTOR_API_KEY || null;

if (!API_KEY) {
  console.error('ERROR: SURSTOR_API_KEY env var is required');
  process.exit(1);
}

const DLFS_URL       = process.env.DLFS_URL || 'http://127.0.0.1:8765';
const DLFS_ARTIFACTS = `${DLFS_URL}/dlfs/home/artifacts`;
const DLFS_META      = `${DLFS_URL}/dlfs/home/meta`;

// ── SQLite ────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS artifacts (
    hash       TEXT PRIMARY KEY,
    label      TEXT,
    tags       TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    size       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_created ON artifacts(created_at DESC);

  CREATE TABLE IF NOT EXISTS links (
    link_hash  TEXT NOT NULL,
    from_hash  TEXT NOT NULL,
    to_hash    TEXT NOT NULL,
    rel        TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_hash);
  CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_hash);
`);

// ── DLFS helpers ──────────────────────────────────────────────────────────────

function dlfsRequest(method, url, body, contentType) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const bodyBuf = body ? Buffer.from(body, 'utf8') : null;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname,
      method,
      headers: {
        'Connection': 'close',
        ...(contentType && { 'Content-Type': contentType }),
        ...(bodyBuf    && { 'Content-Length': bodyBuf.length })
      }
    };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data',  c  => chunks.push(c));
      res.on('end',   () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function hex(hash) { return hash.replace('sha256:', ''); }
function contentHash(content) {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

async function dlfsEnsureDirs() {
  for (const url of [DLFS_ARTIFACTS + '/', DLFS_META + '/']) {
    await dlfsRequest('MKCOL', url);
  }
}

async function dlfsPutContent(hash, content) {
  const r = await dlfsRequest('PUT', `${DLFS_ARTIFACTS}/${hex(hash)}`, content, 'text/plain; charset=utf-8');
  if (r.status >= 400 && r.status !== 409) throw new Error(`DLFS content PUT failed: ${r.status}`);
}

async function dlfsPutMeta(hash, meta) {
  const r = await dlfsRequest('PUT', `${DLFS_META}/${hex(hash)}.json`, JSON.stringify(meta), 'application/json');
  if (r.status >= 400 && r.status !== 409) throw new Error(`DLFS meta PUT failed: ${r.status}`);
}

async function dlfsGetContent(hash) {
  const r = await dlfsRequest('GET', `${DLFS_ARTIFACTS}/${hex(hash)}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`DLFS content GET failed: ${r.status}`);
  return r.body;
}

async function dlfsGetMeta(hash) {
  const r = await dlfsRequest('GET', `${DLFS_META}/${hex(hash)}.json`);
  if (r.status !== 200) return null;
  return JSON.parse(r.body);
}

// ── Core operations ───────────────────────────────────────────────────────────

async function store(content, label, tags) {
  const hash     = contentHash(content);
  const now      = Date.now();
  const size     = Buffer.byteLength(content, 'utf8');
  const meta     = { hash, label: label || null, tags, created_at: now, size };
  const existing = db.prepare('SELECT created_at FROM artifacts WHERE hash = ?').get(hash);

  if (!existing) {
    await dlfsPutContent(hash, content);
    await dlfsPutMeta(hash, meta);
    db.prepare('INSERT INTO artifacts (hash, label, tags, created_at, size) VALUES (?, ?, ?, ?, ?)')
      .run(hash, meta.label, JSON.stringify(tags), now, size);
  }

  return { hash, size, stored_at: new Date(existing ? existing.created_at : now).toISOString(), deduplicated: !!existing };
}

async function rebuild() {
  const r = await dlfsRequest('PROPFIND', DLFS_META + '/', null, null);
  if (r.status !== 207 && r.status !== 200) throw new Error(`PROPFIND failed: ${r.status}`);

  const metaFiles = [...r.body.matchAll(/<D:href>([^<]*\.json)<\/D:href>/g)].map(m => m[1]);
  db.prepare('DELETE FROM artifacts').run();
  let count = 0;

  for (const href of metaFiles) {
    const mr = await dlfsRequest('GET', `${DLFS_URL}${href}`);
    if (mr.status !== 200) continue;
    const meta = JSON.parse(mr.body);
    db.prepare('INSERT OR REPLACE INTO artifacts (hash, label, tags, created_at, size) VALUES (?, ?, ?, ?, ?)')
      .run(meta.hash, meta.label, JSON.stringify(meta.tags), meta.created_at, meta.size);
    count++;
  }

  if (coviaEnabled()) {
    try {
      db.prepare('DELETE FROM links').run();
      const hashes = await coviaListAssets();
      for (const coviaHex of hashes) {
        const jsonStr = await coviaGetAsset(coviaHex);
        if (!jsonStr) continue;
        let record;
        try { record = JSON.parse(jsonStr); } catch { continue; }
        if (record.type !== 'sur-link') continue;
        const targets = Array.isArray(record.to) ? record.to : [record.to];
        const ts      = record.created_at ? new Date(record.created_at).getTime() : Date.now();
        const stmt    = db.prepare('INSERT OR IGNORE INTO links (link_hash, from_hash, to_hash, rel, created_at) VALUES (?, ?, ?, ?, ?)');
        for (const target of targets) stmt.run(record.hash || coviaHex, record.from, target, record.rel || 'derived-from', ts);
        count++;
      }
    } catch (err) {
      process.stderr.write(`[covia] rebuild partial: ${err.message}\n`);
    }
  }

  return count;
}

function walkTree(startHash, direction, maxDepth) {
  const visited = new Set();
  function walk(h, currentDepth) {
    if (currentDepth > maxDepth || visited.has(h)) return null;
    visited.add(h);
    const meta = db.prepare('SELECT label FROM artifacts WHERE hash = ?').get(h);
    const rows = direction === 'up'
      ? db.prepare('SELECT to_hash AS next, rel FROM links WHERE from_hash = ?').all(h)
      : db.prepare('SELECT from_hash AS next, rel FROM links WHERE to_hash = ?').all(h);
    return {
      hash:     h,
      label:    meta ? meta.label : null,
      depth:    currentDepth,
      children: rows.map(r => walk(r.next, currentDepth + 1)).filter(Boolean).map((child, i) => ({ ...child, rel: rows[i].rel }))
    };
  }
  return walk(startHash, 0);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Content-Length':              Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'Authorization, X-SurStor-Key, Content-Type'
  });
  res.end(json);
}

function err(res, status, message) {
  send(res, status, { error: message });
}

function auth(req, res) {
  const key = req.headers['x-surstor-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (key !== API_KEY) { err(res, 401, 'Invalid or missing API key'); return false; }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseHash(raw) {
  // Accept both "sha256:abc..." and bare hex
  if (!raw) return null;
  return raw.startsWith('sha256:') ? raw : `sha256:${raw}`;
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, X-SurStor-Key, Content-Type'
    });
    return res.end();
  }

  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname.replace(/\/$/, '');
  const method = req.method;

  try {
    // ── Health (no auth) ───────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/v1/health') {
      return send(res, 200, {
        status:  'ok',
        version: '0.3.0',
        dlfs:    DLFS_URL,
        covia:   coviaEnabled() ? 'enabled' : 'disabled'
      });
    }

    // ── Docs (no auth) ────────────────────────────────────────────────────
    if (method === 'GET' && path === '/docs') {
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>SurStor API</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  SwaggerUIBundle({
    url: '/openapi.yaml',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    deepLinking: true
  });
</script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      return res.end(html);
    }

    if (method === 'GET' && path === '/openapi.yaml') {
      const spec = readFileSync(join(__dirname, 'openapi.yaml'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/yaml', 'Access-Control-Allow-Origin': '*' });
      return res.end(spec);
    }

    // Auth required for all other routes
    if (!auth(req, res)) return;

    // ── Artifacts ──────────────────────────────────────────────────────────

    // GET /api/v1/artifacts
    if (method === 'GET' && path === '/api/v1/artifacts') {
      const tag   = url.searchParams.get('tag');
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const rows  = tag
        ? db.prepare('SELECT hash, label, tags, created_at, size FROM artifacts WHERE tags LIKE ? ORDER BY created_at DESC LIMIT ?').all(`%"${tag}"%`, limit)
        : db.prepare('SELECT hash, label, tags, created_at, size FROM artifacts ORDER BY created_at DESC LIMIT ?').all(limit);
      return send(res, 200, rows.map(r => ({
        hash:       r.hash,
        label:      r.label,
        tags:       JSON.parse(r.tags),
        created_at: new Date(r.created_at).toISOString(),
        size:       r.size
      })));
    }

    // POST /api/v1/artifacts
    if (method === 'POST' && path === '/api/v1/artifacts') {
      const body = await readBody(req);
      if (!body.content) return err(res, 400, 'content is required');
      const result = await store(body.content, body.label || null, body.tags || []);
      return send(res, result.deduplicated ? 200 : 201, { label: body.label || null, ...result });
    }

    // GET /api/v1/artifacts/:hash
    const artifactMatch = path.match(/^\/api\/v1\/artifacts\/(.+)$/);
    if (method === 'GET' && artifactMatch) {
      const hash = parseHash(decodeURIComponent(artifactMatch[1]));
      let meta   = db.prepare('SELECT * FROM artifacts WHERE hash = ?').get(hash);
      if (!meta) {
        const dlfsMeta = await dlfsGetMeta(hash);
        if (!dlfsMeta) return err(res, 404, 'Artifact not found');
        meta = { ...dlfsMeta, tags: JSON.stringify(dlfsMeta.tags) };
      }
      const content = await dlfsGetContent(hash);
      if (content === null) return err(res, 404, 'Artifact content not found in DLFS');
      return send(res, 200, {
        hash:       meta.hash,
        label:      meta.label,
        tags:       typeof meta.tags === 'string' ? JSON.parse(meta.tags) : meta.tags,
        created_at: new Date(meta.created_at).toISOString(),
        size:       meta.size,
        content
      });
    }

    // ── Snapshots ──────────────────────────────────────────────────────────

    // POST /api/v1/snapshots
    if (method === 'POST' && path === '/api/v1/snapshots') {
      const body = await readBody(req);
      if (!body.label)   return err(res, 400, 'label is required');
      if (!body.summary) return err(res, 400, 'summary is required');
      const now      = Date.now();
      const artifact = JSON.stringify({
        type:       'session-snapshot',
        label:      body.label,
        summary:    body.summary,
        snapped_at: new Date(now).toISOString()
      }, null, 2);
      const allTags = ['session-snapshot', ...(body.tags || [])];
      const result  = await store(artifact, body.label, allTags);
      return send(res, result.deduplicated ? 200 : 201, {
        ...result,
        label:   body.label,
        tags:    allTags,
        backend: DLFS_URL
      });
    }

    // ── Links ──────────────────────────────────────────────────────────────

    // POST /api/v1/links
    if (method === 'POST' && path === '/api/v1/links') {
      const body    = await readBody(req);
      if (!body.from) return err(res, 400, 'from is required');
      if (!body.to)   return err(res, 400, 'to is required');
      const from    = parseHash(body.from);
      const targets = (Array.isArray(body.to) ? body.to : [body.to]).map(parseHash);
      const rel     = body.rel || 'derived-from';
      const note    = body.note || null;
      const now     = Date.now();

      const record = JSON.stringify({
        type:       'sur-link',
        from,
        to:         targets,
        rel,
        created_at: new Date(now).toISOString(),
        ...(note && { note })
      }, null, 2);

      const result = await store(record, `link:${rel}:${from.slice(0, 16)}`, ['sur-link', `rel:${rel}`]);
      const stmt   = db.prepare('INSERT INTO links (link_hash, from_hash, to_hash, rel, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const target of targets) stmt.run(result.hash, from, target, rel, now);

      if (coviaEnabled()) {
        coviaStoreAsset(record).catch(e =>
          process.stderr.write(`[covia] sur-link replication failed for ${result.hash}: ${e.message}\n`)
        );
      }

      return send(res, 201, { link_hash: result.hash, from, to: targets, rel, created_at: new Date(now).toISOString(), ...(note && { note }) });
    }

    // GET /api/v1/links/:hash
    const linksMatch = path.match(/^\/api\/v1\/links\/(.+)$/);
    if (method === 'GET' && linksMatch) {
      const hash = parseHash(decodeURIComponent(linksMatch[1]));
      const dir  = url.searchParams.get('dir') || 'out';
      const rel  = url.searchParams.get('rel') || null;

      const relFilter = rel ? ' AND rel = ?' : '';
      const outRows   = (dir === 'out' || dir === 'both')
        ? db.prepare(`SELECT link_hash, to_hash AS target, rel, created_at FROM links WHERE from_hash = ?${relFilter} ORDER BY created_at DESC`).all(...[hash, ...(rel ? [rel] : [])])
        : [];
      const inRows    = (dir === 'in' || dir === 'both')
        ? db.prepare(`SELECT link_hash, from_hash AS source, rel, created_at FROM links WHERE to_hash = ?${relFilter} ORDER BY created_at DESC`).all(...[hash, ...(rel ? [rel] : [])])
        : [];

      return send(res, 200, {
        hash,
        out: outRows.map(r => ({ link_hash: r.link_hash, to:   r.target, rel: r.rel, created_at: new Date(r.created_at).toISOString() })),
        in:  inRows.map(r  => ({ link_hash: r.link_hash, from: r.source, rel: r.rel, created_at: new Date(r.created_at).toISOString() }))
      });
    }

    // ── Tree ───────────────────────────────────────────────────────────────

    // GET /api/v1/tree/:hash
    const treeMatch = path.match(/^\/api\/v1\/tree\/(.+)$/);
    if (method === 'GET' && treeMatch) {
      const hash  = parseHash(decodeURIComponent(treeMatch[1]));
      const dir   = url.searchParams.get('dir')   || 'up';
      const depth = parseInt(url.searchParams.get('depth') || '10', 10);
      const tree  = walkTree(hash, dir, depth);
      return send(res, 200, { root: hash, dir, tree });
    }

    // ── Admin ──────────────────────────────────────────────────────────────

    // POST /api/v1/admin/rebuild
    if (method === 'POST' && path === '/api/v1/admin/rebuild') {
      const count = await rebuild();
      return send(res, 200, {
        rebuilt: count,
        source:  DLFS_URL,
        covia:   coviaEnabled() ? 'enabled' : 'disabled',
        message: `SQLite index rebuilt — ${count} artifact${count !== 1 ? 's' : ''} restored`
      });
    }

    // 404
    err(res, 404, `No route: ${method} ${path}`);

  } catch (e) {
    process.stderr.write(`[sur-rest] ${e.message}\n`);
    err(res, 500, e.message);
  }
});

await dlfsEnsureDirs();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SurStor REST API running on http://0.0.0.0:${PORT}/api/v1/`);
  console.log(`DLFS: ${DLFS_URL}  |  Covia: ${coviaEnabled() ? process.env.COVIA_URL : 'disabled'}`);
  console.log(`Auth: X-SurStor-Key header required`);
});
