# Part 1 — Write path (projector)

Rule files cited as `rules/<name>.md` live in `~/.claude/skills/redis-development/rules/` (redis/agent-skills `redis-development` bundle).

## MODIFIED

### REQ-02: Replace the STAGE and COMMIT Lua scripts with pipelined pre-reads plus one WATCH/MULTI/EXEC transaction per batch

- Source: `GEV-Redis-Analysis.md` §5 "Eliminate BUSY Errors — Lua to MULTI/Pipeline"
- Previous behavior: `server/redis/projector.js:8-19` (`STAGE`: per event `JSON.SET` staging doc + `EXPIRE 86400` + `XACK`, inside one script) and `server/redis/projector.js:21-161` (`COMMIT`: phases `begin`, `publish`, `cleanup`, `finish`; per entity `JSON.GET` staged, enrichment merge `projector.js:95-114`, `JSON.SET` cold doc `:120`, `EXPIRE` `:121`, `CMS.INCRBY` `:122`, `RPUSH` `:123`, `SADD` `:124`, `UNLINK` `:125`; checkpoint `HSET work publish` `:127`), invoked via `EVALSHA` with `NOSCRIPT` fallback (`server/redis/pipeline.js:212-224`).
- New behavior: the consumer loop (`pipeline.js:176-211`) performs the same per-record work without Lua. STAGE becomes a non-transactional pipeline (`JSON.SET` + `EXPIRE 86400` per record, then `XACK` per event). Each COMMIT phase batch becomes: (1) pipelined pre-reads on the layer's dedicated writer connection; (2) `WATCH gev:<layer>:projection-schema gev:<layer>:publishing gev:<layer>:staging:<token>:commit`; (3) `GET`/`GET`/`HGET` of the three watched keys and comparison with the values the Lua `CHECK_EPOCH` and checkpoint tests compare (`projector.js:3-7, 79-84, 85-87, 129-131`); (4) `MULTI` … `EXEC` containing every write of the phase plus the checkpoint `HSET`; (5) on `EXEC` = null reply, repeat from step 1, at most 3 attempts, then throw `Error('Projection checkpoint conflict')`, which the existing consumer error path records in `state.error` (`pipeline.js:180-211`).
- Why: a Lua script blocks every client for its full duration and returns `BUSY` above the busy threshold (`server/redis/README.md:265-268`). `EXEC` is also serialized (transactions doc: "A request sent by another client will never be served in the middle of the execution of a Redis Transaction") but contains only writes; the reads and the enrichment merge happen before `WATCH`, so the blocked window is the write-only `EXEC` (command count derived in Constraints) rather than reads + JSON decode + writes.
- Depends on: none
- Baseline row: B5, B6, B10
- Evidence checked: `server/redis/projector.js:3-161`; `server/redis/pipeline.js:15-17, 44, 176-262`; transactions doc https://redis.io/docs/latest/develop/using-commands/transactions/ ("If at least one watched key is modified before the EXEC command, the whole transaction aborts, and EXEC returns a Null reply"; "When EXEC is called, all keys are UNWATCHed, regardless of whether the transaction was aborted or not"; "Commands within a transaction won't trigger the WATCH condition since they are only queued until the EXEC is sent"); `rules/data-transactions.md` (MULTI/EXEC atomicity); `rules/conn-pipelining.md` (pipelined pre-reads); Redis Streams consumer-group semantics https://redis.io/docs/latest/develop/data-types/streams/ (pending entries redelivered until `XACK`).
- Impacted files/components: `server/redis/projector.js` (Lua strings deleted; phase functions in JS), `server/redis/pipeline.js` (`runProjector`, `commitSnapshot`, consumer loop, new `state.writer` connection), `server/redis/pipeline.test.mjs`, `server/redis/projectionBatches.test.mjs`, `server/redis/README.md` lines 24, 228, 265-268 (text describing Lua)
- Contract shape: n/a: interface unchanged (stream message fields, key names, `work` hash fields `publish`, `cleanup`, `cohort`, `metadata` are preserved byte-for-byte)
- Acceptance scenarios:
  - Given: a `publish` batch of 25 records for `flights`, `gev:flights:publishing` = `<token>`, `HGET gev:flights:staging:<token>:commit publish` = `<offset>`
    When: the consumer processes the batch
    Then: `redis-cli MONITOR` shows, in order, on one connection: `WATCH gev:flights:projection-schema gev:flights:publishing gev:flights:staging:<token>:commit`, `GET`/`GET`/`HGET` of those keys, `MULTI`, 25 × (`JSON.SET gev:flights:entity:states:<id> $ <doc>`, `EXPIRE gev:flights:entity:states:<id> 3600`, `CMS.INCRBY gev:flights:frequency <id> 1`, `RPUSH gev:flights:staging:<token>:commit:members gev:flights:entity:states:<id>`, `SADD gev:flights:staging:<token>:commit:wanted gev:flights:entity:states:<id>`, `UNLINK gev:flights:staging:<token>:<id>`), `HSET gev:flights:staging:<token>:commit publish <offset+25>`, `EXEC`; no `EVALSHA`.
  - Given: the same batch, and a second client runs `SET gev:flights:projection-schema other` between the `WATCH` and the `EXEC`
    When: `EXEC` executes
    Then: `EXEC` returns a null reply (transactions doc); the consumer re-reads, finds `projection-schema` ≠ `state.epoch`, and throws `Error('Redis reset during projection')` exactly as `pipeline.js:334-338` does today; `HGET gev:flights:staging:<token>:commit publish` still returns `<offset>`.
  - Given: the consumer process is killed after `EXEC` returned an array and before the commit event's `XACK`
    When: the process restarts and `XREADGROUP GROUP view-projector local-view ... 0` redelivers the pending commit event (`pipeline.js:167-170` reads pending first)
    Then: `HGET gev:flights:staging:<token>:commit publish` ≥ the redelivered batch's `<offset>` + 25, so the phase function returns `'replayed'` without a `MULTI` (same rule as `projector.js:86`), and `CMS.QUERY gev:flights:frequency <id>` for any id in the batch returns the same count as before the crash. No double increment.
  - Given: the `finish` phase
    When: its `MULTI` executes
    Then: the transaction contains `UNLINK <members>`, `RENAME <nextMembers> <members>` (only when `EXISTS <nextMembers>` returned 1 in the pre-read), `EXPIRE <members> 3600`, `JSON.SET gev:<layer>:snapshot:<cohort> $ <metadataText>`, `EXPIRE ... 3600`, `UNLINK <work> <wanted> gev:<layer>:publishing`, `XACK gev:<layer>:stream view-projector <eventId>`, `XTRIM gev:<layer>:stream MAXLEN = <maxlen> ACKED` — the same command list as `projector.js:147-157`; `JSON.GET gev:<layer>:snapshot:<cohort> .token` afterwards returns `"<token>"`.
  - Given: a flights `aircraft-type` enrichment record (`record.update === 'aircraft-type'`, `server/redis/payload.js:59-61`)
    When: the publish batch containing it is processed
    Then: the merge rules of `projector.js:95-114` are applied in JavaScript on the pre-read `JSON.GET <cold doc>` result and the staged doc, and `JSON.GET gev:flights:entity:states:<id> $.typeCode` after `EXEC` equals the value the Lua path produced for the same inputs (assert via the existing fixtures in `server/redis/projectionBatches.test.mjs`).
  - Given: `redis-cli SCRIPT FLUSH` executed, then one full flights cycle and one full satellites cycle
    When: `redis-cli SCRIPT EXISTS <sha1 of STAGE> <sha1 of COMMIT>` runs (sha1 computed as in `pipeline.js:214`)
    Then: reply is `0 0` (neither script was loaded); `redis-cli INFO errorstats` shows no `errorstat_BUSY` line.
