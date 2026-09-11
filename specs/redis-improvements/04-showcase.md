# Part 4 — Redis showcase surface

## MODIFIED

### REQ-14: Serve the unfiltered flight-type ranking from a per-hour Top-K sketch

- Source: `GEV-Redis-Analysis.md` §11b "Top-K for Type Dropdowns"
- Previous behavior: `GET /api/redis/flight-types` (`server/redis/plugin.js:108-113`) → `flightTypeSummary` → `flightTypeOptions` runs `FT.AGGREGATE gev:flights:idx "@kind:{states} @typeKnown:[1 1]" GROUPBY 1 @typeName REDUCE COUNT 0 AS count SORTBY 4 @count DESC @typeName ASC LIMIT 0 20 DIALECT 2` on every request (`server/redis/flightSearch.js:44-54`), plus two count queries (`:58-66`).
- New behavior: when the `label` parameter is empty, the ranking comes from `TOPK.LIST gev:flights:toptypes:<YYYYMMDDHH> WITHCOUNT`; the projector maintains the sketch with `TOPK.ADD` for each entity's first sighting in the hour. Label-filtered requests keep the `FT.AGGREGATE` path (Top-K cannot filter by label). Response shape unchanged.
- Why: the aggregate scans every indexed flight per dropdown open; Top-K insertion is O(K + depth) and `TOPK.LIST` is O(K log K) (Top-K doc "Performance"), so the dropdown is served from a 20-entry sketch instead of an 11,000-document scan.
- Depends on: REQ-02
- Baseline row: n/a: not a performance change claimed in the baseline table (dropdown latency is not on the acceptance metrics list)
- Evidence checked: `server/redis/flightSearch.js:44-66`; `server/redis/plugin.js:108-113`; `server/redis/payload.js:59-61` (`typeKnown` enrichment); Top-K doc https://redis.io/docs/latest/develop/data-types/probabilistic/top-k/ (`TOPK.RESERVE key k width depth decay_constant`, defaults width 7, depth 8, decay 0.9; example `TOPK.RESERVE bikes:keywords 5 2000 7 0.925`; `TOPK.ADD` returns the demoted item or nil; `TOPK.LIST … WITHCOUNT` per command table); `rules/ram-ttl.md`.
- Impacted files/components: `server/redis/projector.js` (publish phase `SADD` pre-step + `TOPK.ADD`), new `server/redis/topk.js` (`ensureTopK(client, prefix, layer, hour)`), `server/redis/flightSearch.js` (`flightTypeOptions` branch), `server/redis/flightSearch.test.mjs`, new `server/redis/topk.test.mjs`
- Contract shape: keys `gev:flights:toptypes:<YYYYMMDDHH>` (Top-K, `TOPK.RESERVE <key> 20 2000 7 0.925` — k = 20 matches `LIMIT 0 20` at `flightSearch.js:50`; width/depth/decay are the values of the Top-K doc example) and `gev:flights:seenids:<YYYYMMDDHH>` (Set of entity ids sighted this hour), both `EXPIRE 7200` (2 × 3600 s). Per publish batch: pre-read pipeline runs `SADD gev:flights:seenids:<hour> <id>` per entity with `typeKnown` = 1 (returns 1 on first sight); the `EXEC` then contains `TOPK.ADD gev:flights:toptypes:<hour> <typeName>` for each first-sighted entity. `/api/redis/flight-types` response unchanged: `{types: [{name, count}], total, typed}`; `count` = Top-K estimate of distinct aircraft of that type sighted this hour (was: aircraft of that type in the current snapshot).
- Acceptance scenarios:
  - Given: 100 flights projected this hour with `typeName` A320 × 60, B738 × 30, C172 × 10, each ticking 3 times
    When: `redis-cli TOPK.LIST gev:flights:toptypes:<hour> WITHCOUNT`
    Then: `A320 60 B738 30 C172 10` (counts equal distinct aircraft, not 180/90/30 ticks — the `SADD` gate), and `redis-cli SCARD gev:flights:seenids:<hour>` = 100.
  - Given: `GET /api/redis/flight-types` with no `label`
    When: served
    Then: `redis-cli MONITOR` shows `TOPK.LIST gev:flights:toptypes:<hour> WITHCOUNT` and no `FT.AGGREGATE`; response body `{"types":[{"name":"A320","count":60},…],"total":<n>,"typed":<n>}` with the same key set as before the change.
  - Given: `GET /api/redis/flight-types?label=AFR`
    When: served
    Then: `MONITOR` shows the existing `FT.AGGREGATE … @label:(AFR*) …` (unchanged path).
  - Given: the UTC hour changes
    When: the first publish batch of the new hour runs
    Then: `MONITOR` shows `TOPK.RESERVE gev:flights:toptypes:<newhour> 20 2000 7 0.925` and `EXPIRE … 7200` once; `redis-cli TOPK.INFO gev:flights:toptypes:<newhour>` → `k 20 width 2000 depth 7 decay 0.925`; during the first 60,000 ms of the hour (one flights refresh) the endpoint reads the previous hour's key when the new key's `TOPK.LIST` returns fewer than 20 entries.
