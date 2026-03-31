#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { coviaEnabled, coviaStoreAsset, coviaGetAsset, coviaListAssets } from './covia-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'store.db');

// DLFS — local source of truth for everything
const DLFS_URL       = process.env.DLFS_URL || 'http://127.0.0.1:8765';
const DLFS_ARTIFACTS = `${DLFS_URL}/dlfs/home/artifacts`;
const DLFS_META      = `${DLFS_URL}/dlfs/home/meta`;

// SQLite — local query cache, fully rebuildable from DLFS
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

function contentHash(content) {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

function hex(hash) {
  return hash.replace('sha256:', '');
}

// DLFS operations — use http module directly to avoid undici IPv6/keep-alive issues with Jetty
function dlfsRequest(method, url, body, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyBuf = body ? Buffer.from(body, 'utf8') : null;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method,
      headers: {
        'Connection': 'close',
        ...(contentType && { 'Content-Type': contentType }),
        ...(bodyBuf && { 'Content-Length': bodyBuf.length })
      }
    };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function dlfsEnsureDirs() {
  for (const url of [DLFS_ARTIFACTS + '/', DLFS_META + '/']) {
    await dlfsRequest('MKCOL', url);
    // 201 = created, 405 = already exists — both fine
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
  if (r.status !== 200) throw new Error(`DLFS content GET failed: ${r.status}`);
  return r.body;
}

async function dlfsGetMeta(hash) {
  const r = await dlfsRequest('GET', `${DLFS_META}/${hex(hash)}.json`);
  if (r.status !== 200) return null;
  return JSON.parse(r.body);
}

// Core store — writes to DLFS (local source of truth) + Covia (distributed, if enabled) then SQLite (cache)
async function store(content, label, tags) {
  const hash = contentHash(content);
  const now = Date.now();
  const size = Buffer.byteLength(content, 'utf8');
  const meta = { hash, label: label || null, tags, created_at: now, size };

  const existing = db.prepare('SELECT created_at FROM artifacts WHERE hash = ?').get(hash);
  if (!existing) {
    await dlfsPutContent(hash, content);
    await dlfsPutMeta(hash, meta);
    db.prepare('INSERT INTO artifacts (hash, label, tags, created_at, size) VALUES (?, ?, ?, ?, ?)')
      .run(hash, meta.label, JSON.stringify(tags), now, size);

    // Replicate to Covia venue if configured — fire-and-forget, DLFS remains source of truth
    if (coviaEnabled()) {
      coviaStoreAsset(content).catch(err =>
        process.stderr.write(`[covia] store failed for ${hash}: ${err.message}\n`)
      );
    }
  }

  return {
    hash,
    size,
    stored_at: new Date(existing ? existing.created_at : now).toISOString(),
    deduplicated: !!existing
  };
}

// Rebuild SQLite index from DLFS (always) + Covia (if enabled)
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

  // If Covia is enabled, also pull any assets not in DLFS (cross-venue artifacts)
  if (coviaEnabled()) {
    try {
      const hashes = await coviaListAssets();
      for (const coviaHex of hashes) {
        const jsonStr = await coviaGetAsset(coviaHex);
        if (!jsonStr) continue;
        let record;
        try { record = JSON.parse(jsonStr); } catch { continue; }
        if (!record.hash) continue; // not a sur-node artifact
        const exists = db.prepare('SELECT 1 FROM artifacts WHERE hash = ?').get(record.hash);
        if (!exists) {
          db.prepare('INSERT OR REPLACE INTO artifacts (hash, label, tags, created_at, size) VALUES (?, ?, ?, ?, ?)')
            .run(record.hash, record.label || null, JSON.stringify(record.tags || []), record.created_at || Date.now(), record.size || 0);
          count++;
        }
      }
    } catch (err) {
      process.stderr.write(`[covia] rebuild partial: ${err.message}\n`);
    }
  }

  return count;
}

// MCP Server
const server = new Server(
  { name: 'surstor', version: '0.3.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'sur_store',
      description: 'Store any artifact in DLFS (content + metadata). Returns a content-addressed hash. Identical content always returns the same hash.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The content to store' },
          label:   { type: 'string', description: 'Human-readable label' },
          tags:    { type: 'array', items: { type: 'string' }, description: 'Tags for discovery' }
        },
        required: ['content']
      }
    },
    {
      name: 'sur_get',
      description: 'Retrieve an artifact from DLFS by its sha256: hash.',
      inputSchema: {
        type: 'object',
        properties: {
          hash: { type: 'string', description: 'The sha256: hash' }
        },
        required: ['hash']
      }
    },
    {
      name: 'sur_snap',
      description: 'Snapshot this conversation into DLFS — stores content + metadata. Returns a hash and a ready-to-paste MEMORY.md entry.',
      inputSchema: {
        type: 'object',
        properties: {
          label:   { type: 'string', description: 'Short session label' },
          summary: { type: 'string', description: 'Full session summary: topics, decisions, artifacts, next steps' },
          tags:    { type: 'array', items: { type: 'string' }, description: 'Topic tags' }
        },
        required: ['label', 'summary']
      }
    },
    {
      name: 'sur_list',
      description: 'List artifacts from local SQLite cache, newest first. Optionally filter by tag.',
      inputSchema: {
        type: 'object',
        properties: {
          tag:   { type: 'string', description: 'Filter by tag' },
          limit: { type: 'number', description: 'Max results (default 20)' }
        }
      }
    },
    {
      name: 'sur_rebuild',
      description: 'Rebuild the local SQLite index from DLFS — the source of truth. Run this if the index is lost or out of sync.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'sur-link',
      description: 'Create a provenance link between artifacts. Records that one artifact was derived-from, references, supersedes, corrects, or responds-to others.',
      inputSchema: {
        type: 'object',
        properties: {
          from:  { type: 'string', description: 'Hash of the artifact doing the linking' },
          to:    { description: 'Hash or array of hashes being linked to', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          rel:   { type: 'string', description: 'Relationship type: derived-from (default), references, supersedes, corrects, responds-to' },
          note:  { type: 'string', description: 'Optional human note about why this link exists' }
        },
        required: ['from', 'to']
      }
    },
    {
      name: 'sur-links',
      description: 'Query links for an artifact — what it points to (out), what points to it (in), or both.',
      inputSchema: {
        type: 'object',
        properties: {
          hash: { type: 'string', description: 'The artifact hash to query' },
          dir:  { type: 'string', description: 'Direction: out (default), in, or both' },
          rel:  { type: 'string', description: 'Optional: filter by relationship type' }
        },
        required: ['hash']
      }
    },
    {
      name: 'sur-tree',
      description: 'Walk the full provenance tree from an artifact — all ancestors (up) or descendants (down).',
      inputSchema: {
        type: 'object',
        properties: {
          hash:  { type: 'string', description: 'The artifact hash to start from' },
          dir:   { type: 'string', description: 'Direction: up = ancestors (default), down = descendants' },
          depth: { type: 'number', description: 'Max hops to traverse (default 10)' }
        },
        required: ['hash']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'sur_store') {
      const { content, label = null, tags = [] } = args;
      const result = await store(content, label, tags);
      return { content: [{ type: 'text', text: JSON.stringify({ label, ...result, backend: DLFS_URL, covia: coviaEnabled() ? 'enabled' : 'disabled' }, null, 2) }] };
    }

    if (name === 'sur_get') {
      const { hash } = args;
      // Metadata: SQLite first (fast), fall back to DLFS
      let meta = db.prepare('SELECT * FROM artifacts WHERE hash = ?').get(hash);
      if (!meta) {
        const dlfsMeta = await dlfsGetMeta(hash);
        if (!dlfsMeta) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'not found', hash }) }] };
        meta = { ...dlfsMeta, tags: JSON.stringify(dlfsMeta.tags) };
      }
      const content = await dlfsGetContent(hash);
      return { content: [{ type: 'text', text: JSON.stringify({
        hash: meta.hash,
        label: meta.label,
        tags: typeof meta.tags === 'string' ? JSON.parse(meta.tags) : meta.tags,
        created_at: new Date(meta.created_at).toISOString(),
        size: meta.size,
        backend: DLFS_URL,
        content
      }, null, 2) }] };
    }

    if (name === 'sur_snap') {
      const { label, summary, tags = [] } = args;
      const now = Date.now();
      const artifact = JSON.stringify({
        type: 'session-snapshot',
        label,
        summary,
        snapped_at: new Date(now).toISOString()
      }, null, 2);

      const allTags = ['session-snapshot', ...tags];
      const result = await store(artifact, label, allTags);
      const date = new Date(now).toISOString().split('T')[0];

      return { content: [{ type: 'text', text: JSON.stringify({
        ...result,
        label,
        tags: allTags,
        backend: DLFS_URL,
        memory_entry: `- [${label}](${result.hash}) — session snapshot ${date}`
      }, null, 2) }] };
    }

    if (name === 'sur_list') {
      const { tag = null, limit = 20 } = args;
      const rows = tag
        ? db.prepare('SELECT hash, label, tags, created_at, size FROM artifacts WHERE tags LIKE ? ORDER BY created_at DESC LIMIT ?').all(`%"${tag}"%`, limit)
        : db.prepare('SELECT hash, label, tags, created_at, size FROM artifacts ORDER BY created_at DESC LIMIT ?').all(limit);

      return { content: [{ type: 'text', text: JSON.stringify(
        rows.map(r => ({ hash: r.hash, label: r.label, tags: JSON.parse(r.tags), created_at: new Date(r.created_at).toISOString(), size: r.size })),
        null, 2
      ) }] };
    }

    if (name === 'sur_rebuild') {
      const count = await rebuild();
      return { content: [{ type: 'text', text: JSON.stringify({
        rebuilt: count,
        source: DLFS_URL,
        covia: coviaEnabled() ? 'enabled' : 'disabled',
        message: `SQLite index rebuilt — ${count} artifact${count !== 1 ? 's' : ''} restored`
      }, null, 2) }] };
    }

    if (name === 'sur-link') {
      const { from, to, rel = 'derived-from', note = null } = args;
      const targets = Array.isArray(to) ? to : [to];
      const now = Date.now();

      const record = JSON.stringify({
        type: 'sur-link',
        from,
        to: targets,
        rel,
        created_at: new Date(now).toISOString(),
        ...(note && { note })
      }, null, 2);

      const result = await store(record, `link:${rel}:${from.slice(0, 16)}`, ['sur-link', `rel:${rel}`]);

      const stmt = db.prepare('INSERT INTO links (link_hash, from_hash, to_hash, rel, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const target of targets) {
        stmt.run(result.hash, from, target, rel, now);
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        link_hash: result.hash,
        from,
        to: targets,
        rel,
        created_at: new Date(now).toISOString(),
        ...(note && { note })
      }, null, 2) }] };
    }

    if (name === 'sur-links') {
      const { hash, dir = 'out', rel = null } = args;

      const relFilter = rel ? ' AND rel = ?' : '';
      const outRows = (dir === 'out' || dir === 'both')
        ? db.prepare(`SELECT link_hash, to_hash AS target, rel, created_at FROM links WHERE from_hash = ?${relFilter} ORDER BY created_at DESC`).all(...[hash, ...(rel ? [rel] : [])])
        : [];
      const inRows = (dir === 'in' || dir === 'both')
        ? db.prepare(`SELECT link_hash, from_hash AS source, rel, created_at FROM links WHERE to_hash = ?${relFilter} ORDER BY created_at DESC`).all(...[hash, ...(rel ? [rel] : [])])
        : [];

      return { content: [{ type: 'text', text: JSON.stringify({
        hash,
        out: outRows.map(r => ({ link_hash: r.link_hash, to: r.target, rel: r.rel, created_at: new Date(r.created_at).toISOString() })),
        in:  inRows.map(r => ({ link_hash: r.link_hash, from: r.source, rel: r.rel, created_at: new Date(r.created_at).toISOString() }))
      }, null, 2) }] };
    }

    if (name === 'sur-tree') {
      const { hash, dir = 'up', depth = 10 } = args;

      function walkTree(startHash, direction, maxDepth) {
        const visited = new Set();
        function walk(h, currentDepth) {
          if (currentDepth > maxDepth || visited.has(h)) return null;
          visited.add(h);

          const meta = db.prepare('SELECT label FROM artifacts WHERE hash = ?').get(h);
          const label = meta ? meta.label : null;

          const rows = direction === 'up'
            ? db.prepare('SELECT to_hash AS next, rel FROM links WHERE from_hash = ?').all(h)
            : db.prepare('SELECT from_hash AS next, rel FROM links WHERE to_hash = ?').all(h);

          return {
            hash: h,
            label,
            depth: currentDepth,
            children: rows.map(r => walk(r.next, currentDepth + 1)).filter(Boolean).map((child, i) => ({ ...child, rel: rows[i].rel }))
          };
        }
        return walk(startHash, 0);
      }

      const tree = walkTree(hash, dir, depth);
      return { content: [{ type: 'text', text: JSON.stringify({ root: hash, dir, tree }, null, 2) }] };
    }

    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };

  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message, tool: name }) }] };
  }
});

await dlfsEnsureDirs();
const transport = new StdioServerTransport();
await server.connect(transport);
