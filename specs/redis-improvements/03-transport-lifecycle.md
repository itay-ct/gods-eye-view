# Part 3 — Transport and entity lifecycle

## ADDED

### REQ-06: Server-sent events fed by explicit `PUBLISH` from the projector

- Source: `GEV-Redis-Analysis.md` §3 "SSE Revision Notifications via Explicit PUBLISH"
- Depends on: REQ-02
- Baseline row: B4
- Rationale: the browser learns that a projection advanced only through its own ingest NDJSON stream (`plugin.js:174-186`, 1000 ms heartbeat) or the next timer tick. A `PUBLISH` inside the publish `EXEC` plus one server-side subscriber fanned out over SSE tells every open page within one coalescing window, and carries the payload (revision token, progress) that keyspace notifications cannot (`rules/stream-choosing-pattern.md`: Pub/Sub for "real-time notifications, OK to miss messages"; analysis §3: keyspace events are per-node, payload-less, and `CONFIG SET` is often locked on managed Redis).
- Evidence checked: `server/redis/README.md:229` ("It does not use Redis Pub/Sub or browser SSE"); `server/redis/plugin.js:62-75` (middleware and abort handling), `:174-186` (NDJSON progress heartbeat); `src/data/redisMode.js:283` (status poll every 2000 ms), `src/data/manager.js:527-540` (`_armUpdateLoop` timers); Pub/Sub doc https://redis.io/docs/latest/develop/pubsub/ ("Redis' Pub/Sub exhibits at-most-once message delivery semantics"; "A client subscribed to one or more channels shouldn't issue commands" — dedicated subscriber connection); WHATWG HTML §9.2 (event stream format: `event:`, `data:`, blank line, comment lines starting with `:`); `rules/stream-choosing-pattern.md`.
- Impacted files/components: `server/redis/plugin.js` (new `/events` route), new `server/redis/events.js` (subscriber connection, fan-out, coalescing), `server/redis/projector.js` (adds `PUBLISH` to the publish and finish `EXEC`), `src/data/redisMode.js` (EventSource client, debounce, timer fallback), `src/data/redisMode.test.mjs`, new `server/redis/events.test.mjs`, `server/redis/README.md:229`
- Contract shape: Redis channel `gev:<layer>:rev`, message = JSON `{"rev": "<token>", "phase": "publish"|"finish", "done": <int>, "count": <int>, "at": <ms>}` (`done` = checkpoint offset after the batch, `count` = `metadata.count`). HTTP `GET /api/redis/events` → 200, `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`; events: `event: rev` / `data: {"layer":"<layer>","rev":"<token>","phase":"publish"|"finish","done":<int>,"count":<int>,"at":<ms>}`; `event: expired` / `data: {"layer":"<layer>","id":"<id>"}` (REQ-09); `event: geofence` / `data: {…}` (REQ-13); keepalive comment line `: keepalive` every 15,000 ms (= half the flights `updateInterval` 30,000 ms); `retry: 1000` sent once at connect (EventSource reconnection delay, WHATWG §9.2). Non-GET → HTTP 405 `{"error":"GET required"}` (pattern from `userSearch.js:191`).
- Acceptance scenarios:
  - Given: `curl -N http://localhost:5173/api/redis/events` connected, flights projection running
    When: a publish batch's `EXEC` completes
    Then: `redis-cli SUBSCRIBE gev:flights:rev` prints one message `{"rev":"<token>","phase":"publish","done":<offset+25>,"count":<n>,"at":<ms>}` and the curl output shows `event: rev` with the same fields plus `"layer":"flights"` within 500 ms of the server log line `publish flights <token> <offset> <ms>` (REQ-02) — compare `at` against the SSE arrival time logged by `curl -N --trace-time`.
  - Given: 440 publish batches complete within 30 s (11,000 / 25)
    When: observed on the SSE stream
    Then: ≤ 60 `rev` events for `flights` (30,000 ms / 500 ms coalescing) and the last one has `phase: "finish"`.
  - Given: the browser has the flights layer on and the SSE connection open
    When: a `rev` event for `flights` arrives
    Then: the client issues one `/api/redis/delta` request no sooner than 1000 ms after the previous delta request for that layer (debounce floor), and B4 (publish `at` → delta request start) ≤ 1500 ms.
  - Given: the SSE connection drops (`EventSource.onerror`)
    When: 1000 ms elapse
    Then: EventSource reconnects (per `retry: 1000`); while disconnected the layer's existing `updateInterval` timer (`manager.js:527-540`) keeps triggering reads unchanged — assert via `src/data/redisMode.test.mjs` fake timers.
  - Given: no projection for 60,000 ms
    When: the stream is observed
    Then: exactly 4 `: keepalive` comment lines (60,000 / 15,000) and no `event:` lines; `redis-cli INFO commandstats` shows no additional read commands attributable to SSE.
