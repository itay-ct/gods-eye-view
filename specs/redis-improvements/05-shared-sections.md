# Part 5 — Shared sections

## REMOVED

### REQ-02R: Lua `STAGE`/`COMMIT` scripts are removed from the projector

- Source: `GEV-Redis-Analysis.md` §5
- Removed behavior: `server/redis/projector.js:3-161` (`CHECK_EPOCH`, `STAGE`, `COMMIT` Lua strings) and the `EVALSHA`/`SCRIPT LOAD` path in `runProjector` (`server/redis/pipeline.js:212-224`)
- Why: replaced by REQ-02 (same behaviour without Lua). Kept as its own entry so the removal is auditable; REQ-02 is the MODIFIED entry that specifies the replacement.
- Depends on: REQ-02
- Baseline row: B10
- Evidence checked: `server/redis/projector.js:3-161`; `server/redis/pipeline.js:212-224`; `server/redis/README.md:24, 228, 265-268`
- Impacted files/components: `server/redis/projector.js`, `server/redis/pipeline.js`, `server/redis/README.md`
- Contract shape: n/a: no interface change (scripts are internal)
- Acceptance scenarios:
  - Given: the repository after REQ-02 merges
    When: `grep -n "redis.call\|evalSha\|scriptLoad" server/redis/projector.js server/redis/pipeline.js`
    Then: prints nothing (exit 1) except the `HEALTH` script in `pipeline.js:20-30`, which stays (3 read commands, no write).
  - Given: a running server after `redis-cli SCRIPT FLUSH`
    When: one full cycle per active layer completes
    Then: `redis-cli SCRIPT EXISTS <sha1 STAGE> <sha1 COMMIT>` → `0 0`.
