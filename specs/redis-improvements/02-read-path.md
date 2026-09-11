# Part 2 — Read path (snapshot and delta reads)

## MODIFIED

### REQ-01: Read the snapshot member list with one `LRANGE 0 -1` per group

- Source: `GEV-Redis-Analysis.md` §7 "Single LRANGE for Member List (Immediate Win)"
- Previous behavior: `server/redis/pipeline.js:354-358` pages `LRANGE gev:<layer>:snapshot:<cohort>:members` in windows of 500 per group: `for (let i = 0; i < group.count; i += 500) keys.push(...await client.lRange(key, offset+i, offset+Math.min(i+499, group.count-1)))`. `server/redis/progressive.js:15-27` uses the same 500-element paging for both the committed and the in-progress member lists.
- New behavior: one `LRANGE <members> <offset> <offset + group.count - 1>` per group in `snapshot()`; `progressiveMembers` issues one `LRANGE <key> <offset> <offset + group.count - 1>` per group and keeps its existing short-read check (`page.length < group.count` → stop). The `keys.length !== group.count` guard (`pipeline.js:359`) is unchanged.
- Why: 11,000 members = ceil(11,000 / 500) = 22 round trips before the first `JSON.GET`; one reply of 11,000 keys × ≈ 45 bytes (`gev:flights:entity:states:<6-char icao24>` = 33 characters + RESP framing) ≈ 495 KB replaces them. `rules/conn-blocking.md` advises paginating `LRANGE 0 -1` on large lists; the deviation is deliberate: the list is bounded by the 100,000-record ingest cap (`server/redis/plugin.js:222`), every element is needed, and the same bytes were already transferred in 22 replies.
- Depends on: none
- Baseline row: B3
- Evidence checked: `server/redis/pipeline.js:354-359`; `server/redis/progressive.js:15-27`; `server/redis/plugin.js:222` (`Source snapshot exceeds 100,000 records`); `rules/conn-blocking.md`; `rules/conn-pipelining.md`.
- Impacted files/components: `server/redis/pipeline.js` (`snapshot`), `server/redis/progressive.js` (`progressiveMembers`), `server/redis/pipeline.test.mjs`
- Contract shape: n/a: interface unchanged (HTTP response bytes identical)
- Acceptance scenarios:
  - Given: a committed flights snapshot whose metadata has one group with `count` = 11,000
    When: `GET /api/redis/snapshot?layer=flights&cohort=<cohort>` is served
    Then: `redis-cli MONITOR` shows exactly one `LRANGE gev:flights:snapshot:<cohort>:members 0 10999` and the response body is byte-identical to the response served before this change (compare `shasum -a 256` of both bodies).
  - Given: a snapshot with three groups of counts 3, 4,362, 10 (datacenters shape, `docs/PERFORMANCE.md:51`)
    When: served
    Then: `MONITOR` shows three `LRANGE` commands with ranges `0 2`, `3 4364`, `4365 4374`.
- Constraints: none beyond the existing 100,000-record cap.
- Failure mode: read-only; a short reply (list trimmed by a concurrent `finish`) still triggers `Redis snapshot membership incomplete` (`pipeline.js:359`) and the `consistentRead` retry (`pipeline.js:427-447`). No durable state written.
- Rollback: revert the two loops to 500-element paging.
- Observability: `redis-cli INFO commandstats` → `cmdstat_lrange` `calls` per snapshot read equals the group count (1 for flights) instead of 22.
- Compatibility impact: none.
- Migration: none.
- Verification: `node --test server/redis/pipeline.test.mjs` (existing 10,000-entity fixture) with a `MONITOR` assertion of a single `LRANGE` per group.
- Supersedes: paginated `LRANGE` loops (`server/redis/pipeline.js:354-358`, `server/redis/progressive.js:19-24`)
- Handoff task, if any: Single LRANGE per snapshot group

## ADDED

### REQ-07: Viewport-scoped delta reads for live layers via `FT.SEARCH` on posidx