- Constraints:
  - One dedicated subscriber connection per server process (`client.duplicate()`), subscribed to `gev:*:rev` via `PSUBSCRIBE` plus `__keyevent@0__:expired` (REQ-09) and `gev:geofence` (REQ-13); browsers never connect to Redis.
  - Server coalescing: at most one `rev` event per layer per 500 ms window; the emitted event carries the latest message in the window.
  - `PUBLISH` is queued inside the publish/finish `EXEC` (REQ-02) after the checkpoint `HSET`, so a notification is sent only for a committed batch.
  - Client debounce floor 1000 ms per layer; the ingest trigger timers are unchanged (source polling stays client-driven, `README.md:229` "Source polling is retained").
  - Message count per flights cycle: 441 `PUBLISH` (440 publish + 1 finish); SSE events per cycle ≤ 60 per layer per connected browser.
- Failure mode: caller-visible: `EventSource` `onerror` → reconnect after 1000 ms; timers keep the map refreshing meanwhile. Pub/Sub is at-most-once (Pub/Sub doc): a missed message is covered by the next batch's message or the timer. Crash mid-write: `PUBLISH` is inside `EXEC`; an aborted `EXEC` sends nothing.
- Rollback: remove the `PUBLISH` from the `EXEC` and the `/events` route; the client falls back to timers on `EventSource` error (HTTP 404 → `onerror`).
- Observability: `redis-cli PUBSUB NUMPAT` ≥ 1 while the server runs; `/api/redis/status` gains `sseClients` (open connections) and `sseEvents` (events sent since start).
- Compatibility impact: additive endpoint; `README.md:229` sentence replaced.
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/events.test.mjs src/data/redisMode.test.mjs`; manual: `curl -N http://localhost:5173/api/redis/events`.
- Handoff task, if any: SSE endpoint with projector PUBLISH and client EventSource

### REQ-09: Prompt entity removal from keyspace `expired` notifications on hot hashes

- Source: `GEV-Redis-Analysis.md` §9 "Stale Entity Expiry via Keyspace Notifications"
- Depends on: REQ-03, REQ-06
- Baseline row: n/a: not a performance change (removal latency bound is stated in Constraints)
- Rationale: on the delta path an entity that stops ticking disappears only after the 300,000 ms client staleness rule (REQ-07). Redis already deletes its hot hash at TTL; subscribing to `__keyevent@0__:expired` turns that deletion into an SSE `expired` event so the billboard is removed when Redis removes the key.
- Evidence checked: keyspace notifications doc https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/ (flags: `E` keyevent, `x` expired; "At least K or E should be present in the string"; channel `__keyevent@<db>__:expired`, payload = key name; "there are no guarantees that the Redis server will be able to generate the expired event at the time the key time to live reaches the value of zero"; "Redis Pub/Sub is fire and forget"); `src/data/flights.js:604, 621` (`MISSING_POLL_LIMIT` 3, `LANDED_MISSING_POLL_LIMIT` 1); `server/redis/README.md:14` (Docker run command sets no ACL, so `CONFIG SET` is permitted); `server/redis/pipeline.js:40` (`REDIS_URL` default db 0).
- Impacted files/components: `server/redis/events.js` (subscription, key-name parsing), `server/redis/pipeline.js` (`connect` applies `CONFIG SET`), `src/data/redisMode.js` (dispatch `expired` to layer modules), `src/data/flights.js`, `src/data/militaryFlights.js`, `src/data/aisLiveVessels.js` (remove-by-id entry points), `server/redis/events.test.mjs`
- Contract shape: SSE `event: expired` / `data: {"layer":"<layer>","id":"<decoded id>"}` where `<decoded id>` = `decodeURIComponent` of the key suffix after `gev:<layer>:pos:`. Startup: `CONFIG GET notify-keyspace-events` → if the value lacks `E` or `x`, `CONFIG SET notify-keyspace-events <existing + missing chars>`; on an error reply the feature is disabled and one warning `[Redis layers] keyspace notifications unavailable: <error>` is logged.
- Acceptance scenarios:
  - Given: `redis-cli CONFIG GET notify-keyspace-events` returns `""` before start
    When: the server connects
    Then: `redis-cli CONFIG GET notify-keyspace-events` returns a string containing both `E` and `x` (`Ex` when it was empty), and `redis-cli PUBSUB NUMSUB __keyevent@0__:expired` returns 1.
  - Given: `redis-cli HSET gev:flights:pos:test1 lat 1 lon 1 ts 1` then `redis-cli EXPIRE gev:flights:pos:test1 2`, SSE connected
    When: ≥ 2000 ms elapse and any command touches the key (`redis-cli EXISTS gev:flights:pos:test1` → 0) or the active-expiry cycle removes it
    Then: the SSE stream shows `event: expired` / `data: {"layer":"flights","id":"test1"}`; the client removes billboard `test1` (assert via the test hook `window.__gevDebug.hasFlight('test1') === false`).
  - Given: a key `gev:flights:staging:<token>:<id>` (TTL 86400) or `gev:flights:entity:states:<id>` (TTL 3600) expires
    When: the subscriber receives the event
    Then: no SSE event is emitted (only keys matching `^gev:([^:]+):pos:(.+)$` are forwarded).
  - Given: `CONFIG SET` returns an error (managed Redis)
    When: the server connects
    Then: the warning line is logged once, `/api/redis/status` reports `keyspaceNotifications: false`, and removal relies on the REQ-07 300,000 ms staleness rule.