- Constraints:
  - One dedicated Redis connection per layer for WATCH/MULTI (`state.writer`, created like `state.reader` in `ensure`), because `WATCH` state is per connection and `EXEC` unwatches every key on that connection (transactions doc); HTTP reads keep using the shared client.
  - Pre-reads per publish batch, pipelined: 25 × `JSON.GET <staging doc>`, 25 × `JSON.GET <cold doc>` (for `collections`, enrichment fields, and REQ-12 squawk comparison), plus for `satellites` one `JSON.GET gev:satellites:snapshot:<cohort>` per distinct cohort named in any `collections` array (ports `memberships` and `satelliteType`, `projector.js:36-67`). Round trips per batch: 1 (pre-read pipeline) + 1 (`WATCH`) + 1 (`GET`,`GET`,`HGET` pipelined) + 1 (`MULTI`…`EXEC` sent as one pipeline) = 4.
  - Commands inside the publish `EXEC` at REQ-02: 25 × 6 + 1 (`HSET` checkpoint) = 151; after REQ-03, REQ-06, REQ-14, REQ-15 add their commands: 25 × 9 (adds `HSET` pos, `EXPIRE` pos, `TOPK.ADD`) + 1 (`PFADD`, variadic) + 1 (`PUBLISH`) + 1 (`HSET`) = 228 (single writer, so the `EXEC` count is the blocked window).
  - Retry bound: 3 `EXEC` attempts per batch; terminal error text `Projection checkpoint conflict`.
  - Pre-reads of entity docs are not watched: the per-layer queue (`pipeline.js:265-272`) and the `publishing` token guarantee one writer per layer; the watched keys detect the only concurrent mutators (reset via `projection-schema`, another projection via `publishing`, checkpoint replay via the `work` hash).
  - `XACK` for source records stays in the STAGE pipeline after the record's `JSON.SET`; a crash between them redelivers the record, and the second `JSON.SET` writes the same document (idempotent).