- Constraints: `HEALTH` (`pipeline.js:20-30`) is out of scope for removal.
- Failure mode: n/a: static content (code deletion; runtime behaviour is REQ-02's)
- Rollback: `git revert`.
- Observability: `redis-cli INFO commandstats` → `cmdstat_evalsha` `calls` grows only by `HEALTH` invocations (one per `ensure` call).
- Compatibility impact: none.
- Verification: the `grep` above.
- Handoff task, if any: n/a: performed inside REQ-02's handoff task

## SUPERSEDED

| Old item | Superseded by | Why | Evidence |
|---|---|---|---|
| 500-element `LRANGE` paging of member lists | REQ-01 | 22 round trips for 11,000 members become 1 | `server/redis/pipeline.js:354-358`, `server/redis/progressive.js:19-24` |
| `STAGE`/`COMMIT` Lua scripts via `EVALSHA` | REQ-02, REQ-02R | Lua blocks all clients; `BUSY` documented | `server/redis/projector.js:3-161`, `server/redis/README.md:265-268` |
| Per-field `JSON.SET` enrichment merge loop | REQ-05 | one `JSON.MERGE` per changed entity | `server/redis/projector.js:98-105` |
| Full cold-doc `JSON.SET` per position tick (live layers) | REQ-03 + REQ-05 | positions move to the hot hash; cold doc written on enrichment only | `server/redis/projector.js:120` |
| Full-catalogue snapshot read for live layers | REQ-07 | viewport + `ts` scoped `FT.SEARCH` | `server/redis/pipeline.js:354-388` |
| Missed-poll grace as the only removal signal on Redis reads | REQ-09 (+ REQ-07 staleness rule) | Redis-driven `expired` events | `src/data/flights.js:604` |
| `FT.AGGREGATE` ranking for the unfiltered `/flight-types` request | REQ-14 | 20-entry sketch instead of an index scan | `server/redis/flightSearch.js:44-54` |
| Approximate bounding boxes for named areas in the NL planner | REQ-13 | exact `GEOSHAPE` `WITHIN` when a polygon exists | `server/redis/userSearch.js:181` |

## DEFERRED

| Item | Reason deferred | Blocked scope | Owner | Revisit trigger |
|---|---|---|---|---|
| DEF-A: client `unpackBody` rework (analysis §4 second half) | Live layers leave the snapshot path under REQ-07; the remaining snapshot consumers (`radio`, `local-datacenters`, static layers) read `$.source` once per activation, and the analysis makes this step conditional on the snapshot path surviving | rewrite of `unpackBody` (`server/redis/payload.js:112-130`) and per-layer envelope reconstruction in `src/data/*.js` | requester (repository owner, Pierre Lambert) | a measured snapshot response for `radio` or `local-datacenters` (DevTools → Network → Size) exceeds 1 MB (= 2 × the 495 KB member-list reply size derived in REQ-01), recorded in `baseline-capture.json` as `B17` |
| DEF-B: multi-projector with partitioned streams (analysis §11e) | `server/redis/README.md:228` fixes one projector for the MVP; the commit protocol (`begin`/`publish`/`cleanup`/`finish`, one `work` hash per cohort) has no cross-partition barrier, so N partitions need a new commit model, not only N consumer groups | N streams `gev:<layer>:stream:<p>` with `p = crc32(entityKey) mod N`, one consumer group per stream, `XAUTOCLAIM` recovery (doc: "transfers ownership to consumer of messages pending for more than min-idle-time"), a cross-partition finish barrier, a `publishing` counter replacing the single token | requester (repository owner, Pierre Lambert) | B5 median × ceil(entities / 25) for AIS exceeds the 75,000 ms allowance (`server/redis/README.md:245`) after REQ-02, REQ-03, REQ-05 and REQ-10 are deployed, measured on the same machine as the baseline |

## Dependency DAG

Edges from the `Depends on:` fields only:

```
REQ-02 -> REQ-03
REQ-02 -> REQ-06
REQ-02 -> REQ-12
REQ-02 -> REQ-14
REQ-02 -> REQ-15
REQ-02 -> REQ-02R
REQ-03 -> REQ-07
REQ-03 -> REQ-09
REQ-03 -> REQ-10
REQ-03 -> REQ-12
REQ-03 -> REQ-13
REQ-06 -> REQ-09
REQ-06 -> REQ-13
REQ-07 -> REQ-08
REQ-07 -> REQ-05
REQ-07 -> REQ-10
REQ-04 -> REQ-05
```

Roots (no dependencies): REQ-01, REQ-02, REQ-04, REQ-16. REQ-00 (baseline) precedes everything by convention (each `Baseline row:` names a row captured before the REQ ships).

Derived order (topological sort; roots first, ties broken by analysis priority): REQ-00 → REQ-01 → REQ-02 → REQ-02R → REQ-04 → REQ-16 → REQ-03 → REQ-06 → REQ-14 → REQ-15 → REQ-07 → REQ-09 → REQ-12 → REQ-13 → REQ-08 → REQ-05 → REQ-10

Document order (by pipeline stage: 01 write, 02 read, 03 transport, 04 showcase) differs from this derived order; the derived order is the migration order.

## Cross-REQ Interactions

| REQ pair | Shared resource | Interaction | Resolution |
|---|---|---|---|
| REQ-02 / REQ-03, REQ-06, REQ-12, REQ-14, REQ-15 | the publish `EXEC` | each adds commands to the same transaction | REQ-02 Constraints derive the total (228 per 25-record batch); B5 measures the wall time |
| REQ-03 / REQ-09 | `EXPIRE 300` on `gev:<layer>:pos:*` and `__keyevent@0__:expired` | REQ-09 relies on whole-key expiry | REQ-03 decides whole-key `EXPIRE` (not `HEXPIRE`) |
| REQ-03 / REQ-10 | hot hash TTL vs suppressed AIS records | a stationary vessel would expire after 300 s while still broadcasting | REQ-10 refreshes `EXPIRE` on the hot hash and the cold doc for every suppressed record |
| REQ-07 / REQ-10 | snapshot member list vs dropped `XADD` | dropping records removes vessels from snapshot reads | REQ-10 runs only for layers in `DELTA_LAYERS` |
| REQ-05 / REQ-07 | cold-doc position fields | after cutover, snapshot reads of live layers return frozen positions | REQ-05 depends on REQ-07 and is enabled per layer via `DELTA_LAYERS` |
| REQ-05 / REQ-16 | NL planner index schemas | live layers move to posidx, invalidating cached plans | REQ-16 stores `schemaHash` as a LangCache attribute and filters on it |
| REQ-06 / REQ-09 / REQ-13 | `GET /api/redis/events` stream and the single subscriber connection | three event types on one stream | REQ-06 Contract shape lists the three `event:` names; one `PSUBSCRIBE`/`SUBSCRIBE` connection |
| REQ-07 / REQ-08 | `/api/redis/delta` endpoint and its parameters | `cluster` switches the query type | REQ-08 adds one optional parameter; validation errors share one message |
| REQ-07 / REQ-09 | entity removal on the client | two removal signals | REQ-07 staleness rule (300,000 ms) is the fallback; REQ-09 removes earlier; duplicates ignored |
| REQ-03 / REQ-13 | `shape` GEOSHAPE field on posidx | REQ-13 queries it | field defined once in REQ-03 |
| REQ-14 / REQ-15 | per-hour key rotation (`<YYYYMMDDHH>`, `EXPIRE 7200`) | two hourly key families | same hour-key helper; both tolerate the first partial hour |
| REQ-12 / REQ-03 | tick-time pre-read of the hot hash (`sq`) | squawk-change detection reads the field REQ-03 writes | REQ-02 pre-read pipeline includes `HGET pos sq` for tracked ids only |
| REQ-01 / REQ-07 | snapshot read path | REQ-01 optimises a path live layers leave | REQ-01 stays for all non-live layers and `DELTA_LAYERS`-excluded layers |
| REQ-04 / REQ-05 | cold-doc field set | REQ-05's change detection compares REQ-04 fields | REQ-05 depends on REQ-04 |

## Non-Goals

- Client rendering primitives, dead reckoning (`src/data/flights.js:2617-2641`), render governor, and LOD budgets — the analysis credits them as correct; no scenario above changes them.
- Server-side scheduling of upstream source fetches: source polling stays client-triggered (`server/redis/README.md:229` "Source polling is retained"); REQ-06 changes only the read leg.
- Redis Cluster deployment: no hash tags, no `SPUBLISH`; single-node per `server/redis/README.md:13-14`.
- Authentication or multi-user hardening of the Vite dev endpoints beyond the existing same-origin checks (`server/redis/plugin.js:151-152`).
- FPS targets: set only after D-1 (B9 profile).
- Satellites on the hot hash or delta path (client-side propagation, `src/data/satellites.js:1525`).
- Redis Enterprise or Redis Cloud-only features other than LangCache (REQ-16, env-gated).

## Assumptions

| Assumption | Class | Disposition (REQ evidence / Test Strategy row / D-n) |
|---|---|---|
| A-1 Redis 8.2+ with JSON, Search, Bloom/Top-K/CMS modules is the runtime (tested 8.10.0) | Verified | REQ-03 evidence `server/redis/README.md:9`; `server/redis/pipeline.js:171` (`CMS.INITBYPROB` already in use) |
| A-2 `maxmemory 768mb`, `noeviction`, single node, db 0 | Verified | REQ-09 evidence `server/redis/README.md:14`, `server/redis/pipeline.js:40` |
| A-3 One projector process per layer; per-layer commit queue serializes writers | Verified | REQ-02 evidence `server/redis/pipeline.js:265-272`, `server/redis/README.md:228` |
| A-4 `EXEC` returns a null reply when a watched key changed; `EXEC` unwatches all keys | Verified | REQ-02 evidence (transactions doc quotes) |
| A-5 Key expiry emits `__keyevent@0__:expired` with the key name; timing has no guarantee | Verified | REQ-09 evidence (keyspace notifications doc quotes) |
| A-6 AIS `row.speed` is in knots (× 0.514444 → m/s) | Verification step | Test Strategy row REQ-03 (fixture from `src/data/aisStreamAdapter.js` sample; compare against `aisLiveVessels.js` display) |
| A-7 `GEOSHAPE SPHERICAL` is accepted on an `ON HASH` index | Verification step | Test Strategy row REQ-03 (`FT.CREATE … ON HASH … shape GEOSHAPE SPHERICAL` returns `OK` on the test container) |
| A-8 `src/data/local_data/natural_earth/` holds polygon GeoJSON usable for country areas | Verification step | Test Strategy row REQ-13 (import fixture inspection; `ls src/data/local_data/natural_earth/`) |
| A-9 The Vite dev server streams `text/event-stream` without buffering | Verification step | Test Strategy row REQ-06 (`curl -N` receives the first `: keepalive` within 15,000 ms) |
| A-10 Arrays commands exist on the target Redis (≥ 8.8.0) | Verification step | Test Strategy row REQ-12 (`redis-cli COMMAND INFO ARRING` non-nil) |
| A-11 `CONFIG SET notify-keyspace-events` is permitted on the target Redis | Verification step | Test Strategy row REQ-09 (returns `OK`; on `ERR` the REQ-09 disabled path is exercised) |
| A-12 The 20-phrase test set for B12 exists | Verification step | Baseline row B12 (file `specs/redis-improvements/fixtures/type-phrases.json`, created with REQ-16) |
| A-13 Frame rate at globe view is transport-bound rather than GPU-bound | Decision | D-1 |
| A-14 readsb/adsb.lol military records expose `flight`, `r`, `t`, `track` | Verification step | Test Strategy row REQ-04 (fixture from one `/api/adsblol/mil` response) |

## Open Decisions

| Decision | Options | Recommendation | Owner | Due | Blocks |
|---|---|---|---|---|---|
| D-1 FPS target for B9 after profiling | (a) transport-bound → target = 60 / 60 FPS matching `docs/PERFORMANCE.md:65-69` scenes; (b) GPU-bound → FPS target out of scope (Non-Goals), only bytes/commands targets apply | capture B9 with the GPU track before choosing; if GPU frame time ≥ 50% of the frame, choose (b) | requester (repository owner, Pierre Lambert) | 2026-09-25 | REQ-08 acceptance of a frame-rate figure only; no other REQ |

## Test Strategy

Harness: disposable container `docker run --rm -d --name gev-redis-test -p 127.0.0.1:16379:6379 redis:8.10.0 redis-server --maxmemory 768mb --maxmemory-policy noeviction` (image and flags from `server/redis/README.md:12-14`); tests run with `REDIS_URL=redis://127.0.0.1:16379`. Existing convention: `node --test server/redis/*.test.mjs` (`server/redis/README.md` test list, `TESTING.md`).

| REQ | Harness (unit / integration / container) | Fixture | Command |
|---|---|---|---|
| REQ-00 | manual capture | live layers on the dev server | procedures in the Baseline table; write `specs/redis-improvements/baseline-capture.json` |
| REQ-01 | container | 10,000-flight snapshot (`server/redis/pipeline.test.mjs` fixture) | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/pipeline.test.mjs` |
| REQ-02 | container | staged batch + injected `SET projection-schema` mid-transaction; kill-before-`XACK` replay | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/pipeline.test.mjs server/redis/projectionBatches.test.mjs` |
| REQ-02R | unit | repository source | `grep -n "redis.call\|evalSha\|scriptLoad" server/redis/projector.js server/redis/pipeline.js` |
| REQ-03 | container | one flights tick, one AIS tick (knots fixture, A-6), lat 87 entity; `FT.CREATE … ON HASH … GEOSHAPE` (A-7) | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/posIndex.test.mjs` |
| REQ-04 | unit + container | AIS row and readsb record fixtures (A-14); `FT.ALTER` on a pre-existing index | `node --test server/redis/payload.test.mjs server/redis/aisSearch.test.mjs` |
| REQ-05 | container | existing entity + position-only tick; enrichment tick; NL plan "fastest aircraft" | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/userSearch.test.mjs server/redis/projectionBatches.test.mjs` |
| REQ-06 | container + fake timers | mock projector `PUBLISH` burst of 440 messages; `EventSource` mock (A-9 via `curl -N`) | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/events.test.mjs src/data/redisMode.test.mjs` |
| REQ-07 | container | 3 hashes in radius, 6,000-hash truncation fixture | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/delta.test.mjs src/data/redisMode.test.mjs` |
| REQ-08 | container | two hashes (Paris, Rome) at steps 10/5 | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/delta.test.mjs` |
| REQ-09 | container | hash with `EXPIRE 2`; `CONFIG SET` allowed and denied (A-11 via ACL-less container; denial simulated by stubbing the reply) | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/events.test.mjs` |
| REQ-10 | container | 1,000 AIS rows with 400 repeats; hour-boundary clock stub | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/dedup.test.mjs server/redis/pipeline.test.mjs` |
| REQ-12 | container (Redis ≥ 8.8, A-10) | tracked id, 241 ticks, squawk change | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/tracks.test.mjs` |
| REQ-13 | container | square polygon fixture + inside/outside points; natural_earth inspection (A-8) | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/areas.test.mjs` |
| REQ-14 | container | 100 flights × 3 ticks, 3 types; hour rollover stub | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/topk.test.mjs server/redis/flightSearch.test.mjs` |
| REQ-15 | container | 10,000 distinct ids × 3 ticks | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/pipeline.test.mjs` |
| REQ-16 | container + HTTP mocks | mocked OpenAI embeddings/responses and LangCache servers; 20-phrase set (A-12) | `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/typeVectors.test.mjs server/redis/userSearch.test.mjs` |

Full suite (repo-native): `REDIS_URL=redis://127.0.0.1:16379 node --test --test-concurrency=1 server/redis/*.test.mjs && node --test src/data/redisMode.test.mjs src/data/manager.test.mjs && npm run build`. Load check: `REDIS_URL=redis://127.0.0.1:16379 node scripts/redis-load-check.mjs`.

## Security

- REQ-05 `GET /api/redis/entity`, REQ-07/REQ-08 `GET /api/redis/delta`, REQ-12 `GET /api/redis/trail`, `GET /api/redis/track-events`, REQ-13 `GET /api/redis/areas`, REQ-16 `GET /api/redis/search/types`: read-only, unauthenticated like the existing `GET /api/redis/snapshot` on the local Vite dev server (`server/redis/plugin.js:117`); parameters validated with HTTP 400 as specified; no user data stored.
- REQ-06 `GET /api/redis/events`: unauthenticated read-only stream; payload carries layer names, revision tokens, entity ids, area slugs — no credentials, no personal data; connection count exposed in `/status`.
- REQ-12 `POST /api/redis/tracks`: same-origin `Origin` check and `application/json` requirement copied from `/ingest` (`server/redis/plugin.js:151-152`); cap 100 ids per layer bounds memory and write amplification.
- REQ-09 `CONFIG SET notify-keyspace-events`: privileged; runs as the default user of the Docker command (`server/redis/README.md:14`, no ACL). With ACLs, the server user needs `+config|get +config|set`; on `ERR` the feature disables itself.
- REQ-16 secrets: `OPENAI_API_KEY` (existing, `server/redis/userSearch.js:162`) and `LANGCACHE_URL`, `LANGCACHE_CACHE_ID`, `LANGCACHE_API_KEY` live in the server `.env` (`.env.example` documents them; `.gitignore` excludes `.env`); prompts sent to LangCache are the user's NL search text and the compiled plan — no Redis credentials.
- REQ-02, REQ-03, REQ-04, REQ-10, REQ-14, REQ-15: no new endpoint, privileged command, or secret.
- REQ-01, REQ-02R: n/a: read path / code removal, no endpoint, privilege, or secret.

## Consumer Rollback

- REQ-04: clients read `$.source` today and ignore the added fields; no client change needed to revert.
- REQ-05: the client detail panel calls `GET /api/redis/entity`; on HTTP 404/503 it falls back to the fields it already holds from the delta row; NL planner reverts to JSON indexes when `DELTA_LAYERS` is emptied (server-side), with no client change.
- REQ-06: `EventSource` error → timer path (already present); the client never depends on SSE for correctness.
- REQ-07: on HTTP 400 `Invalid delta parameters` or 3 consecutive non-200 replies the client uses `/api/redis/snapshot` for that layer (existing code path in `src/data/redisMode.js:175-186`).
- REQ-08: client stops sending `cluster` (flag `GEV_CLUSTER_MODE=0` in local storage) and renders entities at every zoom.
- REQ-09: the client's 300,000 ms staleness rule (REQ-07) needs no server support.
- REQ-10: no client contract (server-internal); `/status` dedup counters read 0 after rollback.
- REQ-12: HTTP 404/501 from `/trail` hides the trail feature; `/tracks` failures are logged and ignored.
- REQ-13: HTTP 404 from `/areas` and absence of `geofence` events leave the planner on bounding boxes.
- REQ-14: response shape is unchanged; the client needs no change to revert.
- REQ-15: `/status` fields absent or null → the stats panel hides the figure.
- REQ-16: `cache: "off"` and an empty `candidates` array reproduce today's planner behaviour; the client shows no extra UI.
- REQ-01, REQ-02, REQ-02R, REQ-03: n/a: no consumer-facing contract.

## Validation Report

- Errors: 0
- Warnings: 3
  - Primitives with no rule file in the redis-development bundle are cited by redis.io URL: `WATCH`/`EXEC` null reply (REQ-02), keyspace notifications (REQ-09), Arrays (REQ-12), `GEOSHAPE` on HASH (REQ-03/REQ-13, also Verification step A-7), Top-K/HLL/Bloom command semantics (REQ-14, REQ-15, REQ-10).
  - REQ-12 depends on Redis Arrays availability on the target instance (A-10, runtime check `COMMAND INFO ARRING`); the analysis labels Arrays as preview; the REQ keeps them off the position read path.
  - REQ-16 LangCache is a Redis Cloud preview service (rule file note); the REQ is env-gated and inert without credentials.
- Info: 2
  - DEF-A and DEF-B are DEFERRED with measured triggers; no acceptance scenario exercises them.
  - Weasel lint hits inside REQ bodies: 0 unquoted lowercase; remaining hits are inside backtick-quoted doc quotations.
- Quality gate:
  - 1 numbers: pass (every literal derived inline, cited to `file:line`/doc URL/standard, or `(measure)` with a Baseline row)
  - 2 weasel: 0 unquoted lowercase hits in REQ bodies (hits inside quoted evidence only)
  - 3 units: pass (header `Units used in this document`; TTL in s, latency/interval/timestamp in ms, radius in km, camera height in m)
  - 4 primitives: pass with the URL-cited warning above; replay guard uses WATCH → read → MULTI → checkpoint HSET in-transaction → EXEC → null retry ×3 with a named terminal error
  - 5 interactions: pass (14 rows)
  - 6 consistency: pass (SUPERSEDED rows each point at a MODIFIED or REMOVED REQ; no scenario exercises a Non-Goal)
  - 7 decisions: pass (EXPIRE vs HEXPIRE decided in REQ-03; coherence guard decided in REQ-07; D-1 has owner and due date; DEFERRED rows have owner and trigger)
  - 8 later-clauses: pass (0 hits)
  - 9 interoperability: pass (wire shapes, ids, error bodies, bounds, retry bounds, and per-cycle command counts stated per REQ)
  - 10 dag: pass (16 `### REQ-` headings, 16 `Depends on:` lines, acyclic edge list verified by script, all `REQ-` tokens resolve)
  - 11 slots: REQ-01 filled; REQ-02 filled; REQ-02R filled (Failure mode n/a: static content; Handoff n/a); REQ-03 filled; REQ-04 filled; REQ-05 filled; REQ-06 filled; REQ-07 filled (Rollback: read-only path, server flag); REQ-08 filled; REQ-09 filled; REQ-10 filled; REQ-12 filled; REQ-13 filled; REQ-14 filled; REQ-15 filled; REQ-16 filled
  - 12 assumptions: pass (14 rows, each with Class and pointer)
  - 13 sections: pass (Baseline with 16 rows all referenced; Test Strategy one row per non-deferred REQ; Security and Consumer Rollback per REQ; Cross-REQ and Revision History present)

## Execution Handoff

- Planning skill: `agent-delegation-planning`
- Suggested plan directory: `specs/redis-improvements/plans/`
- Dependency waves (from Derived order): W1 REQ-00 (baseline) → W2 REQ-01, REQ-02 (+REQ-02R), REQ-04, REQ-16 (independent) → W3 REQ-03, REQ-06, REQ-14, REQ-15 → W4 REQ-07, REQ-09, REQ-12, REQ-13 → W5 REQ-08, REQ-05, REQ-10
- Capability names for the ledger (IDs assigned by agent-capability-ledger): baseline-capture; snapshot-single-lrange; projector-watch-multi; hot-position-hash-posidx; cold-doc-flat-fields; cold-doc-enrichment-merge; sse-revision-events; delta-viewport-reads; delta-grid-clusters; expiry-removal-events; ais-bloom-dedup; tracked-trail-arrays; geoshape-areas-geofence; topk-flight-types; hll-distinct-counts; type-vector-langcache
- Validation commands: see Test Strategy

## Revision History

| Revision | Date | Author | Changes |
|---|---|---|---|
| 1 | 2026-09-11 | Pierre Lambert (requester); drafted by Claude Fable 5.1 | New document set from `GEV-Redis-Analysis.md` (PR itay-ct/gods-eye-view#1, head `f5a8007`): baseline table (16 rows), REQ-01–REQ-16 across parts 01–04, REQ-02R removal entry, DEF-A and DEF-B deferred, shared sections, gate results recorded. |
