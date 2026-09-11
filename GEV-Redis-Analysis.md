# God's Eye View — Redis Architecture Analysis & Recommendations

**Date**: 2026-09-11 (revised after peer review by Fable 5.1)
**Codebase**: `main` branch at `ebb4293`
**Scope**: Server-side Redis pipeline, client rendering, data transport, and Redis data structure opportunities
**Method**: Full source-code inspection of `server/redis/` (projector, pipeline, progressive reads, search endpoints, plugin routes) and `src/data/` (all layer modules, render governor, camera handling, HUD)

---

## Executive Summary

GEV is an impressive real-time geospatial demo with a well-engineered client (GPU-batched rendering, dead reckoning, LOD management) and a thoughtful Redis pipeline (stream-consumer-entity pattern, progressive reads, consistent-read guards). The primary bottleneck is the **read path**: every poll cycle ships the entire entity catalogue regardless of what changed or what's visible. For 11k flights, that's ~110 pipelined `JSON.GET` commands, a multi-MB HTTP body, and full client-side reconciliation — every 30 seconds.

GEV exists to **showcase Redis capabilities** and to deliver a **fluid real-time experience**. These goals are co-primary: a demo that stutters at 22 FPS or hangs on BUSY errors undermines the very capabilities it's trying to show. The recommendations below serve both — fixing transport performance while expanding the Redis surface area demonstrated. They are ordered by **impact on perceived fluidity**, with Redis showcase value called out for each.

---

## Current Architecture (Verified Against Source)

```
browser POST /api/redis/ingest
  → source adapter → pipelined XADD per record (batches of 100)
  → XADD commit event
  → view-projector consumer (XREADGROUP, COUNT 200, BLOCK 1000)
      → STAGE Lua: JSON.SET per entity to staging key + XACK
      → COMMIT Lua: JSON.GET staged → JSON.SET indexed (full doc) + CMS.INCRBY
                     + RPUSH members + EXPIRE + SET tracking
      → atomic snapshot swap: RENAME member list, JSON.SET snapshot metadata
  → browser GET /api/redis/snapshot
      → LRANGE member list (pages of 500)
      → pipelined JSON.GET per member (batches of 100)
      → payload format conversion (base64/TLE/JSONL decode)
      → full GEV envelope → HTTP response
  → browser reconciles (flights: incremental diff; others: full replace)
```

**Key facts confirmed in code**:
- No Pub/Sub, SSE, or WebSocket (`server/redis/README.md:229`)
- No viewport or time scoping on snapshot reads (`pipeline.js:354-387`)
- Full entity document rewritten on every position tick (`projector.js:120`)
- Lua scripts run JSON.GET + JSON.SET + CMS.INCRBY + RPUSH per entity — triggers BUSY above 5s (`projector.js:82-127`)
- Single projector process (`README.md:228`)
- Client already uses BillboardCollection/PointPrimitiveCollection for all high-density layers — rendering primitives are correct
- Flights have dead reckoning at 80ms intervals between polls (`flights.js:2617-2641`)
- Flights use incremental reconciliation with 3-poll grace period (`flights.js:4471-4569`)

---

## Recommendations — Ordered by UX Impact

### 1. Viewport-Scoped Delta Reads via FT.SEARCH

**Impact**: Eliminates shipping invisible entities. Globe view showing Europe gets ~2k flights instead of 11k. Zoomed to an airport gets ~50.
**Perceived effect**: Faster refreshes, lower bandwidth, smoother animation on constrained devices.

The `geoLocation` GEO field already exists on entities (added via `FT.ALTER` in `userSearch.js:4-8`). Exploit it for the main read path:

```
FT.SEARCH gev:flights:idx
  "@geoLocation:[2.35 48.86 800 km] @updatedAt:[(1757599985 +inf]"
  RETURN 7 id latitude longitude altitudeM speedMps heading label
  LIMIT 0 5000
  DIALECT 2
```

Three scoping dimensions in one query:
- **Viewport**: GEO radius or GEOSHAPE polygon for the camera frustum
- **Time**: only entities updated since client's last cursor
- **Projection**: RETURN only the 7 fields needed for rendering, not the full nested doc