- Source: `GEV-Redis-Analysis.md` §1 "Viewport-Scoped Delta Reads via FT.SEARCH"
- Depends on: REQ-03
- Baseline row: B1, B3, B4, B8, B16
- Rationale: today every read ships the full catalogue (`pipeline.js:354-388`) regardless of camera or change. One `FT.SEARCH` with a GEO radius, a `ts` lower bound and a `RETURN` projection ships only visible, changed entities.
- Evidence checked: `server/redis/pipeline.js:333-401` (snapshot read path), `:371-374` (existing `FT.SEARCH … NOCONTENT LIMIT 0 100000 DIALECT 2`), `:427-447` (`consistentRead`); `server/redis/plugin.js:117-140` (`/snapshot` route and headers `X-GEV-Data-Path`, `X-GEV-Filtered`); `src/data/redisMode.js:112-160` (`layerFetch` interception; `isView` layers) and `:175-186` (`readProjection`); `src/data/flights.js:602-604, 3893`; `src/data/aisLiveVessels.js:61, 920, 1009`; field types doc (GEO radius query syntax `@field:[lon lat radius unit]`, NUMERIC exclusive bound `[(min +inf]`); `rules/rqe-query-optimization.md` (filters + `LIMIT` + `RETURN`); `rules/rqe-dialect.md` (DIALECT 2); expiration behaviour doc (expired keys are not returned in Redis 8).
- Impacted files/components: `server/redis/plugin.js` (new `/delta` route), new `server/redis/delta.js` (query builder, response encoder), `src/data/redisMode.js` (`layerFetch` routes live layers to `/delta`), `src/data/flights.js` (state apply from delta arrays), `src/data/militaryFlights.js`, `src/data/aisLiveVessels.js` (`applyAisFeedSnapshot`/`reconcileVessels` fed from delta arrays), new `server/redis/delta.test.mjs`, `src/data/redisMode.test.mjs`, `server/redis/README.md` "Entity storage and reads"
- Contract shape: request `GET /api/redis/delta?layer=<live layer>&lon=<deg>&lat=<deg>&radius=<km>&since=<ms>&label=<text>&type=<tag>`; `since` ≥ 0 integer (0 = full viewport), `radius` in (0, 10000] km, `label`/`type` optional and passed to the existing per-layer query builders (`flightQuery`, `militaryQuery`, `aisQuery`) semantics. Redis query: `FT.SEARCH gev:<layer>:posidx "@loc:[<lon> <lat> <radius> km] @ts:[(<since> +inf]<filter terms>" RETURN 7 lat lon alt spd hdg ts sq SORTBY ts DESC LIMIT 0 5000 DIALECT 2` preceded by `GET gev:<layer>:revision` in the same pipeline (2 commands per read). Response HTTP 200, `Content-Type: application/json`, `Cache-Control: no-store`, `X-GEV-Data-Path: redis-posidx`, optional `X-GEV-Truncated: 1`; body `{"rev": <string|null>, "cursor": <ms>, "count": <n>, "updated": [[id, lat, lon, alt, spd, hdg, ts, sq], …]}` where `id` = key suffix after `gev:<layer>:pos:` (string), `lat`/`lon` numbers with 4 decimals, `alt` integer metres or null, `spd` number m/s or null, `hdg` integer degrees or null, `ts` integer ms, `sq` string or null (flights) — 8 values per entity; `cursor` = max `ts` in `updated` or the request's `since` when empty. Size derivation per entity: id 10 (6 hex + quotes + comma) + lat 8 + lon 8 + alt 6 + spd 6 + hdg 4 + ts 14 + sq 7 + framing 4 = 67 bytes → `updated` of 2,000 entities ≈ 134 KB; the 5,000 cap ≈ 335 KB. Errors: HTTP 400 `{"error":"Invalid delta parameters"}` (unknown layer, non-numeric or out-of-range values); HTTP 503 `{"error":"<detail>","stage":"Redis"}` on Redis failure (existing `json(res, 503, …)` pattern, `plugin.js:229`). Truncation: when `FT.SEARCH` total > 5000, header `X-GEV-Truncated: 1`, body holds the 5000 freshest by `ts`.
- Acceptance scenarios:
  - Given: flights active with hot hashes (REQ-03), camera at height 4,000,000 m over lon 2.35 lat 48.86 → client computes `radius` = min(6371 × arccos(6371 / (6371 + 4000)), 1.09 × 4000) = min(5788, 4360) = 4360 km (horizon formula and half-diagonal factor 1.09 = √(tan²(30°) + (1.6 × tan(30°))²) for the default 60° vertical FOV and 1440/900 = 1.6 aspect)
    When: `GET /api/redis/delta?layer=flights&lon=2.35&lat=48.86&radius=4360&since=0`
    Then: HTTP 200 with `updated.length` = the count of hot hashes whose `loc` lies within 4360 km, every element has 8 values, `cursor` equals the largest `ts`, and `redis-cli MONITOR` during the request shows exactly `GET gev:flights:revision` and one `FT.SEARCH gev:flights:posidx …` (B3 = 2). Transfer size ≤ 67 bytes × `count` (B1).
  - Given: the client repeats the request with `since=<cursor>` and no projection ran in between
    When: served
    Then: HTTP 200 `{"rev":"<same>","cursor":<same>,"count":0,"updated":[]}`; body < 120 bytes (= 4 keys × ≈ 25 bytes + rev string 36 + framing).
  - Given: one publish batch wrote 25 hashes with `ts` > `since`, 3 of them inside the radius
    When: the client requests with that `since`
    Then: `count` = 3 and `updated` contains exactly those 3 ids.
  - Given: a viewport containing 6,000 updated hashes
    When: requested with `since=0`
    Then: HTTP 200 with header `X-GEV-Truncated: 1`, `count` = 5000, and `updated[0][6]` ≥ `updated[4999][6]` (sorted by `ts` descending).
  - Given: `radius=20000` or `layer=satellites`
    When: requested
    Then: HTTP 400 `{"error":"Invalid delta parameters"}`.
  - Given: Redis mode ON, flights layer enabled, `DELTA_LAYERS` includes `flights`
    When: the browser refreshes the flights view
    Then: Chrome DevTools → Network shows `/api/redis/delta?layer=flights…` and no `/api/redis/snapshot?layer=flights…`; billboard count on screen equals `count` of the last non-truncated response (assert via `window.__gevDebug.flightsBillboardCount()` test hook added with this REQ).