- Constraints:
  - Flights only in this REQ (the only layer with a type dropdown backed by `FT.AGGREGATE`); `TOPK.RESERVE` errors `ERR key already exists` are caught (race between batches).
  - Set memory: 11,000 ids × (6 bytes + ≈ 50 bytes Set entry overhead) ≈ 616 KB per hour key, 2 keys resident ≈ 1.2 MB.
  - The `SADD` runs outside the `EXEC` (its reply gates the `TOPK.ADD`); a crash between them loses at most one count per entity per hour (undercount, corrected at the next hour boundary).
- Failure mode: caller-visible: if `TOPK.LIST` errors (module absent, key missing) the endpoint falls back to the `FT.AGGREGATE` path and logs one warning; crash mid-write: `TOPK.ADD` is inside `EXEC` (all-or-nothing with the batch); the `SADD` gate is outside (see Constraints).
- Rollback: remove the `SADD`/`TOPK.ADD` steps; `flightTypeOptions` uses `FT.AGGREGATE` for all requests; keys expire within 7200 s.
- Observability: `redis-cli TOPK.INFO gev:flights:toptypes:<hour>`; `redis-cli SCARD gev:flights:seenids:<hour>`; `/api/redis/status` → `topkSource: "topk"|"aggregate"` for the last dropdown request.
- Compatibility impact: `count` semantics change from "in current snapshot" to "distinct this hour" for the unfiltered dropdown; the client displays the number unchanged (`src/data/redisMode.js:83` consumes `types[].count`).
- Migration: none; the first hour after deploy has a partially filled sketch until every active flight has ticked once (≤ 30,000 ms).
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/topk.test.mjs server/redis/flightSearch.test.mjs`.
- Supersedes: `FT.AGGREGATE` ranking for the unfiltered `/flight-types` request (`server/redis/flightSearch.js:44-54`)
- Handoff task, if any: Hourly Top-K flight-type ranking with first-sight gating

## ADDED

### REQ-12: Per-tracked-entity trail ring buffers and event logs on Redis Arrays

- Source: `GEV-Redis-Analysis.md` §10 "Redis Arrays — Track History and Event Logs" (10a, 10b)
- Depends on: REQ-02, REQ-03
- Baseline row: B5, B15
- Rationale: Arrays give a fixed-size ring buffer per numeric series (`ARRING` "Inserts values into a ring buffer of specified size, wrapping and truncating as needed"), single-pass aggregates (`AROP … MAX`) and text search over elements (`ARGREP`). Writes are scoped to entities the user tracks (analysis §10a: "Scope to visible or tracked entities from the start"), so the projector cost is bounded by the tracked-set cap, not the catalogue.
- Evidence checked: Arrays doc https://redis.io/docs/latest/develop/data-types/arrays/ (command table "Since 8.8.0" for all 18 commands; `ARRING key size value`: "Each call inserts a value at insert_idx % size, wrapping back to index 0 once the window is full"; `ARLASTITEMS key count [REV]` "retrieves the N most recently inserted elements in chronological order"; `AROP key start end SUM|MIN|MAX|…`; `ARINSERT` auto-advancing cursor; `ARGREP key start end EXACT|MATCH|GLOB|RE … [NOCASE] [WITHVALUES] [LIMIT]`; ARRING complexity "O(M) normally, O(N+M) on ring resize"); `server/redis/README.md:9` (tested with Redis 8.10.0 ≥ 8.8.0); `src/data/flights.js:4181` (squawk index 14); `src/data/militaryAwareness.js:536-543` (`refocusTrackedById`, tracked entity concept); `rules/ram-ttl.md`.
- Impacted files/components: `server/redis/projector.js` (publish phase: `ARRING` × 4 + `EXPIRE` × 4 for tracked ids; squawk-change `ARINSERT`), new `server/redis/tracks.js` (tracked-set registry, endpoints), `server/redis/plugin.js` (routes `/tracks`, `/trail`, `/track-events`), `src/data/flights.js` and `src/data/aisLiveVessels.js` (trail polyline from `/trail`), `src/data/militaryAwareness.js` (calls `/tracks` on track/untrack), new `server/redis/tracks.test.mjs`
- Contract shape: keys `gev:<layer>:trail:<id>:lat`, `:lon`, `:alt`, `:ts` (one Array each, ring size 240) and `gev:<layer>:events:<id>` (Array, `ARINSERT`); 240 slots × `updateInterval` = 240 × 30,000 ms = 7,200,000 ms = 120 min of flights history (AIS: 240 × 60,000 ms = 240 min); `EXPIRE` = 2 × 240 × interval_s = 14,400 s (flights) / 28,800 s (AIS), refreshed on every write. Endpoints (same-origin, JSON): `POST /api/redis/tracks` body `{"layer":"<live layer>","id":"<id>","action":"add"|"remove"}` → HTTP 200 `{"tracked":["<id>",…]}` (current set for the layer); HTTP 409 `{"error":"Track limit reached"}` when adding beyond 100 ids per layer; HTTP 400 `{"error":"Invalid track request"}`. `GET /api/redis/trail?layer=&id=&n=<1..240>` → HTTP 200 `{"lat":[…],"lon":[…],"alt":[…],"ts":[…],"maxAlt":<number|null>}` (arrays of length ≤ n, oldest first, from `ARLASTITEMS <key> <n>` × 4 and `AROP <alt key> 0 239 MAX`); HTTP 404 `{"error":"No trail"}` when the `:ts` key is absent. `GET /api/redis/track-events?layer=&id=&match=<text>` → HTTP 200 `{"events":[{"index":<int>,"value":"<json string>"}]}` from `ARGREP <events key> - + MATCH <text> WITHVALUES LIMIT 0 100` (`match` absent → `ARGETRANGE <key> 0 99`). Event value = JSON `{"kind":"squawk","from":"<old>","to":"<new>","ts":<ms>}`.
- Acceptance scenarios:
  - Given: `POST /api/redis/tracks {"layer":"flights","id":"34454b","action":"add"}` returned 200, then 3 flights ticks
    When: `redis-cli ARLASTITEMS gev:flights:trail:34454b:lat 3` and `redis-cli ARINFO gev:flights:trail:34454b:lat`
    Then: 3 latitude strings oldest-first, and `ARINFO` reports the ring size 240; `redis-cli TTL gev:flights:trail:34454b:lat` in (0, 14400]; `redis-cli MONITOR` during a tick shows for this id exactly 4 `ARRING gev:flights:trail:34454b:<f> 240 <value>` and 4 `EXPIRE … 14400` inside the `MULTI`, and none for untracked ids.
  - Given: 241 ticks written
    When: `redis-cli ARLASTITEMS gev:flights:trail:34454b:ts 240`
    Then: 240 values, the first being the 2nd tick's `ts` (oldest slot overwritten — ring semantics).
  - Given: `GET /api/redis/trail?layer=flights&id=34454b&n=20`
    When: served
    Then: HTTP 200 with four arrays of equal length ≤ 20 and `maxAlt` equal to `redis-cli AROP gev:flights:trail:34454b:alt 0 239 MAX`; `MONITOR` shows 4 `ARLASTITEMS` + 1 `AROP`.
  - Given: tracked flight's squawk changes from `1000` to `7700` between ticks (pre-read hot hash `sq` differs from incoming `source[14]`)
    When: the publish batch executes
    Then: `MONITOR` shows `ARINSERT gev:flights:events:34454b {"kind":"squawk","from":"1000","to":"7700","ts":<ms>}` inside the `MULTI`, and `GET /api/redis/track-events?layer=flights&id=34454b&match=7700` returns that event.
  - Given: 100 ids tracked for flights
    When: `POST /api/redis/tracks` adds a 101st
    Then: HTTP 409 `{"error":"Track limit reached"}`; B15: `INFO memory` `used_memory` growth ≤ 1.6 MB (100 × 4 × 240 × 16 bytes; 16 bytes = 13-digit ms string + Array element overhead (measure)).
  - Given: `action: "remove"` for a tracked id
    When: the next tick runs
    Then: no `ARRING` for that id; the arrays remain until their TTL elapses (`TTL` still > 0).
- Constraints:
  - Tracked set is in server memory (`Map<layer, Set<id>>`), cap 100 per layer; it is lost on restart (client re-`POST`s on reconnect of the REQ-06 SSE stream).
  - Struct-of-arrays layout (one Array per series) so `AROP … MAX/MIN/SUM` works on numeric series; a single JSON-per-slot array cannot be aggregated.
  - Commands per tick: tracked ids in the batch × 8 (+1 `ARINSERT` on a squawk change); worst case per flights cycle = 100 × 8 = 800 commands spread across 440 batches.
  - Events are recorded for flights only (`sq` field, REQ-03); the `kind` set is `squawk` in this REQ.
  - Requires Redis ≥ 8.8.0 (Arrays command table); verified at startup with `COMMAND INFO ARRING` — a nil reply disables this REQ's writes and endpoints return HTTP 501 `{"error":"Redis Arrays unavailable"}`.
- Failure mode: caller-visible: HTTP 404 `No trail` before the first tick after tracking; HTTP 501 when Arrays are unavailable; crash mid-write: `ARRING`/`EXPIRE`/`ARINSERT` are inside `EXEC` — a slot is either fully written or not; a missed tick leaves a time gap between adjacent slots (the client reads `ts` and draws a break when the gap exceeds 2 × `updateInterval`).
- Rollback: remove the writes and routes; `redis-cli --scan --pattern 'gev:*:trail:*' | xargs redis-cli DEL` (or wait for TTL); the client hides trails when `/trail` returns 404/501.
- Observability: `redis-cli ARINFO gev:flights:trail:<id>:ts`; `/api/redis/status` → `tracked: {flights: <n>, …}`; `redis-cli INFO memory` `used_memory` (B15).
- Compatibility impact: additive keys and endpoints; the client trail rendering replaces the in-memory tracked trail head for the tracked entity when `/trail` returns data (existing per-frame `_trailHeadEntity` stays for the current segment, `flights.js:2621-2623`).
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/tracks.test.mjs` (requires a Redis ≥ 8.8 test container; the test skips with a logged reason when `COMMAND INFO ARRING` is nil).
- Handoff task, if any: Tracked-entity trail and event Arrays with track/trail endpoints