For the existing architecture (before any key model changes), add `updatedAt` as a NUMERIC SORTABLE field and `heading` as a NUMERIC field to the existing JSON indexes via `FT.ALTER`. The documented entity schema has `speedMps` and `altitudeM` but no `heading` — add `$.heading` at projection time alongside `$.updatedAt`. The projector already writes the full entity doc; both fields are available from the source data.

**Note**: once #6 (hot/cold split) lands, the FT.SEARCH target shifts from the JSON index (`gev:flights:idx`) to the hot hash index (`gev:flights:posidx`). The query structure stays the same; only the index name and field paths change. Same for #2's FT.AGGREGATE.

**Migration**: additive. New `/api/redis/delta` endpoint alongside existing `/api/redis/snapshot`. Client switches per layer. No schema break.

**Effort**: Medium (new endpoint + index field + client fetch logic).

---

### 2. Density Clustering at Low Zoom via FT.AGGREGATE

**Impact**: Globe view renders ~300 cluster centroids instead of 11k individual billboards. Single biggest visual win for the "zoom out to world" moment.
**Perceived effect**: Globe view goes from sluggish to instant. Smooth transition from clusters to points as user zooms in.

Store a geohash prefix on each entity at write time (precision 6, ~1.2 km). Truncate at query time:

```
FT.AGGREGATE gev:flights:idx
  "@geoLocation:[0 30 10000 km]"
  LOAD 3 $.geohash AS geohash $.latitude AS latitude $.longitude AS longitude
  APPLY "substr(@geohash, 0, 3)" AS cell
  GROUPBY 1 @cell
    REDUCE COUNT 0 AS n
    REDUCE AVG 1 @latitude AS clat
    REDUCE AVG 1 @longitude AS clon
  SORTBY 2 @n DESC
  LIMIT 0 2000
```

**Note**: `LOAD` on a JSON index needs the JSONPath form (`$.geohash AS geohash`), not `@field` shorthand, unless `geohash` is in the index schema. Add `$.geohash AS geohash TEXT NOSTEM` to the index via `FT.ALTER`, or use the explicit JSONPath LOAD above. Once #6 (hot/cold split) lands, `geohash` belongs on the hot hash and this aggregate should run on the hot index (`gev:flights:posidx`) instead of `gev:flights:idx`.

Geohash truncation by zoom level:

| Zoom | Prefix length | Cell size | Typical clusters |
|------|--------------|-----------|-----------------|
| Globe | 2 | ~630 km | ~80-150 |
| Continent | 3 | ~78 km | ~200-400 |
| Country | 4 | ~20 km | ~300-600 |
| Region | 5 | ~2.4 km | switch to points |

Client renders one sized billboard per cluster. Below the region threshold, switch to individual entity points from recommendation #1.

**Effort**: Medium (geohash field at write time + aggregate endpoint + client dual-mode renderer).

---

### 3. SSE Revision Notifications via Explicit PUBLISH (Replace Timer Polling)

