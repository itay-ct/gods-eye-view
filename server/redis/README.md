# Redis entity pipeline

Run `npm run dev`, expand **Data Layers**, and select **Redis**. All 15 layer feeds use the Redis path.
**No Redis** retains original GEV fetching. Switching reloads the current shared view to clear browser caches.
This increment uses the Vite development server; `.env` and `demo-implementation.md` are unchanged.

## Local Redis

Redis 8.2+ with JSON and Count-Min Sketch is required; tested with Redis 8.10.0.

```sh
docker run -d --name gev-redis -p 127.0.0.1:6379:6379 \
  -v gev-redis-data:/data redis:8.10.0 \
  redis-server --appendonly yes --maxmemory 768mb --maxmemory-policy noeviction
```

For the existing container: `docker start gev-redis` / `docker stop gev-redis`.
Optional server overrides: `REDIS_URL` (default `redis://127.0.0.1:6379`) and
`REDIS_STREAM_MAXLEN` (default `10000`).

## Entity storage and reads

1. `POST /api/redis/ingest` reuses the original source adapter and publishes records to its layer Stream.
2. The `view-projector` consumer stages individual JSON documents, then atomically publishes them with compact snapshot metadata and an ordered Redis List of entity keys.
3. Ingestion returns a snapshot URL, **no source records**.
4. The browser calls `GET /api/redis/snapshot`. This endpoint reads individual RedisJSON entities; it cannot fetch
   upstream data, ingest, or fall back to a direct source. Missing Redis entities produce an explicit failure.

CCTV's bundled fallback uses `/api/redis/local` followed by the same read-only snapshot endpoint.
Source failures can return error responses; successful render data always comes from Redis.
GEV still owns interpolation, satellite propagation, traffic simulation, and geometry decoding. Base-map tiles,
video/images, radio audio, terrain helpers, and user presentation settings retain their original paths.

| Key | Type / purpose |
| --- | --- |
| `gev:military:entity:ac:<icao24>` | One native RedisJSON aircraft document |
| `gev:earthquakes:entity:features:<usgs-id>` | One native RedisJSON earthquake document |
| `gev:<layer>:entity:<family>:<id>` | Individual source entity; stable across requests/viewports |
| `gev:<layer>:snapshot:<cohort>` | Small native JSON: source URL, response envelope, group counts, total count and generation token |
| `gev:<layer>:snapshot:<cohort>:members` | Redis List of entity keys, once each, in source order |
| `gev:<layer>:stream` | Source record events and snapshot commit events |
| `gev:<layer>:frequency` | Shared Count-Min Sketch counting changed source record IDs |
| `gev:<layer>:staging:<generation>:<id>` | Temporary individual JSON document, outside entity index prefixes |

JSON preserves nested GeoJSON, source arrays and native numeric/boolean/null types. Documents expose named
`id`, `layer`, `kind`, `label`, `latitude`, `longitude`, `location` (lon,lat), `altitudeM`, and `speedMps` fields,
plus native nested `source` data. Missing measurements remain null. The renderer reconstructs provider payloads
from each document's `source`. Normalized fields are derived at ingestion; editing them alone does not edit the
source payload. Source-record families separate different object kinds. GBFS source URLs additionally scope
station IDs because different providers reuse them. Anonymous records use content digests.

A current entity can be shared by several viewports; the latest committed source record is authoritative.
Each entity has a native `collections` array of the snapshots that reference it; there are no separate
`:owners` keys. Removing an entity from one collection retains it while another unexpired collection references it.
Entities and snapshot keys expire after one hour without ingestion; abandoned staging expires after 24 hours. This is demo retention.

For military aircraft, `ac` is the provider's aircraft family and `<id>` is the ICAO24 identifier. The
`<cohort>` suffix identifies a source request (a digest of URL, method and body), not an aircraft. The
snapshot's `source` field shows the original URL after its next refresh. A List is needed because the
original GEV parser expects a complete response in source order; the aircraft data itself is read from the
individual JSON documents. For a snapshot with no entities, the metadata has `count: 0` and no List key.

Useful inspection commands (substitute a snapshot ID from your instance):

```text
JSON.GET gev:military:entity:ac:02b26b
JSON.GET gev:military:snapshot:<cohort>
LRANGE gev:military:snapshot:<cohort>:members 0 9
XLEN gev:military:stream
```

## Redis Search readiness

No permanent Search index is created yet. A real temporary `ON JSON` index is exercised by the integration test.
For example, an aircraft index can use:

```text
FT.CREATE gev:military:idx ON JSON PREFIX 1 gev:military:entity: SCHEMA
  $.id AS id TAG
  $.label AS label TEXT
  $.location AS location GEO
  $.altitudeM AS altitudeM NUMERIC
  $.source.gs AS groundSpeedKnots NUMERIC
```

## Layer statistics

The main line is **“12,345 events · last ingested 3s ago”**:

- Events = `XINFO STREAM` → `entries-added`, the lifetime total including commit events. Trimming does not reset it.
- Last ingested = millisecond portion of `last-generated-id`, because ingestion uses automatic `XADD *` IDs.
  This is ingestion time, not a source observation timestamp or proof the consumer finished processing.
- Hover the text for exact `entries-added`, `last-generated-id`, and retained `length` values.
- Pending/lag appears only when work is outstanding. Original source errors/fallback state remain visible.
- The count beside each layer name remains GEV's current rendered-object count.

CMS increments for changed source records, not only position changes. Identical snapshots and completed-commit
retries do not increment it. Counters persist across toggles/restarts; approximation is inherent to CMS.
The obsolete collection hashes and metrics hashes have been removed. Stream history and sketches are retained;
schema 3 migrates old `:view:` manifests to compact metadata plus Lists and moves ownership into entity JSON.
It preserves entity values, Stream history, CMS counts, and pending schema-2 events.

## Stream settings and checks

`MAXLEN ~ 10000 ACKED` trims acknowledged events only. One stable `local-view` consumer per layer uses
`COUNT 200`, `BLOCK 1000`, and a dedicated blocking connection. Restart drains its pending entries first.
The consumer also trims exactly to 10,000 after acknowledging each batch. Unacknowledged events are protected, so retention can temporarily exceed the target. Large snapshots remain valid because earlier entries are staged before trimming. Intake pauses above twice the retention target; `noeviction` makes memory pressure visible. Keep one projector
process for this MVP. Before adding workers, add ordering/ownership rules and abandoned-consumer claiming.
Polling is retained; Pub/Sub/SSE invalidations can be added later with snapshot recovery after reconnect.

```sh
node --test server/redis/pipeline.test.mjs
node --test src/data/redisMode.test.mjs src/data/manager.test.mjs
npm run build
```

Tests cover payload fidelity, individual JSON keys, Search indexing, duplicate counting, removals, empty
snapshots, pending recovery, repeated commits, overlapping/expired memberships, schema migration, Redis edit/readback without ingestion, and XINFO totals after trimming.

A small warning beneath the Redis toggle reports connection, consumer, ingestion, or snapshot-read failures and clears when the affected operation succeeds again.

## Recovery after a manual flush

`FLUSHDB` / `FLUSHALL` remove entities, Stream history, groups and CMS counters. The next status poll or
ingestion recreates missing Streams, consumer groups and sketches; the Vite server does not need restarting.
The existing `projection-schema` key also carries a generation ID, so an in-flight writer cannot publish an
old generation after recovery. A reset during ingestion retries the full snapshot once. A reset between the
browser's receipt and snapshot read also retries the Redis path once, preserving cancellation.

Switching **No Redis → Redis** performs the repairing connection check before reloading the page. While
Redis is selected, the two-second status poll detects a new generation and automatically reloads the current
shared view to clear layer caches and re-ingest enabled feeds, including static layers. A connection outage
shows the warning; after reconnection the page reloads its layers. Hidden tabs check when visible again.
No direct-source fallback is introduced. Repeated resets or a continuing outage still show an error instead
of retrying forever. Historic Stream/CMS counts erased by a flush cannot be recovered; they restart from zero.

## Layer OFF means ingestion OFF

Redis fetching checks the layer manager's current visibility intent, including enabling/disabling transitions.
OFF blocks new requests and cancels in-flight requests for that layer, including background helpers such as
civilian-flight military classification. This stops that helper's military-feed ingestion while Military Flights
is off; existing classification data remains cached. No Redis mode retains original GEV behavior.

Browser cancellation propagates to server fetching and projection. A batch or commit already accepted by Redis
can finish processing; cancellation stops subsequent batches and commits. Existing entities and Stream history
remain until their normal expiry/retention, so keys remaining in Redis do not imply continued ingestion.
Compare `XINFO STREAM` → `entries-added` / `last-generated-id` to verify intake stopped. Status checks can
repair empty infrastructure keys without ingesting entities. Redis is shared: another tab with the layer ON
can still ingest into the same Stream. Requests from different tabs have independent cancellation.