### REQ-13: Named-area polygons as GEOSHAPE with server-side geofence events

- Source: `GEV-Redis-Analysis.md` §11a "GEOSHAPE Polygons for Named Areas"
- Depends on: REQ-03, REQ-06
- Baseline row: B13
- Rationale: the NL planner answers "over Texas" with an approximate bounding box (`userSearch.js:181` instructions: region "explicitly labeled approximate, never an exact country border"). Storing named polygons as `GEOSHAPE` and querying entities with `@shape:[WITHIN $poly]` gives exact containment, and a per-cycle set difference yields enter/exit events over SSE.
- Evidence checked: `server/redis/userSearch.js:170-189` (region bounding boxes in the planner contract); geoindex doc https://redis.io/docs/latest/develop/ai/search-and-query/indexing/geoindex/ (`GEOSHAPE` WKT `POLYGON ((lon lat, …))` and `POINT (lon lat)`; `WITHIN` query with `PARAMS` and `DIALECT 2`; `SPHERICAL` for geographic coordinates); field types doc (operators `WITHIN`, `CONTAINS`, `INTERSECTS`, `DISJOINT`; `GEOSHAPE` has no `SORTABLE`); `rules/rqe-field-types.md` ("GEOSHAPE for areas"); `src/data/local_data/natural_earth/` (existing boundary data directory — content is Verification step A-8); REQ-03 `shape` field.
- Impacted files/components: new `server/redis/areas.js` (import, index, geofence loop), `server/redis/plugin.js` (`/areas` route), `server/redis/userSearch.js` (planner uses `@shape:[WITHIN $poly]` when a named area matches an imported polygon), `server/redis/events.js` (`geofence` SSE event), `src/data/redisMode.js` (alert marker on `geofence`), new `server/redis/areas.test.mjs`, `src/data/local_data/areas/` (curated GeoJSON)
- Contract shape: area docs `gev:areas:<slug>` = JSON `{"name": "<display>", "slug": "<a-z0-9-> ", "kind": "country"|"airspace"|"chokepoint", "boundary": "POLYGON ((<lon> <lat>, …))"}`; index `FT.CREATE gev:areas:idx ON JSON PREFIX 1 gev:areas: SCHEMA $.name AS name TEXT NOSTEM $.slug AS slug TAG $.kind AS kind TAG $.boundary AS boundary GEOSHAPE SPHERICAL`. Point-in-area lookup: `FT.SEARCH gev:areas:idx "@boundary:[CONTAINS $pt]" PARAMS 2 pt "POINT (<lon> <lat>)" RETURN 2 name kind DIALECT 2`. Entities in area: `FT.SEARCH gev:<layer>:posidx "@shape:[WITHIN $poly]" PARAMS 2 poly "<WKT POLYGON>" NOCONTENT LIMIT 0 10000 DIALECT 2`. Geofence run: after each `finish` `rev` event for a live layer, for every polygon with `kind` ∈ {`airspace`, `chokepoint`} (cap 50 polygons), one WITHIN query; ids entering/leaving versus the previous run → `PUBLISH gev:geofence {"type":"enter"|"exit","area":"<slug>","layer":"<layer>","id":"<id>","at":<ms>}` → SSE `event: geofence` with the same body. `GET /api/redis/areas?lon=&lat=` → HTTP 200 `{"areas":[{"slug","name","kind"}]}` (CONTAINS lookup); `GET /api/redis/areas?slug=<slug>&layer=<live layer>` → HTTP 200 `{"count":<n>,"ids":["…"]}` (WITHIN lookup); HTTP 404 `{"error":"Unknown area"}`.
- Acceptance scenarios:
  - Given: `gev:areas:texas` imported with the Texas boundary polygon
    When: `redis-cli FT.SEARCH gev:areas:idx "@boundary:[CONTAINS $pt]" PARAMS 2 pt "POINT (-97.7 30.3)" RETURN 1 name DIALECT 2`
    Then: reply lists `gev:areas:texas` with `name Texas`; the same query with `POINT (2.35 48.86)` returns 0 results.
  - Given: 3 hot hashes with `shape` inside the Texas polygon and 5 outside
    When: `GET /api/redis/areas?slug=texas&layer=flights`
    Then: HTTP 200 `{"count":3,"ids":[…3 ids…]}`; `MONITOR` shows one `FT.SEARCH gev:flights:posidx "@shape:[WITHIN $poly]" …`.
  - Given: polygon `us-adiz` (`kind: airspace`), flight `34454b` outside at cycle N and inside at cycle N+1
    When: the geofence run after cycle N+1's `finish` event executes
    Then: `redis-cli SUBSCRIBE gev:geofence` prints `{"type":"enter","area":"us-adiz","layer":"flights","id":"34454b","at":<ms>}` and the SSE stream shows `event: geofence` with that body; when the flight leaves, an `exit` message follows; queries per run = number of airspace/chokepoint polygons (≤ 50).
  - Given: NL query "how many flights over Texas" and `gev:areas:texas` present
    When: `POST /api/redis/search/plan`
    Then: the compiled plan targets `gev:flights:posidx` with query `@shape:[WITHIN $poly]` and `params: {poly: "<WKT>"}`, `region: null`, and the explanation names the polygon (not "approximate").
  - Given: B13 measured at 50, 200 and 1000 vertices
    When: compared with the 60 ms per-polygon budget
    Then: the import simplifies polygons (Douglas–Peucker) to the largest vertex count whose measured latency is ≤ 60 ms; the chosen count is recorded in `baseline-capture.json` under `B13.vertexCap`.