**Impact**: Eliminates blind 15-30s polling. Client pulls only when data actually changed. Reduces unnecessary Redis reads to zero during quiet periods; delivers changes within ~1s of projection completing.
**Perceived effect**: Data feels "live" instead of "polling." No wasted fetches. Combined with delta reads (#1), each refresh is small and fast.
**Redis showcase**: Pub/Sub as a real-time notification bus — the canonical use case.

Projector adds `PUBLISH gev:<layer>:rev <revision>` after each commit (or `SPUBLISH` on cluster). Server holds one subscription, fans out to browser SSE connections:

**SSE endpoint**:
```
GET /api/redis/events
Content-Type: text/event-stream

event: rev
data: {"layer":"flights","rev":18342}
```

Client debounces per layer (floor 1s), issues one `/delta` call. Keep the existing timer as a 30s fallback when SSE drops.

**Why explicit PUBLISH over keyspace notifications**: keyspace events are per-node (need a subscriber per shard on cluster), carry no payload (client still needs a `GET revision` round-trip), and `CONFIG SET notify-keyspace-events` is frequently locked on managed Redis deployments. Explicit `PUBLISH` is portable, carries the revision in the message, and works everywhere. Reserve keyspace notifications for expiry events (#10) where implicit notification is uniquely valuable.

**The revision counter stays.** The existing revision + publishing guard (`pipeline.js:427-447`) prevents mixed-generation reads. Notifications complement it, they don't replace it. Client includes its last-known revision in delta requests; server validates coherence.

**Effort**: Low-medium (SSE endpoint + PUBLISH in projector + client EventSource).

---

### 4. Flatten Source Blobs at Write Time

**Impact**: Non-flight layers (AIS, radio, datacenters) currently ship the raw upstream `$.source` JSON on every read (`pipeline.js:384`). AIS source blobs include voyage metadata, raw NMEA fields, vessel details — most unused for rendering. 
**Perceived effect**: 60-70% body size reduction for AIS/radio/datacenter snapshots. Faster parse, less GC pressure.

At projection time, extract the display-relevant fields into top-level JSON paths:
```javascript
// Instead of storing raw source and reading $.source on every poll:
JSON.SET entity $ { id, layer, kind, label, latitude, longitude, 
                    altitudeM, speedMps, heading, geoLocation,
                    /* flattened from source: */ vesselType, destination, 
                    draught, eta, mmsi }
```

Keep `$.source` for click-to-inspect only. The existing `RETURN` projection in FT.SEARCH (recommendation #1) then returns only the flat fields — no nested blob shipped or parsed.

**Split the work**: the renderer reconstructs provider envelope payloads from `$.source` (`payload.js:112-130`). The two halves have different urgency:
- **Projector-side flattening** (ship early, step 2): write flat fields at projection time. #1's `RETURN` clause needs them to exist. Low risk, no client breakage — the flat fields coexist with `$.source`.
- **Client `unpackBody` rework** (defer until after #1): the snapshot path that reads `$.source` is the one #1 replaces. Only rework the client reconstruction if the snapshot path survives past #1. Don't invest in a path about to be deleted.

**Effort**: Low for projector half (modify entity document construction). Medium for client half if needed (update `unpackBody` across layers).

---

### 5. Eliminate BUSY Errors — Lua to MULTI/Pipeline

**Impact**: BUSY script errors block ALL Redis clients for the script's duration. During a large AIS batch (75s allowance documented), the entire demo freezes — no reads, no other layers, no search.
**Perceived effect**: Eliminates multi-second hangs during heavy ingestion. All layers stay responsive even when AIS is processing a large batch.

Current COMMIT Lua (`projector.js:82-127`) runs per entity inside a single script:
- `JSON.GET` (read staged doc)
- `JSON.SET` (write indexed doc)  
- `CMS.INCRBY`, `RPUSH`, `EXPIRE`, `SET`

Replace with Node-side pipeline per 25-record batch:

```
MULTI
  JSON.SET  gev:<layer>:entity:<id> $ <doc>     × n
  EXPIRE    gev:<layer>:entity:<id> 3600         × n
  CMS.INCRBY gev:<layer>:frequency <id> 1        × n
  RPUSH     gev:<layer>:snapshot:<cohort>:members:next <key>  × n
  INCR      gev:<layer>:revision
EXEC
```

**Atomicity consideration**: current Lua provides epoch guard + conditional check-and-set. MULTI loses that. Two options:
- **WATCH/MULTI**: WATCH the epoch key, MULTI the batch, retry on conflict (rare — epoch only changes on schema reset)
- **Accept weaker guarantee**: epoch changes are admin-initiated resets, not concurrent. A simple pre-check before MULTI is sufficient for the demo.

The enrichment merge logic (`projector.js:95-114` — merging typeCode/typeName/registration onto existing entity for flight enrichment updates) moves to Node-side: read-modify-write with pipeline, not inside Lua.

**CMS replay safety note**: `CMS.INCRBY` is a plain increment, not idempotent. Current replay safety comes from Lua's atomic cursor advance — `XACK` inside the script means a replayed batch never re-commits. Moving to MULTI breaks this: a crash between `EXEC` and `XACK` causes redelivery → double CMS increment. Two options:
- **Guard**: check before MULTI, not inside it. `SET gev:<layer>:applied:<stream-id> NX EX 600` cannot gate execution inside a MULTI (MULTI has no conditional execution — all commands run regardless of intermediate results). Instead: `SET ... NX EX 600` before the MULTI; if it returns nil (already applied), skip the entire batch. Alternatively, `WATCH` the applied key so a concurrent writer aborts the EXEC.
- **Accept approximation**: CMS is already approximate by nature. Double-counting a rare crash-replay on top of the inherent error rate is acceptable for a demo — but state this explicitly in code comments.

**Effort**: Medium (rewrite projector commit path, preserve enrichment merge, add replay guard, test atomicity edge cases).

---

### 6. Hot/Cold Entity Split

**Impact**: Position fields (lat, lon, alt, heading, speed) change every 15-30s. Enrichment fields (type, registration, operator, TLE elements) change rarely or never. Today every position tick rewrites and reindexes the full nested JSON document.
**Perceived effect**: Faster projection (less data written), faster reads (smaller documents for the position path), lower Redis memory churn.
**Redis showcase**: Hash + HEXPIRE + dual-index architecture, demonstrating Redis's ability to model hot/cold data paths natively.

**Why this moved up**: recommendation #1 adds `$.updatedAt` to the existing JSON index. Without the hot/cold split, every position tick triggers a full-document reindex of 11k docs — the read side gets scoped but the write side becomes MORE expensive. This must land shortly after #1 to avoid a write-amplification gap.

Split into:

**Hot** — position hash:
```
HSET gev:flights:pos:34454b id 34454b lat 48.86 lon 2.35 
     loc "2.35,48.86" alt 11277 spd 236.4 hdg 87 ts 1757600000
HEXPIRE gev:flights:pos:34454b 300 FIELDS 6 lat lon loc alt spd hdg
```
~150 bytes, rewritten every tick. Cheap to index.

**Expiry model decision** (affects #9): two options:
- **Whole-key EXPIRE** (simpler): `EXPIRE gev:flights:pos:34454b 300`. Entire hash disappears when stale. Fires `__keyevent:expired` for #9. Identity fields don't survive, but a stale entity's identity isn't useful without a position.
- **HEXPIRE** (granular): `HEXPIRE ... 300 FIELDS 6 lat lon loc alt spd hdg`. Position fields expire individually while `id`, `kind`, `ts` persist. Does NOT fire `__keyevent:expired` — #9 needs `notify-keyspace-events Eh` and `hexpired` events instead. More complex.

Recommendation: whole-key EXPIRE unless there's a concrete need for the identity fields to outlive the position. Pick before implementing #9.

**Cold** — enrichment JSON (existing structure):
```
gev:<layer>:entity:<family>:<id>  →  full document with $.source, collections, TLE, etc.
```
Written on enrichment events only. Read on click-to-inspect.

Separate FT.CREATE for the hot index (GEO + NUMERIC fields only) — fast, small, low reindex cost. Existing JSON indexes stay for text/tag search on cold docs.

**Multi-collection lifecycle note**: entities can belong to multiple snapshot cohorts. Current cleanup does `collections` array surgery rather than deletion (`projector.js:128-142`). Hot/cold split needs to preserve this — track collection membership on the cold doc, not the hot hash.

**Enrichment merge**: current Lua merges typeCode/typeName/registration for flight enrichment updates (`projector.js:95-114`). With hot/cold split, enrichment writes go directly to the cold doc — no merge needed in the hot path.

**Effort**: Medium-high (new key model, dual indexes, projector path split, client read path adaptation).

---

### 7. Single LRANGE for Member List (Immediate Win)

Current `pipeline.js:354-358` pages member keys with `LRANGE` in chunks of 500. For 11k entities → 22 LRANGE calls just to enumerate key names before any reads begin.

Replace with a single `LRANGE 0 -1`. Redis handles 11k string elements in one call without issue. Harmless, zero risk, eliminates 20+ round-trips per snapshot read.

**Note on JSON.MGET**: `JSON.MGET` (multi-key read in one command) was considered but rejected. On Cluster or Redis Enterprise, 11k keys across hash slots triggers `CROSSSLOT` errors unless the key model adds hash tags, which it doesn't have. It also turns 110 interleavable pipelined commands into one command that holds the main thread for the entire read — the pipeline version lets other clients breathe between batches. And it optimizes a path that #1 is about to replace. Not worth the effort.

**Effort**: Very low (change ~3 lines in `pipeline.js`).

---

### 8. Bloom Dedup on AIS Ingest

**Impact**: AIS rebroadcasts identical positions constantly. Dedup before XADD cuts stream volume 30-60%.
**Perceived effect**: Lower Redis memory, faster projection cycles, reduced BUSY risk on the heaviest layer (AIS at 12k vessels — worst measured FPS at 22).
**Redis showcase**: Bloom filter for real-time deduplication — a textbook probabilistic use case.

```
BF.ADD gev:ais-live-vessels:seen "<mmsi>:<lat4>:<lon4>:<sog>:<cog>"
```

- Quantize lat/lon to 4 decimal places (~11m precision, sufficient for vessel tracking)
- Skip XADD when `BF.ADD` returns 0 (element already seen)
- Rotate filter hourly: `gev:ais-live-vessels:seen:<hour>` with `EXPIRE 7200`
- Log skipped/total for the stats panel

**Effort**: Low (add BF.ADD check before XADD in the AIS ingest path).

---

### 9. Stale Entity Expiry via Keyspace Notifications

**Impact**: Currently entities expire silently via TTL. No mechanism notifies the client that an entity is gone — the client relies on missing-poll grace periods (3 consecutive absences for flights at `flights.js:604`).
**Perceived effect**: Aircraft that land or go out of range disappear promptly instead of lingering for 3 poll cycles (90s for flights, longer for slower layers).

**Interaction with #6 (hot/cold split)**: after the hot/cold split, the hot hash uses `HEXPIRE` on position fields, not whole-key `EXPIRE`. Field-level expiry does NOT fire `__keyevent@0__:expired`. Two options:

- **Option A (recommended)**: use whole-key `EXPIRE` on the hot hash instead of `HEXPIRE`. When the position hash expires, the entity is stale — identity fields on an expired entity aren't useful. Simpler, and `__keyevent@0__:expired` works as expected.
- **Option B**: keep `HEXPIRE` and subscribe to hash field expiry events via `notify-keyspace-events Eh` (the `h` class covers hash commands including `hexpired` events). More granular but adds complexity.

Pick one and make #6 and #9 agree on the expiry model.

```
CONFIG SET notify-keyspace-events Ex    # Option A: whole-key expiry
SUBSCRIBE __keyevent@0__:expired
```

Server catches `gev:flights:pos:34454b` expiring → pushes removal to client via SSE:
```
event: expired
data: {"layer":"flights","id":"34454b"}
```

Client removes the billboard immediately. No sweep query needed, no Sorted Set `ZRANGEBYSCORE` on lastSeen.

**Caveat**: expired event timing is non-deterministic (Redis docs: "significant delay" possible between TTL=0 and event firing). For demo purposes, acceptable. For exact timing, keep a Sorted Set sweep as secondary mechanism.

**Why keyspace notifications here but not for #3**: expiry is inherently per-key and implicit — no projector change needed, and the per-node limitation is acceptable (expiry happens on the node that owns the key). For commit notifications (#3), explicit PUBLISH is more portable and carries payload.

**Effort**: Low (CONFIG SET + subscribe handler + SSE event type + client removal handler).

---

### 10. Redis Arrays — Track History and Event Logs

**Impact**: Arrays (preview, Redis 8.8+) provide ring buffers for trail history and sparse indexed storage with built-in aggregation and text search.
**Perceived effect**: Trail rendering, replay scrubbing, per-entity event search — visible, tangible demo features.
**Redis showcase**: New data type demonstrating sparse arrays, ring buffers, AROP aggregation, ARGREP text search.

**Important**: Arrays are in preview. Do not place them on the demo-critical read path. Use them for supplementary features (trails, events, stats) that enhance the demo without being required for core functionality.

#### 10a. Per-entity track ring buffer

```
ARRING gev:flights:track:34454b 60 "{\"lat\":48.86,\"lon\":2.35,\"alt\":11277,\"ts\":1757600000}"
```

- 60 slots = 15 minutes at 15s intervals
- `ARLASTITEMS gev:flights:track:34454b 20` — last 5 minutes for trail rendering
- `AROP gev:flights:track:34454b 0 59 MAX` — peak altitude
- Auto-overwrites oldest position, no cleanup, no compaction rules

Simpler than TimeSeries for single-entity trails. TimeSeries still better for cross-entity label-based queries (`TS.MRANGE ... FILTER layer=flights type=C-17`).

**Scope to visible or tracked entities from the start.** Writing 11k `ARRING` commands per tick to a projector you're trying to make lighter defeats the purpose. Instead, the projector writes ring buffers only for entities the client has requested trails for (tracked entity, selected entity, entities visible in a detail panel). The client sends a `SUBSCRIBE trails <id>` message over the SSE connection; the server adds that entity to the ring-buffer write set. Typical count: 1-10 entities, not 11k.

**Memory budget at scoped scale**: 10 tracked entities × 240 slots × ~80 bytes ≈ 192 KB. Negligible. Full-catalogue trails (11k × 60 × ~80 = 53 MB) only if there's an explicit "record all" mode.

**Natural index keys**: ICAO24 is a 24-bit hex integer (0–16,777,215). MMSI is a 9-digit integer. Both map directly to sparse array indexes with zero collision risk — no hashing needed. This is the elegant fit for Arrays.

#### 10b. Per-entity event log with ARGREP

```
ARINSERT gev:flights:events:34454b "squawk:7700 alt_change:-5000ft ts:1757600123"
```

`ARGREP gev:flights:events:34454b - + MATCH "squawk:7700"` — find emergency events without a secondary index. Powers the analyst panel and NL query pane. Combined with ring buffer mode, stores the last N events per entity and is searchable in place.

#### Where Arrays complement (not replace) existing structures

| Need | Keep using | Why |
|------|-----------|-----|
| Viewport-scoped GEO queries | FT.SEARCH on indexed hash/JSON | Arrays have no FT.SEARCH integration |
| Ingest pipeline with ACK/replay | Streams + consumer groups | Arrays have no consumer groups |
| Approximate frequency counting | Count-Min Sketch | Purpose-built probabilistic structure |
| Text/tag filtering | FT.SEARCH on JSON index | Arrays have no index integration |
| Core position read path | FT.SEARCH (#1) or hot hash (#6) | Arrays are opaque strings — a third copy, not a replacement |

**Effort**: Medium (new key model for trails/events, projector writes Arrays alongside existing path). Validate preview stability before expanding scope.

---

### 11. Additional Redis Surface Area for Demo Value

Ordered by demo impact and implementation effort:

#### 11a. GEOSHAPE Polygons for Named Areas

Store admin boundaries, chokepoints, restricted airspace as GEOSHAPE fields. Query `WITHIN` / `CONTAINS`:
```
FT.SEARCH area-idx "@boundary:[CONTAINS $point]" PARAMS 2 point "POINT(2.35 48.86)"
```

Powers geofence enter/exit events. The 250km "Contacts" roster becomes one server-side GEO radius query instead of browser-side iteration. High demo value for the military awareness context.

#### 11b. Top-K for Type Dropdowns

Replace repeated `FT.AGGREGATE ... GROUPBY @typeName REDUCE COUNT ... SORTBY @count DESC LIMIT 0 20` with:
```
TOPK.ADD gev:flights:topTypes <typeName>
TOPK.LIST gev:flights:topTypes
```

Updated incrementally on every entity write. O(1) per update vs O(n) aggregate scan. Dropdown always ready, no query needed.

#### 11c. HyperLogLog for Distinct Counts

```
PFADD gev:flights:seen:<hour> <icao>
PFCOUNT gev:flights:seen:<hour>
```

"3,847 distinct aircraft seen this hour" — one command, 12KB memory. Powers the stats panel without scanning.

#### 11d. Vector Search + Semantic Cache

Embed `label + typeName + operator + tags` on entity documents. NL pane does semantic matches ("fuel tankers", "spy planes") instead of prefix TEXT search.

Semantic cache in front of the `gpt-5.6-terra` planner (`userSearch.js:170-189`):
```
FT.SEARCH semantic-cache-idx "@embedding:[VECTOR_RANGE 0.15 $vec]" 
  RETURN 1 cached_plan LIMIT 0 1
```

Same intent → cached plan → no LLM call → sub-10ms. Ties GEV to the Iris / LangCache story.

#### 11e. Multi-Projector with Partitioned Streams

Current: single consumer, single projector process. Scale-out path:

**Key model change required**: a single consumer group hands entries to whichever consumer reads first — there's no per-entity routing inside a group. Per-entity ordering across N workers needs **N streams partitioned at XADD time**:
```
gev:flights:stream:<entity-id-hash mod N>
```
Each partitioned stream gets its own consumer group. Ordering is preserved per entity because the same entity always routes to the same stream. `XAUTOCLAIM` handles abandoned messages when a worker crashes.

This is a key-model change, not just adding consumers to the existing group.

- Note: `CMS.INCRBY` is NOT idempotent — redelivered batches will double-count. Use a `SET ... NX EX 600` guard per stream-id **before** the MULTI (not inside — MULTI has no conditional execution), or accept the approximation (CMS is already approximate by nature)

---

## Implementation Priority Matrix

| # | Recommendation | Effort | UX Impact | Redis Showcase | Ship Independently |
|---|---|---|---|---|---|
| 1 | Viewport-scoped delta reads | Medium | Critical | FT.SEARCH GEO + NUMERIC | Yes |
| 2 | Density clustering at low zoom | Medium | Critical | FT.AGGREGATE GROUPBY | Yes |
| 3 | SSE via explicit PUBLISH | Low-Med | High | Pub/Sub | Yes |
| 4 | Flatten source blobs | Medium | High | JSON path projection | Yes |
| 5 | Lua → MULTI/pipeline | Medium | High | Pipeline efficiency | Yes |
| 6 | Hot/cold entity split | Med-High | High | Hash + HEXPIRE + dual index | Yes |
| 7 | Single LRANGE (immediate win) | Very Low | Low | — | Yes |
| 8 | Bloom dedup on AIS | Low | Medium | Bloom filter | Yes |
| 9 | Keyspace expiry notifications | Low | Medium | Keyspace notifications | Yes |
| 10 | Redis Arrays (trails/events) | Medium | Demo value | Array (preview) | Yes |
| 11a | GEOSHAPE polygons | Medium | Demo value | GEOSHAPE WITHIN/CONTAINS | Yes |
| 11b | Top-K for dropdowns | Low | Demo value | Top-K | Yes |
| 11c | HLL distinct counts | Very Low | Demo value | HyperLogLog | Yes |
| 11d | Vector search + semantic cache | Medium | Demo value | Vector search + LangCache | Yes |
| 11e | Multi-projector | Medium | Scale demo | XAUTOCLAIM + partitioning | Yes |

**Suggested migration order** (each step independently shippable):

1. **Single LRANGE** (#7) — immediate, zero risk, eliminates 20+ round-trips
2. **Projector-side flattening** (#4, first half) — write flat fields + `heading` + `updatedAt` + `geohash` at projection time. #1's RETURN and #2's LOAD need them. No client breakage — flat fields coexist with `$.source`.
3. **SSE notifications** (#3) — eliminate blind polling
4. **Viewport-scoped delta reads** (#1) — the architectural shift
5. **Hot/cold entity split** (#6) — must follow #1 closely to avoid write-amplification gap from `$.updatedAt` reindexing 11k full docs per tick. **Decision point**: choose whole-key EXPIRE or HEXPIRE — this determines #9's notification model.
6. **Density clustering** (#2) — globe view transformation. Once #6 lands, retarget the aggregate from `gev:flights:idx` to the hot index.
7. **Lua → MULTI** (#5) — eliminate BUSY
8. **Bloom dedup** (#8) — AIS stream reduction
9. **Expiry notifications** (#9) — clean entity lifecycle. Must agree with #6's expiry model.
10. **Arrays for trails/events** (#10) — showcase feature (validate preview stability first). Scope ARRING writes to tracked entities only.
11. **Additional structures** (#11a-e) — demo showcase expansion, can be interleaved at any point; HLL (#11c) and Top-K (#11b) are low effort and can ship early to demonstrate breadth
12. **Client `unpackBody` rework** (#4, second half) — only if the snapshot path survives past #1. Otherwise skip.

---

## Acceptance Metrics

Capture before step 1 and after each step. Same machine, Redis ON, flights + AIS + satellites enabled.

| Metric | Current (measure first) | Target |
|---|---|---|
| Bytes per tick, flights, Europe view | (measure) | < 100 KB |
| Bytes per tick, flights, globe view (cluster mode) | (measure) | < 30 KB |
| Redis commands per tick, flights | ~11k JSON.GET + 22 LRANGE | ≤ 3 (FT.SEARCH + revision check) |
| Time-to-first-delta after projection completes | 15-30s (poll interval) | < 2s (SSE notify) |
| Projector batch wall time (25 records) | (measure) | < 20 ms |
| BUSY occurrences in 30 min under load | > 0 (documented) | 0 |
| AIS stream entries per minute | (measure) | -30% or better (Bloom) |
| Browser main-thread time per layer apply | (measure) | < 16 ms |
| Globe view FPS with flights + AIS | (measure — profile first to determine if GPU-bound or transport-bound) | TBD after profile |

**Note on FPS target**: AIS at 12k vessels measures 22 FPS (worst case in `PERFORMANCE.md`). If this is GPU-bound (billboard draw calls), transport optimizations won't move it. Run one Chrome DevTools performance trace before committing to a number. If GPU-bound, the fix is client-side (LOD, frustum culling, altitude-gated visibility) — not in scope for this document.

---

## What's Already Done Right (Credit Where Due)

The analysis should not obscure that several things are well-engineered:

- **Client rendering primitives**: BillboardCollection for flights/military/AIS, PointPrimitiveCollection for satellites/traffic. GPU-batched, correct choice for density.
- **Dead reckoning**: 80ms ENU frame extrapolation between 30s polls. Smooth animation without faster server data.
- **Incremental reconciliation**: Flights diff against previous state, 3-poll grace prevents blink-on-dropout.
- **Progressive reads**: Browser sees partial data while projection continues. Good perceived latency.
- **Consistent read guard**: Revision + publishing state checked before/after reads prevents mixed-generation snapshots.
- **Render governor**: Binary continuous/idle mode, identity-keyed holds, tab visibility suspension. Correct GPU budget management.
- **LOD management**: 4-pass frustum-prioritized 3D model allocation capped at 150/350. Satellite dense-mode round-robin propagation spread over 300 frames.
- **Stream pipeline design**: MAXLEN ~ ACKED, bounded batches of 25, epoch guard, atomic cursor advance for replay safety.

The performance gains are in the transport layer (what gets shipped and when), not in the rendering layer (how it gets drawn). The showcase gains are in expanding the Redis surface area demonstrated — from the current {Streams, JSON, Search, CMS} to include {Pub/Sub, Bloom, Arrays, GEOSHAPE, Top-K, HLL, Vector Search, TimeSeries, HEXPIRE, XAUTOCLAIM}. Both goals drive the same demo forward.

---

## Revision History

- **v1** (2026-09-11): Initial analysis based on full source inspection.
- **v2** (2026-09-11): Revised after peer review by Fable 5.1. Changes: removed JSON.MGET recommendation (CROSSSLOT on cluster, optimizes a dead path); flipped keyspace notification preference to explicit PUBLISH for commit signals (portable, carries payload, works on managed Redis); preserved revision counter throughout (notifications complement, don't replace); moved hot/cold split up to follow viewport-scoped reads (avoids write-amplification gap); moved Arrays to showcase tier (preview status, third copy of position data, memory budget concerns); fixed CMS.INCRBY idempotency claim (it's a plain increment, not idempotent); corrected effort estimate for source blob flattening (client change too); replaced estimated metrics with "(measure)" placeholders; gated FPS target on profiling.
- **v3** (2026-09-11): Five residual fixes from Fable's second review. (1) CMS replay guard: `SET NX` moved before MULTI, not inside it — MULTI has no conditional execution. (2) #9 expiry events reconciled with #6 hot/cold split: HEXPIRE doesn't fire `__keyevent:expired`; added option to use whole-key EXPIRE instead, with explicit decision point in migration order. (3) #11e multi-projector: corrected to require N partitioned streams at XADD time, not just multiple consumers on one group — per-entity ordering needs per-entity stream routing. (4) #4 split into projector-side (ship early, #1 depends on it) and client-side (defer until snapshot path fate decided). (5) Field consistency: added `heading` to projection fields (#1 RETURN needs it), fixed FT.AGGREGATE LOAD syntax for JSON indexes, retargeted #2 aggregate to hot index after #6, scoped #10a ARRING writes to visible/tracked entities from the start.
