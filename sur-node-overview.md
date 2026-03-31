# sur-node Technical Overview

**For:** Mike Anderson  
**From:** Rich Kopcho  
**Date:** March 2026  
**Status:** Design decisions pending

---

## What It Is

**sur-node** is a personal AI memory system — an MCP server that gives Claude persistent, content-addressed storage across every session.

The goal: Claude remembers everything, owns nothing in the cloud, and can trace the provenance of any artifact.

---

## Architecture

Two-piece design with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│                        Claude                                │
│                     (MCP Client)                             │
└─────────────────────────────┬───────────────────────────────┘
                              │ stdio
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      sur-node                                │
│                 (Node.js MCP Server)                         │
│                                                              │
│  • 8 MCP tools exposed                                       │
│  • SQLite index (query cache)                                │
│  • Fully rebuildable from DLFS                               │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTP (port 8765)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        DLFS                                  │
│                  (Java WebDAV Server)                        │
│                                                              │
│  • Source of truth                                           │
│  • Plain files in ~/.convex/dlfs/                            │
│  • Content-addressed (SHA-256)                               │
│  • No cloud, no lock-in                                      │
└─────────────────────────────────────────────────────────────┘
```

**Key principle:** DLFS is the source of truth. SQLite is just a fast local query cache, fully rebuildable from DLFS at any time via `sur_rebuild`.

---

## MCP Tools

Eight tools exposed to Claude:

| Tool | Purpose |
|------|---------|
| `sur_store` | Store any artifact, returns a `sha256:` hash. Identical content = same hash (natural dedup). |
| `sur_get` | Retrieve artifact + metadata by hash. |
| `sur_snap` | Snapshot a conversation summary — stores JSON, returns hash + ready-to-paste MEMORY.md entry. |
| `sur_list` | List artifacts from SQLite, newest first, optionally filtered by tag. |
| `sur_rebuild` | Rebuild SQLite index from DLFS (disaster recovery). |
| `sur-link` | Create provenance links between artifacts. |
| `sur-links` | Query links for an artifact — inbound, outbound, or both. |
| `sur-tree` | Walk the full provenance tree — ancestors or descendants. |

---

## Link Types

The `sur-link` tool supports five provenance relationship types:

| Type | Meaning |
|------|---------|
| `derived-from` | This artifact was created using that artifact as input |
| `references` | This artifact mentions or cites that artifact |
| `supersedes` | This artifact replaces that artifact (newer version) |
| `corrects` | This artifact fixes an error in that artifact |
| `responds-to` | This artifact is a response to that artifact |

---

## Design Decisions

### Content-Addressed Storage

Everything is addressed by SHA-256 hash of content. Same content always produces the same hash — natural deduplication with no extra logic.

### DLFS as Source of Truth

SQLite is explicitly a cache layer. If it gets corrupted or lost, `sur_rebuild` regenerates it by walking DLFS. This makes the system recoverable and auditable.

### HTTP Client Choice

Using Node's native HTTP module directly instead of `fetch` or `undici`. This avoids IPv6 resolution issues and keep-alive problems with Jetty (the Java WebDAV server).

### Raw Files on Disk

No proprietary format. Artifacts are plain files you can inspect, copy, or back up with standard tools.

---

## The Covia Decision

This is where we need your input, Mike.

### Two-Tier Backend Design

`sur-link` has a pluggable backend, transparent to the agent:

| Tier | Backend | Capabilities |
|------|---------|--------------|
| **Lite** | SurStor-native | Link records stored directly in DLFS. Works standalone, no Covia required. Already built and running. |
| **Heavy** | Covia adapter | Same API, but links become full Covia Jobs — DID identity, CRDT merge semantics, distributed venue state, cryptographic verification. For enterprise/multi-org/compliance. |

**The agent never knows which backend is active.** Same call, same response shape. Backend selection happens at configuration time, not runtime.

### Interface Contract (Defined)

The Covia adapter implements three operations:

```typescript
interface CoviaLinkAdapter {
  createLink(source: Hash, target: Hash, type: LinkType, metadata?: object): Promise<LinkRecord>;
  queryLinks(hash: Hash, direction: 'inbound' | 'outbound' | 'both'): Promise<LinkRecord[]>;
  walkTree(hash: Hash, direction: 'ancestors' | 'descendants', depth?: number): Promise<TreeNode>;
}
```

The lite tier implementation is complete. The Covia adapter is stubbed, waiting on architectural decisions.

---

## Questions for Mike

1. **Storage primitive** — Should link records in the Covia adapter be stored as **Assets** or **Jobs** in VenueLattice?

2. **DLFS alignment** — Is `DLFSStorage` already the right place to land these, or does Covia have a better primitive we should use?

3. **Cross-venue traversal** — Should `sur-tree` traversal work across venues in the Covia adapter, or stay local to a single venue?

4. **Naming alignment** — Do `sur-link` / `sur-links` / `sur-tree` fit Covia's vocabulary? Should we rename to align with Covia terminology (e.g., `covia-link`, or use existing Covia verbs)?

---

## Current Status

| Component | Status |
|-----------|--------|
| DLFS (Java WebDAV) | ✅ Running |
| sur-node (MCP server) | ✅ Running |
| 8 MCP tools | ✅ Implemented |
| Lite backend | ✅ Complete |
| Covia adapter | ⏳ Interface defined, awaiting Mike's input |
| Git repo | ❌ Local only, never pushed |
| Package version | 0.3.0 in code, 0.1.0 in package.json (minor inconsistency) |

---

## Next Steps

1. Mike answers the four questions above
2. Build Covia adapter based on answers
3. Initialize git repo and push to GitHub
4. Sync package.json version to 0.3.0
5. Integration testing with Covia testnet

---

*End of document*