- Constraints:
  - Client cursor rule: `since` = previous response `cursor`; reset to 0 whenever the rounded query circle changes (center rounded to 0.1° ≈ 11.1 km, radius rounded to the nearest 50 km = 1/100 of the 5000 km globe-scale radius) or after a `rev` change with a gap in `rev` events longer than 300,000 ms (= the hot hash TTL, REQ-03).
  - Removal rule (client): an entity absent from `updated` for 300,000 ms since its last `ts` is removed (equals the hot hash TTL); REQ-09 removes earlier when an `expired` event arrives. `MISSING_POLL_LIMIT` (`flights.js:604`) is not used on the delta path.
  - Coherence: no `consistentRead` guard on this path. Each hash is written atomically inside REQ-02's `EXEC`, and a delta read has no membership list to keep consistent; `rev` is returned for display and cursor-reset logic only. (Decision recorded here; alternative rejected: a `publishing`/`revision` retry loop would add 2 `MGET` per read and up to 3 retries for a path with no cross-key invariant.)
  - The ingest trigger (`POST /api/redis/ingest`, `redisMode.js:135-140`) is unchanged: the client still starts source polling on the layer's `updateInterval`; only the read leg changes. The snapshot endpoint stays for every other layer and for `DELTA_LAYERS`-excluded live layers.
  - Query count per client refresh cycle: 1 `/delta` request → 2 Redis commands (derived above).
