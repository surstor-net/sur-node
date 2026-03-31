// covia-adapter.js — SurStor Grid backend
// Replicates PROVENANCE (sur-link records) to a Covia venue via /api/v1/ HTTP API.
// Artifacts stay in DLFS. Covia stores provenance, not content.
//
// Architecture:
//   DLFS  — artifact content + metadata (always, local source of truth)
//   Covia — sur-link provenance records → :grid/:meta CASLattice (Grid mode only)
//
// SurStor Personal: COVIA_URL not set → DLFS only
// SurStor Grid:     COVIA_URL set     → DLFS artifacts + Covia provenance
//
// Env vars:
//   COVIA_URL    e.g. http://hostname:port   (required to enable Grid mode)
//   COVIA_TOKEN  Bearer token                (optional)

import http from 'http';
import https from 'https';

const COVIA_URL   = process.env.COVIA_URL   || null;
const COVIA_TOKEN = process.env.COVIA_TOKEN || null;

export function coviaEnabled() {
  return !!COVIA_URL;
}

// Raw HTTP request — mirrors the DLFS dlfsRequest pattern in index.js
function coviaRequest(method, path, bodyStr, contentType) {
  return new Promise((resolve, reject) => {
    const url    = new URL(`/api/v1/${path}`, COVIA_URL);
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method,
      headers: {
        'Connection': 'close',
        ...(COVIA_TOKEN && { 'Authorization': `Bearer ${COVIA_TOKEN}` }),
        ...(bodyBuf && {
          'Content-Type':   contentType || 'application/json',
          'Content-Length': bodyBuf.length
        })
      }
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(opts, res => {
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

// Store a JSON record as a Covia asset.
// Returns the Covia venue hash (hex string) assigned by the venue.
// Our sha256: hash remains the primary key — this is the distributed copy.
export async function coviaStoreAsset(jsonStr) {
  const r = await coviaRequest('POST', 'assets', jsonStr, 'application/json');
  if (r.status !== 201) throw new Error(`Covia storeAsset failed: ${r.status} ${r.body}`);
  // Venue returns the Convex hash as a JSON string e.g. "0xabc..." or bare hex
  return r.body.trim().replace(/^"|"$/g, '');
}

// Retrieve a Covia asset by its venue hex hash. Returns JSON string or null.
export async function coviaGetAsset(hexHash) {
  const r = await coviaRequest('GET', `assets/${hexHash}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`Covia getAsset failed: ${r.status} ${r.body}`);
  return r.body;
}

// List all asset hashes from the venue (used for rebuild).
export async function coviaListAssets() {
  const r = await coviaRequest('GET', 'assets');
  if (r.status !== 200) throw new Error(`Covia listAssets failed: ${r.status}`);
  const body = JSON.parse(r.body);
  // Venue returns either an array or {items: [...], total: n}
  const items = Array.isArray(body) ? body : (body.items || []);
  return items.map(h => String(h));
}

// Invoke an operation on the venue. Returns a job object.
// op: operation asset ID or adapter alias (e.g. "grid:run")
// input: plain JS object — will be JSON-serialised
export async function coviaInvoke(op, input) {
  const body = JSON.stringify({ operation: op, input });
  const r = await coviaRequest('POST', 'invoke', body, 'application/json');
  if (r.status !== 201) throw new Error(`Covia invoke failed: ${r.status} ${r.body}`);
  return JSON.parse(r.body);
}

// Poll job status by ID.
export async function coviaJobStatus(jobId) {
  const r = await coviaRequest('GET', `jobs/${jobId}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`Covia jobStatus failed: ${r.status}`);
  return JSON.parse(r.body);
}

// Ping the venue — returns true if reachable.
export async function coviaPing() {
  try {
    const r = await coviaRequest('GET', 'status');
    return r.status === 200;
  } catch {
    return false;
  }
}
