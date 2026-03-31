# sur-link Design Spec

**Status:** Draft
**Date:** 2026-03-29
**Author:** SurStor team

---

## What Problem This Solves

Right now every SurStor artifact is an island. You can store a session snap, retrieve it by hash, and list what you have — but there is no way to say "this thing came from those things."

That matters because:

- An agent writing a whitepaper draft should be able to say "this draft was derived from these 5 source snaps"
- A future agent reading that draft should be able to walk backward and see everything that fed into it
- When something changes upstream, you can find what downstream artifacts may now be stale

Without links, SurStor is a key-value store. With links, it's a knowledge graph.

---

## Two Tiers, One Interface

**SurStor Personal:** Link records stored directly in DLFS. Works standalone, no Covia required. Good for individuals and small teams.

**SurStor Grid:** Same API call, but the link record is replicated to a Covia venue — with DID identity, CRDT merge semantics, distributed venue state, and cryptographic verification. Good for enterprise, multi-org, compliance use cases.

The agent calling `sur-link` doesn't need to know which backend is active. Same call, same response shape, different power underneath.

---

## Data Model

### Link Record

A link record is itself a content-addressed artifact stored in DLFS, just like any other artifact. Its content is JSON:

```json
{
  "type": "sur-link",
  "from": "sha256:abc123...",
  "to": [
    "sha256:def456...",
    "sha256:ghi789..."
  ],
  "rel": "derived-from",
  "created_at": "2026-03-29T19:00:00.000Z",
  "note": "optional human note about why this link exists"
}
```

Stored with tags: `["sur-link", "rel:derived-from"]` for easy querying.

### Relationship Types

| rel | Meaning |
|-----|---------|
| `derived-from` | This artifact was produced using those artifacts as input |
| `references` | This artifact cites or mentions those artifacts |
| `supersedes` | This artifact replaces those artifacts (they're outdated) |
| `corrects` | This artifact fixes an error in that artifact |
| `responds-to` | This artifact is a reply or reaction to that artifact |

Custom rel values are allowed — these are the standard ones.

### Index

The SQLite cache gets a `links` table so link traversal doesn't require hitting DLFS every time:

```sql
CREATE TABLE IF NOT EXISTS links (
  link_hash  TEXT NOT NULL,        -- hash of the link record itself
  from_hash  TEXT NOT NULL,        -- the artifact doing the linking
  to_hash    TEXT NOT NULL,        -- an artifact being linked to
  rel        TEXT NOT NULL,        -- relationship type
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_hash);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_hash);
```

One row per `from → to` pair (a link with 3 targets creates 3 rows, all sharing the same `link_hash`).

---

## MCP Tools

### `sur-link`

Create a link between artifacts.

```
sur-link(
  from: "sha256:abc...",           required — the artifact doing the linking
  to: ["sha256:def...", ...],      required — one or more targets (array or single string)
  rel: "derived-from",             optional — default: "derived-from"
  note: "why this link exists"     optional
)
```

**Returns:**
```json
{
  "link_hash": "sha256:xyz...",
  "from": "sha256:abc...",
  "to": ["sha256:def...", "sha256:ghi..."],
  "rel": "derived-from",
  "created_at": "2026-03-29T19:00:00.000Z"
}
```

---

### `sur-links`

Query links for an artifact — what does it point to, or what points to it.

```
sur-links(
  hash: "sha256:abc...",    required — the artifact to query
  dir: "out",               optional — "out" (default), "in", or "both"
  rel: "derived-from"       optional — filter by relationship type
)
```

**Returns:**
```json
{
  "hash": "sha256:abc...",
  "out": [
    {
      "link_hash": "sha256:xyz...",
      "to": "sha256:def...",
      "rel": "derived-from",
      "created_at": "2026-03-29T19:00:00.000Z"
    }
  ],
  "in": []
}
```

---

### `sur-tree`

Walk the full provenance tree from a given artifact. Returns the entire DAG of ancestors or descendants.

```
sur-tree(
  hash: "sha256:abc...",    required
  dir: "up",                optional — "up" (ancestors), "down" (descendants), default "up"
  depth: 5                  optional — max hops, default 10
)
```

**Returns:** Nested tree structure with each node's hash, label, rel to parent, and depth.

---

## SurStor Grid — Covia Adapter Interface

When `COVIA_URL` is set (SurStor Grid mode), `sur-link` replicates to the Covia venue:

```
Job {
  op:     <sur-link operation asset>
  input:  { from, to, rel, note }
  output: { link_hash, ... }
  status: COMPLETE
}
```

The link record is stored in Covia's `VenueLattice` storage (backed by DLFSStorage) and replicated across venues per Covia's CRDT merge rules.

The SQLite index is still maintained locally for fast traversal — it just gets populated from Covia records instead of directly from DLFS.

**Interface contract both backends must satisfy:**

```
createLink(from, to[], rel, note) → LinkRecord
queryLinks(hash, dir, rel?) → { out: LinkRecord[], in: LinkRecord[] }
walkTree(hash, dir, depth) → TreeNode
```

---

## Example: Whitepaper Lineage

```
sur-link(
  from: "sha256:whitepaper-v2",
  to: ["sha256:snap-march-20", "sha256:snap-march-26", "sha256:covia-research"],
  rel: "derived-from",
  note: "v2 incorporated these three sessions"
)
```

Later, any agent can call:
```
sur-tree(hash: "sha256:whitepaper-v2", dir: "up")
```

And get the full ancestry of that document.

---

## What We Are NOT Building (yet)

- **Automatic link inference** — agents create links explicitly; we don't auto-detect relationships
- **Link deletion** — links are immutable once created (append-only, like git commits)
- **Cross-node link resolution** — links reference hashes; if the target hash isn't on your node yet, you get the hash back but not the content. Multi-node resolution is a future problem.

---

## Open Questions for Mike

1. Should link records be stored as Assets or Jobs in VenueLattice? (we used Assets via `POST /api/v1/assets`)
2. Should SurStor Grid expose `sur-tree` traversal across venues (not just local)?
3. Tool naming: `sur-link` / `sur-links` / `sur-tree` — or something that fits Covia's vocabulary better?

---

## Build Status

- [x] `links` table in SQLite schema
- [x] `sur-link` tool — SurStor Personal (DLFS-backed)
- [x] `sur-links` tool
- [x] `sur-tree` tool
- [x] Covia adapter interface contract defined
- [x] `covia-adapter.js` — SurStor Grid live (activate with `COVIA_URL` env var)
- [ ] Cross-venue `sur-tree` traversal (SurStor Grid only, future)