- Failure mode: caller-visible: HTTP 503 with the existing detail string when Redis is unreachable; the client falls back to `/api/redis/snapshot` for that layer after 3 consecutive non-200 responses and retries `/delta` on the next `rev` event. Read-only: no durable state, no crash-mid-write case.
- Rollback: remove the layer from `DELTA_LAYERS`; the client detects HTTP 400 `Invalid delta parameters` for that layer and uses `/snapshot`; cold docs are still written per tick until REQ-05, so snapshot data is current.
- Observability: `/api/redis/status` (`plugin.js:77-89`) gains per-layer counters `deltaRequests`, `deltaEntities`, `deltaTruncated` (integers since process start); `redis-cli FT.INFO gev:flights:posidx` → `num_docs` > 0.
- Compatibility impact: additive endpoint; the snapshot endpoint's contract is unchanged. The client's flights module gains a second input path (delta arrays) beside the OpenSky envelope path.
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/delta.test.mjs src/data/redisMode.test.mjs`; manual: DevTools Network filter `delta` shows 8-value rows.
- Handoff task, if any: Delta read endpoint and client delta input path for live layers

### REQ-08: Density clusters at low zoom via `FT.AGGREGATE` grid binning on posidx

- Source: `GEV-Redis-Analysis.md` §2 "Density Clustering at Low Zoom via FT.AGGREGATE"
- Depends on: REQ-07
- Baseline row: B2, B9
- Rationale: the globe view draws one billboard per entity (11,000 for flights). Grouping by a degree grid server-side returns one centroid + count per occupied cell. Binning uses `APPLY floor(@lat / step)` / `floor(@lon / step)` on the `SORTABLE` `lat`/`lon` fields already in posidx — no extra write-time field, no geohash library (`FT.AGGREGATE` doc: `floor` is a built-in APPLY function; `SORTABLE` attributes are available to the pipeline without `LOAD`).
- Evidence checked: `server/redis/flightSearch.js:44-54` (existing `FT.AGGREGATE … GROUPBY … REDUCE COUNT … SORTBY … LIMIT` usage); FT.AGGREGATE https://redis.io/docs/latest/commands/ft.aggregate/ (`APPLY {expr} AS {name}`; `floor(x)`; `GROUPBY {nargs} {property}`; `REDUCE COUNT 0`, `REDUCE AVG 1 @field`; `SORTBY … MAX`; "Attributes needed for aggregations should be stored as SORTABLE"); REQ-03 Contract shape (`lat NUMERIC SORTABLE`, `lon NUMERIC SORTABLE`); CesiumJS `Camera.positionCartographic.height` (metres) https://cesium.com/learn/cesiumjs/ref-doc/Camera.html.
- Impacted files/components: `server/redis/delta.js` (cluster branch), `server/redis/plugin.js` (`cluster` parameter validation), `src/data/flights.js`, `src/data/militaryFlights.js`, `src/data/aisLiveVessels.js` (cluster billboard mode + mode switch on camera height), `server/redis/delta.test.mjs`
- Contract shape: request adds `cluster=<step in degrees ∈ {10, 5, 2, 1}>` to the REQ-07 query string; when present the server runs `FT.AGGREGATE gev:<layer>:posidx "@loc:[<lon> <lat> <radius> km] @ts:[(<since> +inf]<filter terms>" APPLY "floor(@lat / <step>)" AS cy APPLY "floor(@lon / <step>)" AS cx GROUPBY 2 @cx @cy REDUCE COUNT 0 AS n REDUCE AVG 1 @lat AS clat REDUCE AVG 1 @lon AS clon SORTBY 2 @n DESC MAX 2000 LIMIT 0 2000 DIALECT 2` (+ `GET gev:<layer>:revision`); response HTTP 200 `{"rev": <string|null>, "cursor": <ms>, "count": <cells>, "step": <deg>, "clusters": [[n, clat, clon], …]}` with `n` integer, `clat`/`clon` numbers with 4 decimals — 3 values per cell, ≈ 9 bytes each + framing 4 = 31 bytes per cell (B2 target rounds to 40). `since` is echoed as `cursor` (clusters carry no per-entity `ts`). Errors as REQ-07; `cluster` outside the set → HTTP 400 `{"error":"Invalid delta parameters"}`.
- Acceptance scenarios:
  - Given: flights active, camera height 15,000,000 m over lon 0 lat 30 → client radius = 6371 × arccos(6371 / 21371) = 8078 km (horizon bound; 1.09 × 15000 = 16350 km exceeds it), `cluster=10`
    When: `GET /api/redis/delta?layer=flights&lon=0&lat=30&radius=8078&since=0&cluster=10`
    Then: HTTP 200 with `count` ≤ 648 (36 × 18 possible 10° cells worldwide), Σ `n` over `clusters` = the `count` REQ-07 returns for the same circle without `cluster`, and transfer size ≤ 40 bytes × `count` (B2). `redis-cli MONITOR` shows one `FT.AGGREGATE` and one `GET`.
  - Given: two hashes at (lat 48.86, lon 2.35) and (lat 41.9, lon 12.5), `cluster=10`
    When: requested with a radius covering both
    Then: `clusters` has two entries `[1, 48.86, 2.35]` and `[1, 41.9, 12.5]` (cells cy=4,cx=0 and cy=4,cx=1); with `cluster=5` also two; only a hypothetical `cluster=20` (not in the set) would merge them.
  - Given: the camera height crosses 500,000 m downward
    When: the client's next refresh runs
    Then: the request omits `cluster` and the layer switches to entity billboards from REQ-07; crossing upward past 500,000 m adds `cluster=1`; past 2,000,000 m → `cluster=2`; past 5,000,000 m → `cluster=5`; past 10,000,000 m → `cluster=10`. Check: DevTools Network query strings; Cesium `viewer.camera.positionCartographic.height` read at request time.
- Constraints:
  - Step table (single unit: camera height in metres): height ≥ 10,000,000 → step 10; [5,000,000, 10,000,000) → 5; [2,000,000, 5,000,000) → 2; [500,000, 2,000,000) → 1; < 500,000 → entity mode. Cells across the query circle at each row: diameter ≈ 2 × radius; at height 5,000,000 m radius = min(6371 × arccos(6371/11371) = 6371 × 0.976 = 6218, 1.09 × 5000 = 5450) = 5450 km ≈ 49° → 98° / 5° ≈ 20 cells across; at 2,000,000 m radius = 2180 km ≈ 20° → 40° / 2° = 20 cells; at 500,000 m radius = 545 km ≈ 5° → 10° / 1° = 10 cells. Group count is therefore ≤ 648 at step 10 and ≤ 20² = 400 elsewhere, under the `MAX 2000` bound.
  - Cluster size on screen is a client concern: billboard scale = 8 + 4 × log10(n) pixels (8 px minimum matches the entity dot; log scale keeps a 1,000-entity cell at 20 px).
  - Freshness: `@ts:[(since +inf]` is kept in the aggregate so stale hashes (none survive past 300 s anyway) are excluded when `since` > 0; the client sends `since=0` in cluster mode (clusters are recomputed, not diffed).
  - Query count per client refresh cycle in cluster mode: 1 request → 2 Redis commands.
- Failure mode: read-only. HTTP 503 on Redis failure; client falls back to entity mode (REQ-07) for that cycle. No durable state.
- Rollback: client stops sending `cluster`; server branch stays inert.
- Observability: `/api/redis/status` counter `deltaClusterRequests` per layer; `redis-cli FT.PROFILE gev:flights:posidx AGGREGATE QUERY "@loc:[0 30 8078 km]" APPLY "floor(@lat / 10)" AS cy APPLY "floor(@lon / 10)" AS cx GROUPBY 2 @cx @cy REDUCE COUNT 0 AS n DIALECT 2` → `Total profile time` (measure).
- Compatibility impact: additive parameter; entity mode unchanged.
- Verification: `node --test server/redis/delta.test.mjs` includes the two-hash scenario; manual globe view shows ≤ 648 cluster billboards.
- Handoff task, if any: Grid-binned cluster mode for the delta endpoint and client renderer