- Constraints:
  - Curated data only: `src/data/local_data/areas/*.geojson` (WGS84 lon/lat, first ring only, closed ring required); import runs at `ensure('flights')` and upserts docs by `slug`; polygons crossing the antimeridian are split into two docs `<slug>-e` / `<slug>-w`.
  - Geofence set-diff state is in server memory (`Map<slug, Set<id>>`); on restart the first run emits `enter` for every entity currently inside (no `exit` storm).
  - Polygon cap 50 for geofencing; unlimited for lookup-only areas (`kind: country`).
- Failure mode: caller-visible: HTTP 404 for unknown slug; a WITHIN query error (malformed WKT) skips that polygon and logs one warning per import; read-only queries → no crash-mid-write case; area docs are written with `JSON.SET` outside the projector transaction (idempotent upsert, re-run on restart).
- Rollback: `FT.DROPINDEX gev:areas:idx DD` (removes area docs), remove the geofence loop and routes; the planner falls back to bounding boxes.
- Observability: `redis-cli FT.INFO gev:areas:idx` → `num_docs` = imported polygon count; `/api/redis/status` → `geofence: {polygons: <n>, lastRunMs: <ms>, events: <n>}`; `redis-cli PUBSUB NUMSUB gev:geofence` = 1.
- Compatibility impact: additive; the NL planner's `region` bounding-box behaviour remains for areas without a polygon.
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/areas.test.mjs` (fixture: a square polygon and points inside/outside); `redis-cli FT.SEARCH gev:areas:idx "*" RETURN 1 slug LIMIT 0 100`.
- Handoff task, if any: GEOSHAPE area index, geofence loop, and planner polygon routing

### REQ-15: Distinct-entity counts per hour with HyperLogLog

- Source: `GEV-Redis-Analysis.md` §11c "HyperLogLog for Distinct Counts"
- Depends on: REQ-02
- Baseline row: n/a: not a performance change
- Rationale: "N distinct aircraft seen this hour" is a stats-panel figure that today has no source (`/api/redis/status`, `plugin.js:77-89`, reports stream stats only). One `PFADD` per batch and one `PFCOUNT` per status poll deliver it in 12 KB per key (HLL doc: "uses up to 12 KB of memory and provides a standard error rate of 0.81%").
- Evidence checked: `server/redis/plugin.js:77-89` (`/status`), `src/data/redisMode.js:283` (status poll every 2000 ms); HLL doc https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/ (`PFADD` O(1), `PFCOUNT` O(1), `PFMERGE`, 12 KB, 0.81% standard error); `rules/ram-ttl.md`.
- Impacted files/components: `server/redis/projector.js` (publish phase `PFADD`), `server/redis/pipeline.js` (`stats()` adds `PFCOUNT`), `src/data/redisMode.js` (stats panel field), `server/redis/pipeline.test.mjs`
- Contract shape: key `gev:<layer>:distinct:<YYYYMMDDHH>` (HLL) with `EXPIRE 7200` set on creation (first `PFADD` of the hour, detected by `PFADD` returning 1 on a key whose `TTL` is −1 → pipelined `EXPIRE`); one variadic `PFADD <key> <id1> … <id25>` per publish batch inside the `EXEC`. `/api/redis/status` per-layer field `distinctHour: <int>` = `PFCOUNT gev:<layer>:distinct:<current hour>` and `distinctPrevHour: <int>`.
- Acceptance scenarios:
  - Given: 8,000 distinct flights projected this hour, each ticking 120 times
    When: `redis-cli PFCOUNT gev:flights:distinct:<hour>`
    Then: a value in [7,806, 8,194] (8,000 ± 3 × 0.81% = ± 194); `redis-cli MEMORY USAGE gev:flights:distinct:<hour>` ≤ 12,000 bytes + key overhead (≤ 12,400).
  - Given: a publish batch of 25 records
    When: its `EXEC` runs
    Then: `MONITOR` shows one `PFADD gev:flights:distinct:<hour> <25 ids>` inside the `MULTI`.
  - Given: `GET /api/redis/status`
    When: served
    Then: `layers.flights.distinctHour` is an integer equal to the `PFCOUNT` value at that moment; `MONITOR` shows one `PFCOUNT` per live layer per status request (3 per poll).
- Constraints: live layers only; the ingest of the previous hour's key is read-only after the hour boundary (`distinctPrevHour`).
- Failure mode: caller-visible: `distinctHour` = null in `/status` when `PFCOUNT` errors; crash mid-write: `PFADD` inside `EXEC` (all-or-nothing with the batch).
- Rollback: remove `PFADD`/`PFCOUNT`; keys expire within 7200 s.
- Observability: `redis-cli PFCOUNT gev:flights:distinct:<hour>` > 0 after one batch; `redis-cli TTL gev:flights:distinct:<hour>` in (0, 7200].
- Compatibility impact: additive fields in `/status`; 3 `PFCOUNT` per 2000 ms status poll.
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/pipeline.test.mjs` (assert `PFCOUNT` within ±3% of the fixture's 10,000 distinct ids: [9,700, 10,300]).
- Handoff task, if any: Hourly HyperLogLog distinct counts in projector and status

### REQ-16: Semantic type lookup via a vector index and LangCache in front of the NL planner

- Source: `GEV-Redis-Analysis.md` §11d "Vector Search + Semantic Cache"
- Depends on: none
- Baseline row: B12, B14
- Rationale: the planner maps "fuel tankers" to stored `typeName` values only through the top-20 values it is shown (`userSearch.js:181`). Embedding the type vocabulary (B14 distinct names) into a small `FLAT` vector index lets the server hand the planner the 5 nearest type names for any phrase. LangCache returns a cached plan for a semantically equal prompt without an LLM call (`rules/semantic-cache-langcache-usage.md`: "If found (cache hit), returns the cached response instantly").
- Evidence checked: `server/redis/userSearch.js:28-54` (`categoryValues` top-20 extraction), `:162-168` (`openAI()` with `OPENAI_API_KEY`), `:170-189` (`generatePlan`, model `gpt-5.6-terra`); vector search doc https://redis.io/docs/latest/develop/ai/search-and-query/query/vector-search/ (`FT.SEARCH index "(*)=>[KNN k @field $vector AS dist]" PARAMS 2 vector <blob> SORTBY dist DIALECT 2`; JSON vectors as arrays of numbers; `COSINE` metric); `rules/vector-index-creation.md` (`TYPE FLOAT32 DIM 1536 DISTANCE_METRIC COSINE`); `rules/vector-algorithm-choice.md` (`FLAT` for small datasets, exact); `rules/semantic-cache-langcache-usage.md` (`POST /v1/caches/{cacheId}/entries/search` with `{"prompt"}`; `POST /v1/caches/{cacheId}/entries` with `{"prompt","response"}`; custom attributes); `rules/semantic-cache-best-practices.md` ("Start with threshold 0.9"; separate caches per task; LangCache is in preview on Redis Cloud); OpenAI embeddings https://platform.openai.com/docs/guides/embeddings (`text-embedding-3-small`, 1536 dimensions).
- Impacted files/components: new `server/redis/typeVectors.js` (vocabulary refresh, embedding, index), new `server/redis/semanticCache.js` (LangCache client), `server/redis/userSearch.js` (planner input gains `typeCandidates`; cache check before `generatePlan`), `server/redis/plugin.js` (`/search/types` route), `.env.example` (`LANGCACHE_URL`, `LANGCACHE_CACHE_ID`, `LANGCACHE_API_KEY`), new `server/redis/typeVectors.test.mjs`, `server/redis/userSearch.test.mjs`
- Contract shape: docs `gev:flights:typevec:<slug>` = JSON `{"name": "<typeName>", "embedding": [<1536 floats>]}`; index `FT.CREATE gev:flights:typevec:idx ON JSON PREFIX 1 gev:flights:typevec: SCHEMA $.name AS name TAG $.embedding AS embedding VECTOR FLAT 6 TYPE FLOAT32 DIM 1536 DISTANCE_METRIC COSINE`; query `FT.SEARCH gev:flights:typevec:idx "(*)=>[KNN 5 @embedding $vec AS dist]" PARAMS 2 vec <1536 × float32 little-endian blob> RETURN 2 name dist SORTBY dist ASC DIALECT 2`. `GET /api/redis/search/types?q=<text>` → HTTP 200 `{"candidates":[{"name":"<typeName>","dist":<COSINE distance, 0–2>}] (≤ 5, ascending), "threshold": <B12 value or null>}`; HTTP 503 `{"error":"Set OPENAI_API_KEY on the server to use Redis voice search"}` (existing text, `userSearch.js:163`) when embeddings are unavailable. Planner input JSON gains `typeCandidates: [{name, dist}]` (empty array when unavailable). LangCache: before `generatePlan`, `POST {LANGCACHE_URL}/v1/caches/{LANGCACHE_CACHE_ID}/entries/search` with `{"prompt": <user text>, "similarity_threshold": 0.9, "attributes": {"schemaHash": "<sha1 of the schemas JSON>"}}`; a hit returns the stored plan JSON string, parsed and compiled via `compilePlan` (existing); a miss stores `{"prompt", "response": <compiled plan JSON>, "attributes": {"schemaHash"}}` after `generatePlan`. `POST /api/redis/search/plan` response gains `"cache": "hit"|"miss"|"off"`.
- Acceptance scenarios:
  - Given: B14 distinct type names, `OPENAI_API_KEY` set
    When: the server starts and `ensureTypeVectors` runs
    Then: `redis-cli FT.INFO gev:flights:typevec:idx` → `num_docs` = B14 and `index_definition` `key_type JSON`; `redis-cli JSON.ARRLEN gev:flights:typevec:<any> $.embedding` returns `[1536]`; embedding requests = B14 (one per name, batched ≤ 100 inputs per API call → ceil(B14 / 100) HTTP calls).
  - Given: the index populated
    When: `GET /api/redis/search/types?q=fuel%20tankers`
    Then: HTTP 200 with ≤ 5 candidates sorted by `dist` ascending, each `dist` in [0, 2]; `MONITOR` shows one `FT.SEARCH gev:flights:typevec:idx "(*)=>[KNN 5 @embedding $vec AS dist]" …`.
  - Given: `POST /api/redis/search/plan` with text "show refuelling aircraft", LangCache env set, no prior entry
    When: served
    Then: response `cache: "miss"`, one `POST …/entries/search` and one `POST …/entries` to LangCache (assert with a mock server in the test), and the planner input contains `typeCandidates` from the KNN query.
  - Given: the same or a paraphrased prompt ("display the fuel tankers") within the cache TTL
    When: `POST /api/redis/search/plan`
    Then: response `cache: "hit"`, no OpenAI `responses` call (mock records 0), and the compiled plan equals the stored one field-for-field.
  - Given: `LANGCACHE_URL` unset
    When: any plan request
    Then: `cache: "off"`, planner path unchanged from today.
  - Given: B12 captured
    When: the 20-phrase set is replayed
    Then: `threshold` in `/search/types` equals the B12 value and candidates with `dist` > threshold carry `"weak": true`.
- Constraints:
  - Vocabulary refresh every 3,600,000 ms (1 hour): `FT.AGGREGATE gev:flights:idx "@typeKnown:[1 1]" GROUPBY 1 @typeName REDUCE COUNT 0 AS n LIMIT 0 10000 DIALECT 2` → embed names not yet present; docs have no TTL (vocabulary is stable; deleted on `FT.DROPINDEX … DD`).
  - Distance metric `COSINE` everywhere; all thresholds are cosine distances (range 0–2), never similarities. B12 supplies the only threshold constant.
  - LangCache similarity threshold 0.9 (rule file starting value); one cache id dedicated to GEV plans (`rules/semantic-cache-best-practices.md`: separate caches per task); `schemaHash` attribute filters out plans compiled against a different index schema (e.g. after REQ-05 routes live layers to posidx).
  - Cached response = the compiled plan JSON (not the LLM raw output) so a hit skips both the LLM and compilation validation.
- Failure mode: caller-visible: embedding API error → `typeCandidates: []` and `/search/types` HTTP 503 with the OpenAI error message; LangCache HTTP error or timeout (5,000 ms) → `cache: "off"` for that request and the planner runs as today; no durable state besides vocabulary docs (upsert, idempotent) — no crash-mid-write case in the projector transaction.
- Rollback: `FT.DROPINDEX gev:flights:typevec:idx DD`; unset the three `LANGCACHE_*` variables; remove the `typeCandidates` input.
- Observability: `redis-cli FT.INFO gev:flights:typevec:idx` → `num_docs`; `/api/redis/status` → `semanticCache: {hits, misses, off}` counters; `/api/redis/search/status` gains `langCacheConfigured: true|false`.
- Compatibility impact: additive; planner instructions mention `typeCandidates` as preferred stored values (extends the existing "use those actual stored values" rule, `userSearch.js:181`).
- Verification: `node --test server/redis/typeVectors.test.mjs server/redis/userSearch.test.mjs` with mocked OpenAI and LangCache HTTP servers; `redis-cli FT.INFO gev:flights:typevec:idx`.
- Handoff task, if any: Type-vocabulary vector index and LangCache plan cache for NL search