- Failure mode: caller-visible: the ingest request fails with `Redis projector: Projection checkpoint conflict` after 3 aborted `EXEC`s (existing `state.error` surfacing at `pipeline.js:296, 336`). Crash mid-write: before `EXEC` nothing is written (transactions doc: "if a client loses the connection … before calling the EXEC command none of the operations are performed"); after `EXEC` the checkpoint `HSET` is in the same transaction as the writes, so the redelivered batch is detected as `'replayed'`.
- Rollback: `git revert` the commit; Lua strings return; no key layout changed, so an in-flight `work` hash is resumed by the Lua path unchanged.
- Observability: `redis-cli INFO errorstats` → no `errorstat_BUSY`; `redis-cli SCRIPT EXISTS <sha1 STAGE> <sha1 COMMIT>` → `0 0` after `SCRIPT FLUSH`; new server log line per publish batch `publish <layer> <token> <offset> <ms>` (also the B4/B5 probe).
- Compatibility impact: none for clients; key names and stream messages unchanged. Operators lose the `BUSY` recovery text in `README.md:265-268` (update to describe `EXEC` duration instead).
- Migration: none; deploy replaces the process. A pending `work` hash written by the Lua path is consumed by the JS path because field names are identical.
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/pipeline.test.mjs server/redis/projectionBatches.test.mjs` passes; `redis-cli MONITOR | grep -c EVALSHA` during one cycle prints `0`.
- Supersedes: `STAGE` and `COMMIT` Lua scripts (`server/redis/projector.js:8-161`)
- Handoff task, if any: Port projector phases to WATCH/MULTI transactions

### REQ-04: Flatten display fields from `$.source` onto the cold doc at projection time

- Source: `GEV-Redis-Analysis.md` §4 "Flatten Source Blobs at Write Time" (projector half)
- Previous behavior: `server/redis/payload.js:100-111` (`entityDocument`) writes `id, layer, kind, label, latitude, longitude, altitudeM, speedMps, location, fingerprint, source, geoLocation`, plus `categories` for radio, enrichment fields for flights, `satelliteFields` for satellites; AIS and military docs carry vessel/aircraft attributes only inside `$.source`. Non-flight snapshot reads return `JSON.GET <key> .source` (`server/redis/pipeline.js:383`).
- New behavior: `entityDocument` adds top-level fields per layer: `ais-live-vessels` → `mmsi` (string), `vesselType` (string, from `type_specific` else `type`), `destination` (string), `heading` (number, degrees, from `heading` else `course`); `military` → `callsign` (string, `flight` trimmed), `registration` (string, `r`), `typeCode` (string, `t`), `heading` (number, `track`); `flights` → `heading` (number, `source[10]`), `squawk` (string, `source[14]`). `$.source` stays. `ensureAisIndex` (`server/redis/aisSearch.js:15-21`) gains `$.vesselType AS vesselType TAG` and `$.destination AS destination TEXT NOSTEM` via `FT.ALTER gev:ais-live-vessels:idx SCHEMA ADD ...` when `FT.INFO` lacks them.
- Why: REQ-03 copies `heading` into the hot hash and REQ-05 stops rewriting `$.source` per tick; the detail panel and the text search then read flat fields instead of decoding the provider blob (analysis §4).
- Depends on: none
- Baseline row: n/a: not a performance change
- Evidence checked: `server/redis/payload.js:100-111`; `server/redis/pipeline.js:383`; `src/data/aisLiveVessels.js:1167-1174` (row fields `name`, `mmsi`, `type_specific`/`type`, `destination`, `speed`, `course`, `heading`); `src/data/militaryFlights.js:1024` (`fix.track` heading); `src/data/flights.js:4181` (OpenSky indices); `server/redis/aisSearch.js:15-21`; `rules/rqe-field-types.md` (TAG for exact match, TEXT for search); `rules/json-vs-hash.md` (JSON for nested + indexed).
- Impacted files/components: `server/redis/payload.js` (`entityDocument`), `server/redis/aisSearch.js` (`FT.ALTER`), `server/redis/payload.test.mjs`, `server/redis/aisSearch.test.mjs`, `server/redis/README.md` key table (document fields)
- Contract shape: cold doc gains fields — AIS: `mmsi: string`, `vesselType: string`, `destination: string`, `heading: number|null` (degrees 0–360); military: `callsign: string`, `registration: string`, `typeCode: string`, `heading: number|null`; flights: `heading: number|null`, `squawk: string|null` (4 octal digits as sent by OpenSky). Missing source values are `null` (numbers) or `''` (strings), never absent, so `JSON.GET … $.field` returns `[null]`/`[""]` rather than `[]`.
- Acceptance scenarios:
  - Given: an AIS row `{mmsi: 211234567, name: "X", type_specific: "Tanker", destination: "ROTTERDAM", lat: 51.9, lon: 4.1, speed: 12.3, course: 87, heading: 88}` projected
    When: `redis-cli JSON.GET gev:ais-live-vessels:entity:rows:211234567 $.mmsi $.vesselType $.destination $.heading`
    Then: reply is `{"$.mmsi":["211234567"],"$.vesselType":["Tanker"],"$.destination":["ROTTERDAM"],"$.heading":[88]}` and `JSON.GET … $.source.destination` still returns `["ROTTERDAM"]`.
  - Given: the AIS index exists from a build before this change
    When: `ensureAisIndex` runs
    Then: `redis-cli FT.INFO gev:ais-live-vessels:idx` lists attributes `vesselType` (type `TAG`) and `destination` (type `TEXT`); `FT.SEARCH gev:ais-live-vessels:idx "@destination:(ROTT*)" NOCONTENT LIMIT 0 5 DIALECT 2` returns ≥ 1 key after one AIS projection.
  - Given: an OpenSky state vector with `[10] = 87.5` and `[14] = "7700"`
    When: `redis-cli JSON.GET gev:flights:entity:states:<icao24> $.heading $.squawk`
    Then: `{"$.heading":[87.5],"$.squawk":["7700"]}`.
- Constraints: field extraction is a per-layer table in `payload.js` (`FLAT_FIELDS[layer] = [[targetName, sourcePath | sourceIndex, type], …]`); no client change in this REQ.
- Failure mode: a source row lacking a field yields `null`/`''` (no throw); crash mid-write: the doc is written by REQ-02's `EXEC`, so either the whole doc with flat fields exists or the previous doc remains.
- Rollback: revert `entityDocument`; existing docs keep the extra fields until their 3600 s TTL (`pipeline.js:17`) elapses; `FT.ALTER` attributes stay (harmless, no writes reference them).
- Observability: `redis-cli JSON.GET gev:ais-live-vessels:entity:rows:<any> $.vesselType` returns a value after one cycle; `FT.INFO gev:ais-live-vessels:idx` → `num_docs` unchanged by the alter.
- Compatibility impact: additive; `unpackBody` (`payload.js:112-130`) ignores unknown fields because it reads `.source` for non-flight layers.
- Migration: none; docs gain fields on their next projection.
- Verification: `node --test server/redis/payload.test.mjs server/redis/aisSearch.test.mjs` includes the three scenarios above.
- Supersedes: none (fields added, none removed)
- Handoff task, if any: Add per-layer flat display fields to entityDocument

### REQ-05: Cut cold-doc position writes over to enrichment-only `JSON.MERGE`, and route live-layer search to posidx

- Source: `GEV-Redis-Analysis.md` §6 "Hot/Cold Entity Split" (cold half) and §4 (client half reasoning)
- Previous behavior: every position tick rewrites the full cold doc (`projector.js:120` `JSON.SET record.key '$' …`), which re-indexes the JSON index per tick; the NL search planner (`server/redis/userSearch.js:4-8`, `COMMON` fields `$.latitude`, `$.longitude`, `$.geoLocation`, `$.speedMps`, `$.altitudeM`) queries live-layer positions on the JSON indexes.
- New behavior: for live layers, once REQ-07 serves them from posidx, the publish batch writes the cold doc only when (a) the key does not exist (pre-read `JSON.GET` returned null) → `JSON.SET <key> $ <doc>`; or (b) any enrichment/flat field (`label`, `typeCode`, `typeName`, `registration`, `enrichmentUpdatedAt`, `typeKnown`, `collections`, REQ-04 fields) differs from the pre-read → `JSON.MERGE <key> $ '{<changed fields>}'`. Position fields (`latitude`, `longitude`, `altitudeM`, `speedMps`, `location`, `geoLocation`, `heading`, `squawk`, `fingerprint`, `source`) are written to the cold doc only in case (a). `EXPIRE <key> 3600` is refreshed every tick. `userSearch.js` reports posidx as the index for live layers in the schemas passed to the planner (`generatePlan`, `userSearch.js:170-189`), with fields `lat`, `lon`, `loc`, `alt`, `spd`, `hdg`, `ts`, `label`, `type` (REQ-03 Contract shape) replacing `COMMON` for those layers; non-live layers keep the JSON index.
- Why: a per-tick `JSON.SET` re-indexes a multi-field JSON document 11,000 times per flights cycle; the hot hash (REQ-03) is the position store, so the cold doc changes only on enrichment. `JSON.MERGE` complies with RFC 7396 and "merging a non-existing object key adds the key and value" (command page), so one command replaces the per-field `JSON.SET` loop (`projector.js:98-105`).
- Depends on: REQ-07, REQ-04
- Baseline row: B5
- Evidence checked: `server/redis/projector.js:95-120`; `server/redis/userSearch.js:4-8, 170-189`; `server/redis/pipeline.js:17` (TTL 3600); JSON.MERGE https://redis.io/docs/latest/commands/json.merge/ ("For non-existing keys the path must be `$`"; "merging an existing object key with non-null value updates the value"; "merging an existing array with any merged value, replaces the entire array with the value"); `rules/json-partial-updates.md`; `rules/ram-ttl.md` (TTL refreshed at write time).
- Impacted files/components: `server/redis/projector.js` (publish phase), `server/redis/userSearch.js` (`schemas`, `compilePlan`, row parsing for hash results), `src/data/redisSearchPresets.js` (preset plans naming live-layer indexes), `server/redis/userSearch.test.mjs`, `server/redis/README.md` "Entity storage and reads"
- Contract shape: NL search schema entry for a live layer: `{layer: string, index: "gev:<layer>:posidx", fields: [{name: "lat", type: "NUMERIC"}, {name: "lon", type: "NUMERIC"}, {name: "loc", type: "GEO"}, {name: "alt", type: "NUMERIC"}, {name: "spd", type: "NUMERIC"}, {name: "hdg", type: "NUMERIC"}, {name: "ts", type: "NUMERIC"}, {name: "label", type: "TEXT"}, {name: "type", type: "TAG"}]}`; plan results for hash indexes are parsed as field/value pairs (no `$` JSON attribute). New read-only endpoint `GET /api/redis/entity?layer=<layer>&id=<id>` → HTTP 200 `{"cold": <cold doc object or null>, "hot": <hot hash object or null>}`; HTTP 404 `{"error":"Entity not found"}` when both are null; HTTP 400 `{"error":"Invalid entity reference"}` for unknown layer or `id` longer than 512 characters (same limit as `plugin.js:92`).
- Acceptance scenarios:
  - Given: `flights` served by REQ-07, entity `<id>` exists, incoming tick changes only position
    When: the publish batch executes
    Then: `redis-cli MONITOR` shows for `<id>` exactly `EXPIRE gev:flights:entity:states:<id> 3600` and the REQ-03 `HSET`/`EXPIRE` pair; no `JSON.SET` and no `JSON.MERGE` for that key; `JSON.GET gev:flights:entity:states:<id> $.latitude` returns the value from the first projection, unchanged.
  - Given: entity `<id>` exists and the tick carries `typeCode: "B738"` where the doc had `null`
    When: the batch executes
    Then: `MONITOR` shows `JSON.MERGE gev:flights:entity:states:<id> $ {"typeCode":"B738","typeKnown":1,"enrichmentUpdatedAt":<ms>}` and `JSON.GET … $.typeCode` returns `["B738"]`; `$.label` is unchanged.
  - Given: entity `<id>` does not exist
    When: the batch executes
    Then: `MONITOR` shows `JSON.SET gev:flights:entity:states:<id> $ <full doc>` (REQ-04 shape).
  - Given: NL query "fastest aircraft" with flights enabled
    When: `POST /api/redis/search/plan`
    Then: the compiled plan has `index: "gev:flights:posidx"`, `query: "@spd:[0 +inf]"`, `sortBy: "spd"`, and `POST /api/redis/search/run` returns rows with `key: "gev:flights:pos:<id>"` and numeric `spd`.
  - Given: entity `<id>` with both keys present
    When: `GET /api/redis/entity?layer=flights&id=<id>`
    Then: HTTP 200 body `{"cold":{...,"source":[...]},"hot":{"lat":"48.8600",...}}`; after `DEL` of both keys the same request returns HTTP 404 `{"error":"Entity not found"}`.
- Constraints:
  - Applies only to layers listed as live AND served by REQ-07 (server env `DELTA_LAYERS`, default `flights,military,ais-live-vessels`); other layers keep full `JSON.SET` per projection.
  - `collections` changes use `JSON.MERGE` with the whole array (arrays are replaced, command page).
  - The detail panel (click-to-inspect) reads `GET /api/redis/entity` and combines `cold` and `hot` client-side.
- Failure mode: caller-visible: none on the map (positions come from posidx); a `JSON.MERGE` on a key that expired between pre-read and `EXEC` creates a partial doc containing only the merged fields — mitigated by refreshing `EXPIRE 3600` in the same `EXEC` and by the `(a)` branch on the next tick when `label` is missing from the pre-read. Crash mid-write: `EXEC` atomicity (REQ-02).
- Rollback: set `DELTA_LAYERS=` (empty) → full `JSON.SET` per tick resumes for all layers; NL search schema falls back to JSON indexes. No data migration.
- Observability: `redis-cli INFO commandstats` → `cmdstat_json.merge` calls > 0 and `cmdstat_json.set` calls per flights cycle ≈ new-entity count (not 11,000); `FT.INFO gev:flights:idx` → `indexing` 0 and `num_docs` stable across ticks.
- Compatibility impact: `GET /api/redis/snapshot` for live layers returns positions frozen at first sight after cutover; REQ-07 clients no longer call it for live layers. Filtered snapshot reads for live layers (`plugin.js:117-130` `filter=1`) are served by posidx queries (REQ-07 `label`/`type` parameters).
- Migration: enable per layer via `DELTA_LAYERS` after REQ-07 is verified for that layer.
- Verification: `node --test server/redis/userSearch.test.mjs server/redis/projectionBatches.test.mjs`; `redis-cli INFO commandstats | grep cmdstat_json.set` before/after one cycle.
- Supersedes: per-field `JSON.SET` enrichment merge loop (`server/redis/projector.js:98-105`); per-tick full cold-doc rewrite (`server/redis/projector.js:120`) for live layers
- Handoff task, if any: Enrichment-only cold-doc writes and posidx routing for NL search

## ADDED

### REQ-03: Hot position hash per live entity with a Hash-backed position index (posidx)

- Source: `GEV-Redis-Analysis.md` §6 (hot half), §1 (index fields), §2 (fields for clustering)
- Depends on: REQ-02
- Baseline row: B5, B11
- Rationale: positions change every refresh; enrichment rarely. A 12-field Hash is written per tick and indexed by a Hash index containing only GEO/NUMERIC/TAG/TEXT fields needed for viewport reads (REQ-07), clustering (REQ-08), geofencing (REQ-13) and NL search (REQ-05). `rules/json-vs-hash.md`: Hash for flat objects with field-level access and memory efficiency; `rules/rqe-index-creation.md`: index only queried fields.
- Evidence checked: `server/redis/payload.js:100-111` (numeric extraction and `geoLocation` guard `|lat| ≤ 85.05112878`); `server/redis/pipeline.js:17` (TTL 3600); `src/data/flights.js:602-604` (`RENDER_DELAY_SEC` 30, `MISSING_POLL_LIMIT` 3); `src/data/aisLiveVessels.js:61` (60000 ms refresh); field types https://redis.io/docs/latest/develop/ai/search-and-query/indexing/field-and-type-options/ (`GEO` query `@field:[lon lat radius unit]`; `GEOSHAPE [FLAT|SPHERICAL]`, WKT, no `SORTABLE`; `NUMERIC [SORTABLE]`; `TAG`); HEXPIRE https://redis.io/docs/latest/commands/hexpire/ and keyspace notifications https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/ (`HEXPIRE` variants "generate hexpired events", key expiry generates `expired` with the key name as payload); `rules/data-hash-field-expiry.md` ("Data where the entire hash should expire together (use EXPIRE on the key instead)"); `rules/data-key-naming.md`; expiration behaviour https://redis.io/docs/latest/develop/ai/search-and-query/advanced-concepts/expiration/ ("Redis 8 and later: Redis Search returns only documents that are valid (not expired) at the time when the query or cursor read started").
- Impacted files/components: `server/redis/projector.js` (publish phase adds `HSET`/`EXPIRE`), new `server/redis/posIndex.js` (`ensurePosIndex(client, prefix, layer)`), `server/redis/pipeline.js` (`ensure` calls `ensurePosIndex` for live layers), `server/redis/README.md` key table, new `server/redis/posIndex.test.mjs`
- Contract shape: key `gev:<layer>:pos:<encodedItem>` where `<encodedItem>` = the `item` part of `entityKey` (`payload.js:37`, already `encodeURIComponent`-encoded, so it contains no `:`); Hash fields (all strings on the wire): `lat` (decimal degrees, 4 decimals), `lon` (decimal degrees, 4 decimals), `loc` (`"<lon>,<lat>"`, present only when `|lat| ≤ 85.05112878`), `shape` (`"POINT (<lon> <lat>)"` WKT, same guard), `alt` (metres, integer, or absent), `spd` (m/s, 1 decimal, or absent), `hdg` (degrees 0–360, integer, or absent), `ts` (ms, `Date.now()` at projection), `label` (string, the cold doc `label`), `type` (string: flights `typeName` or `''`; military `typeCode`; AIS `vesselType`), `sq` (flights only, squawk string). Whole-key TTL `EXPIRE <key> 300` (300 s = 5 × 60,000 ms AIS refresh; > 180 s ITU-R M.1371-5 maximum Class A interval; > 90,000 ms = 30,000 ms × `MISSING_POLL_LIMIT` 3 current flights grace). Index: `FT.CREATE gev:<layer>:posidx ON HASH PREFIX 1 gev:<layer>:pos: SCHEMA loc GEO lat NUMERIC SORTABLE lon NUMERIC SORTABLE ts NUMERIC SORTABLE alt NUMERIC spd NUMERIC SORTABLE hdg NUMERIC label TEXT NOSTEM type TAG shape GEOSHAPE SPHERICAL`.
- Acceptance scenarios:
  - Given: a flights tick for icao24 `34454b` at lon 2.35, lat 48.86, alt 11277.3, velocity 236.44, true_track 87.2, squawk `1000`, label `AFR123`, typeName `A320`
    When: the publish batch's `EXEC` completes
    Then: `redis-cli HGETALL gev:flights:pos:34454b` returns fields `lat 48.8600 lon 2.3500 loc 2.3500,48.8600 shape "POINT (2.3500 48.8600)" alt 11277 spd 236.4 hdg 87 ts <ms> label AFR123 type A320 sq 1000` (12 fields) and `redis-cli TTL gev:flights:pos:34454b` returns a value in (0, 300].
  - Given: the index does not exist
    When: `ensurePosIndex` runs at `ensure('flights')`
    Then: `redis-cli FT.INFO gev:flights:posidx` returns `index_definition` with `key_type HASH`, `prefixes ["gev:flights:pos:"]`, and 10 attributes named above; after one cycle `num_docs` equals the number of keys matching `gev:flights:pos:*` counted with `redis-cli --scan --pattern 'gev:flights:pos:*' | wc -l`.
  - Given: an entity at lat 87.0 (beyond the GEO limit)
    When: projected
    Then: `HGETALL` shows `lat`/`lon` present and `loc`/`shape` absent; `FT.SEARCH gev:flights:posidx "@loc:[0 87 1000 km]" NOCONTENT` does not return it; `FT.SEARCH gev:flights:posidx "@lat:[86 90]" NOCONTENT` does.
  - Given: `HSET` of a hash whose `EXPIRE` is 300 s and no further ticks
    When: 300 s elapse
    Then: `redis-cli EXISTS gev:flights:pos:34454b` returns 0 and `FT.SEARCH gev:flights:posidx "@ts:[0 +inf]" NOCONTENT` no longer lists it (expiration behaviour doc).
- Constraints:
  - Live layers only (flights, military, ais-live-vessels). Satellites keep client-side propagation (`src/data/satellites.js:1525` `updateInterval: 0`).
  - Expiry model decision: whole-key `EXPIRE`, not `HEXPIRE`. A stale entity's identity without a position has no consumer, and only key expiry emits the `__keyevent@<db>__:expired` message whose payload is the key name that REQ-09 parses; `HEXPIRE` emits `hexpired` keyspace events with no field payload on the standard channels (keyspace notifications doc; subkey channels exist since 8.8 but add a second channel family for no gain here).
  - `spd` unit for AIS: `speed` × 0.514444 (knots → m/s) — units of `row.speed` are a Verification step (A-6).
  - Dual-write phase: the cold doc keeps its current full `JSON.SET` per tick until REQ-05 cuts over; the hot hash is written from the first deploy of this REQ.
  - `ensurePosIndex` creates the index without `SKIPINITIALSCAN` (existing hashes must be indexed after a restart; `rules/rqe-skip-initial-scan.md` "When NOT to use").
- Failure mode: caller-visible: none until REQ-07 reads it. Crash mid-write: the `HSET`/`EXPIRE` pair is inside REQ-02's `EXEC`; either both or neither apply. `FT.CREATE` failure (`Index already exists` race) is caught like `flightSearch.js:29-31` and the existing index is used.
- Rollback: stop adding `HSET`/`EXPIRE` to the publish `EXEC`; hashes expire within 300 s; `FT.DROPINDEX gev:<layer>:posidx` (without `DD`).
- Observability: `redis-cli FT.INFO gev:flights:posidx` → `num_docs` tracks live entity count ((measure); the load check ingests 10,000 flights, `scripts/redis-load-check.mjs:33`); `redis-cli INFO keyspace` → `db0` `keys` and `expires` both grow by the live entity count.
- Compatibility impact: additive; new keys under the existing `gev:` prefix; memory + B11 × live entity count (recorded in `baseline-capture.json`).
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/posIndex.test.mjs`; `redis-cli FT.SEARCH gev:flights:posidx "@loc:[2.35 48.86 800 km]" RETURN 3 lat lon ts LIMIT 0 3 DIALECT 2` returns documents.
- Handoff task, if any: Hot position hash writes and posidx creation for live layers