- Constraints:
  - Removal latency bound with notifications: TTL 300 s + Redis expiry delay (measure: the doc states no timing guarantee); without notifications: 300,000 ms after the last `ts` (REQ-07).
  - The client ignores `expired` for ids it does not hold (an entity already removed by the staleness rule).
  - Expiry events for all databases are not needed: `REDIS_URL` uses db 0 (`pipeline.js:40`), so the channel is `__keyevent@0__:expired`.
- Failure mode: caller-visible: none beyond later removal (falls back to the staleness rule); a dropped subscriber connection reconnects with the REQ-06 subscriber (Pub/Sub is fire-and-forget: events during the gap are lost and covered by the staleness rule). Writes no durable state except the config change.
- Rollback: `redis-cli CONFIG SET notify-keyspace-events ""` (or the pre-existing value logged at startup); remove the subscription; the client staleness rule remains.
- Observability: `redis-cli CONFIG GET notify-keyspace-events` contains `Ex`; `redis-cli INFO stats` → `expired_keys` increases as hashes age out; `/api/redis/status` → `keyspaceNotifications: true|false`, `expiredEventsForwarded` counter.
- Compatibility impact: `CONFIG SET` changes a server-wide setting (adds `E` and `x` flags); other subscribers on the same Redis see additional keyevent traffic.
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/events.test.mjs` (scenario 2 with a 2 s TTL); `redis-cli --csv PSUBSCRIBE '__keyevent@0__:expired'` while a hash expires.
- Handoff task, if any: Keyspace expired subscription forwarded as SSE removal events

### REQ-10: Bloom-filter deduplication of unchanged AIS positions before `XADD`

- Source: `GEV-Redis-Analysis.md` §8 "Bloom Dedup on AIS Ingest"
- Depends on: REQ-07, REQ-03
- Baseline row: B7
- Rationale: each AIS refresh (60,000 ms) re-sends every vessel, most with an unchanged position; dropping unchanged records before `XADD` cuts stream entries, staging writes and publish batches. A Bloom filter answers "seen this exact fingerprint" in one command with bounded false positives (probabilistic doc: `BF.ADD` returns 0 for an already-added item, 1 otherwise; false positives only, no false negatives).
- Evidence checked: `server/redis/pipeline.js:281-310` (`projectOnce`: records → `XADD` in batches of 100); `src/data/aisLiveVessels.js:61, 1167-1174`; `server/redis/README.md:17-18` (AIS stream target 100,000 entries), `:245` (AIS 75 s allowance); BF.RESERVE https://redis.io/docs/latest/commands/bf.reserve/ ("1% error rate requires 7 hash functions and 9.585 bits per item"; `EXPANSION` default 2; error `ERR item exists` when the key exists); probabilistic overview https://redis.io/docs/latest/develop/data-types/probabilistic/ ; `rules/ram-ttl.md`.
- Impacted files/components: `server/redis/pipeline.js` (`projectOnce` dedup step for `ais-live-vessels`), new `server/redis/dedup.js` (fingerprint, hourly filter key, `BF.RESERVE`), `server/redis/plugin.js` (`/status` counters), `server/redis/pipeline.test.mjs`, new `server/redis/dedup.test.mjs`
- Contract shape: filter key `gev:ais-live-vessels:seen:<YYYYMMDDHH>` (UTC hour), created with `BF.RESERVE <key> 0.01 800000 EXPANSION 2` + `EXPIRE <key> 7200` (7200 s = 2 × 3600 s so the previous hour's filter survives the hour boundary); capacity 800,000 = 12,500 vessels (`scripts/redis-load-check.mjs:34`) × 60 refreshes per hour rounded up to the next 100,000 → memory 800,000 × 9.585 bits / 8 ≈ 958,500 bytes ≈ 0.96 MB per filter, 2 filters resident. Fingerprint = `<mmsi>:<lat4>:<lon4>:<spd1>:<cog0>` where `lat4`/`lon4` are the position rounded to 4 decimals (11.1 m), `spd1` = speed rounded to 1 decimal, `cog0` = course rounded to an integer; per record `BF.ADD <key> <fingerprint>` → 1 = new (keep, `XADD`), 0 = seen (drop, then `EXPIRE gev:ais-live-vessels:pos:<mmsi> 300` and `EXPIRE gev:ais-live-vessels:entity:rows:<mmsi> 3600` to keep the entity alive). `/api/redis/status` per-layer fields `dedupTotal`, `dedupSkipped` (integers since start).
- Acceptance scenarios:
  - Given: an AIS batch of 1,000 rows of which 400 repeat the previous refresh's fingerprint exactly
    When: `projectOnce('ais-live-vessels', …)` runs
    Then: `redis-cli MONITOR` shows 1,000 `BF.ADD gev:ais-live-vessels:seen:<hour> …`, 600 `XADD gev:ais-live-vessels:stream …`, and 400 pairs of `EXPIRE gev:ais-live-vessels:pos:<mmsi> 300` / `EXPIRE gev:ais-live-vessels:entity:rows:<mmsi> 3600`; `/api/redis/status` shows `dedupTotal` +1000, `dedupSkipped` +400.
  - Given: the hour changes from 13 to 14 UTC
    When: the first AIS batch of hour 14 arrives
    Then: `MONITOR` shows `BF.RESERVE gev:ais-live-vessels:seen:<YYYYMMDD>14 0.01 800000 EXPANSION 2` and `EXPIRE … 7200` once; `redis-cli BF.INFO gev:ais-live-vessels:seen:<YYYYMMDD>14` → `Capacity 800000`; every row of that batch returns 1 from `BF.ADD` (fresh filter) and is `XADD`ed.
  - Given: a vessel at anchor broadcasting an identical fingerprint every refresh for 20 minutes
    When: observed
    Then: `redis-cli TTL gev:ais-live-vessels:pos:<mmsi>` stays in (0, 300] throughout and `FT.SEARCH gev:ais-live-vessels:posidx "@loc:[<lon> <lat> 1 km]" NOCONTENT` keeps returning the key; no `expired` event (REQ-09) is emitted for it.
  - Given: two concurrent ingests race on `BF.RESERVE` for the same hour key
    When: the second `BF.RESERVE` returns `ERR item exists`
    Then: the error is caught and the batch proceeds (no ingest failure).
  - Given: B7 measured before and after
    When: compared over 60,000 ms windows with the same vessel population
    Then: `entries-added` per minute after ≤ 0.7 × before.
- Constraints:
  - `ais-live-vessels` only, and only while the layer is in `DELTA_LAYERS` (REQ-07): the snapshot member list (`RPUSH … members`) is rebuilt per cohort from the records that were `XADD`ed, so dropping records would remove vessels from a snapshot read; on the delta path presence comes from the hot hash, which the heartbeat `EXPIRE` keeps alive.
  - False-positive bound: error rate 0.01 → at most 1 in 100 genuinely new fingerprints dropped per filter lifetime; a dropped update is superseded by the next refresh (60,000 ms) whose fingerprint differs (moving vessel) or is identical (no information lost).
  - Commands per AIS ingest: N `BF.ADD` + (N − skipped) `XADD` + 2 × skipped `EXPIRE`, all pipelined in the existing 100-record batches (`pipeline.js:303-309`).
- Failure mode: caller-visible: none; `BF.ADD` error (module missing, memory) → dedup disabled for that batch and every record `XADD`ed (over-ingestion is the pre-change behaviour); one warning logged. Crash mid-write: a process crash between `BF.ADD` and the `XADD` pipeline leaves a fingerprint recorded for a position that was never appended → that position is dropped until the next refresh (60,000 ms) at most.
- Rollback: remove the dedup step; `redis-cli DEL gev:ais-live-vessels:seen:<hour>` for the two resident filters (or wait 7200 s).
- Observability: `redis-cli BF.INFO gev:ais-live-vessels:seen:<hour>` → `Number of items inserted`, `Number of filters` (1 unless capacity exceeded); `/api/redis/status` → `dedupSkipped / dedupTotal`; `XINFO STREAM gev:ais-live-vessels:stream` → `entries-added` rate (B7).
- Compatibility impact: fewer stream entries and CMS increments for AIS (`gev:ais-live-vessels:frequency` counts distinct-position updates instead of every refresh); `updateCount` (`pipeline.js:459`) values for vessels decrease accordingly.
- Verification: `REDIS_URL=redis://127.0.0.1:16379 node --test server/redis/dedup.test.mjs server/redis/pipeline.test.mjs`; `redis-cli BF.INFO gev:ais-live-vessels:seen:<hour>`.
- Handoff task, if any: Bloom fingerprint dedup with hot-hash heartbeat for AIS ingest
