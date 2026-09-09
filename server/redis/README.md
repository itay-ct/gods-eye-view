# Redis entity pipeline

Run `npm run dev`, expand **Data Layers**, and select **Redis**. All 15 layer feeds use the Redis path.
**No Redis** retains original GEV fetching. Switching reloads the current shared view to clear browser caches.
This increment uses the Vite development server; `.env` and `demo-implementation.md` are unchanged.

## Local Redis

Redis 8.2+ with JSON, Search and Count-Min Sketch is required; tested with Redis 8.10.0.

```sh
docker run -d --name gev-redis -p 127.0.0.1:6379:6379 \
  -v gev-redis-data:/data redis:8.10.0 \
  redis-server --appendonly yes --maxmemory 768mb --maxmemory-policy noeviction
```

For the existing container: `docker start gev-redis` / `docker stop gev-redis`.
Optional server overrides: `REDIS_URL` (default `redis://127.0.0.1:6379`) and
`REDIS_STREAM_MAXLEN` (default `10000` for other layers). Flights and Live AIS use a `100000`-entry target.

## Entity storage and reads

1. `POST /api/redis/ingest` reuses the original source adapter and publishes records to its layer Stream.
2. The `view-projector` consumer stages individual JSON documents, publishes them in bounded batches, then commits compact snapshot metadata and an ordered Redis List of entity keys.
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
| `gev:<layer>:frequency` | Shared Count-Min Sketch counting every projected source record ID |
| `gev:<layer>:staging:<generation>:<id>` | Temporary individual JSON document, outside entity index prefixes |
| `gev:<layer>:staging:<generation>:commit*` | Temporary publication cursor, next member List and membership Set; removed after completion |
| `gev:<layer>:publishing` / `:revision` | Publication guard and revision used to prevent mixed-generation UI reads |

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

### Flights

Aircraft type lookups (`/api/adsbdb/type/<icao24>`) now enter the flight Stream as enrichment records.
The projector merges `typeCode`, `typeName`, `registration`, and `enrichmentUpdatedAt` into the same
`gev:flights:entity:states:<icao24>` JSON as the position. Position snapshots preserve these fields;
empty lookup fields do not erase known values. Lookups arriving before a position create an enrichment-only
document, which becomes a flight when its first state vector arrives. Completed commit replay does not double-count CMS.
Enrichment responses and map snapshots both read these fields from the entity JSON.
Redis intake also joins fresh entries from GEV’s existing `.gev-cache/adsbdb.json` onto incoming state records before XADD. This reuses cached types for off-screen aircraft without additional provider calls or separate CMS increments. Entries older than the proxy’s 24-hour TTL are ignored; newer projected enrichment takes precedence.

With Redis ON and Live Flights enabled, **Filter** shows **Label** and **Type** on one line. Edits immediately
query Redis Search. Labels use word-prefix matching; Type selects the exact `typeName`. Excluded aircraft and
their tracked labels are removed immediately, bypassing GEV's usual missing-poll grace. Filter off restores
the full snapshot. Normal position polling and GEV's bounded type lookups continue through Streams.

`gev:flights:idx` indexes label and typeName as TEXT, with typeName SORTABLE and a TAG alias for exact selection.
The Type dropdown uses `FT.AGGREGATE` to show the 20 most common known type names
among flights matching the current label, ordered by count descending (alphabetical ties).
The All types option reports the total and how many have known type information. GEV enriches a bounded subset of visible aircraft; unknown types are not inferred. Counts refresh even with an empty label.
Each option includes its count; the selected type does not restrict the option counts.
The map uses `FT.SEARCH` over cached positioned aircraft, including aircraft missing from
regional fallback responses. Missing aircraft retain their existing expiry without additional
CMS increments; expired entities disappear. Unknown types remain visible with All types.

```text
JSON.GET gev:flights:entity:states:34454b
FT.AGGREGATE gev:flights:idx '@kind:{states} @typeKnown:[1 1]' GROUPBY 1 @typeName REDUCE COUNT 0 AS count SORTBY 4 @count DESC @typeName ASC LIMIT 0 20
FT.SEARCH gev:flights:idx '@kind:{states} @label:(VLG*)' LIMIT 0 100
```

Reload the demo once to populate previously unmerged type lookups through the new projector. No database flush
is required. Type details retain the existing one-hour entity lifetime; a lookup does not invent a position.

### Live AIS Vessels

With Redis and Live AIS Vessels ON, **Filter** shows one inline **Label** text input.
Edits immediately run word-prefix `FT.SEARCH` against the per-vessel JSON `label`
field in `gev:ais-live-vessels:idx`. Filter refreshes read the current Redis snapshot
without ingesting again; normal AIS polling continues through Streams. Filtered-out
selected vessels and their trails are removed immediately, including zero matches.
Turning Filter off restores the snapshot; AIS track requests remain unfiltered.

### Radio stations

With Redis and Radio ON, **Filter** shows inline **Name** and **Tag** controls. Name uses word-prefix
`FT.SEARCH`; Tag queries the entity's indexed `categories` array. These categories use the original radio
classification rules, including music genres. `gev:radio:idx` indexes `label` as TEXT and `categories` as TAG.
Existing entities gain categories on their next directory ingestion.

The Tag dropdown and existing radio panel share one selection and update each other. Counts retain the
panel's full-catalogue category totals. Search matches restrict map markers, clusters, and the tuner list;
the underlying full catalogue stays intact. Filter edits read Redis without ingesting again. Turning Filter
off removes the name restriction while preserving the existing tag. Controls are hidden when the layer is OFF.

### Datacenters

With Redis and Datacenters ON, **Filter** shows inline **Name** and **Operator** controls.
Name uses word-prefix `FT.SEARCH`; Operator is an exact, case-insensitive TAG filter.
The JSON index `gev:local-datacenters:idx` reads `source.properties.tags.name` and
`source.properties.tags.operator`, so existing documents need no migration.
The dropdown shows the top 20 operators by matching name count, using `FT.AGGREGATE`;
capitalization variants are combined to agree with Search matches. Counts refresh with
an empty name too. Unknown operators remain included under All operators.
Filter edits read Redis snapshots without ingesting again. Nonmatching map entities and
labels are hidden; disabling Filter restores the full catalogue. Controls are hidden
when Redis or the layer is OFF.

### Satellites

Satellites automatically create `gev:satellites:idx` on the individual JSON documents:

```text
FT.CREATE gev:satellites:idx ON JSON PREFIX 1 gev:satellites:entity: STOPWORDS 0 SCHEMA
  $.name AS name TEXT NOSTEM
  $.type AS type TEXT NOSTEM
  $.collections[*] AS collections TAG
FT.SEARCH gev:satellites:idx '@name:(ISS) @type:(STATION)' LIMIT 0 100
```

With Redis ON, use **Filter** below the satellite ON/OFF button, edit **Name** or choose **Type**. Each change immediately queries Redis Search; newer input cancels the previous refresh.
Name matches word prefixes, case-insensitively: `STAR` searches `@name:(STAR*)` and matches `STARLINK`.
Prefixes require two characters; single-character words match literally. Choose a category from the Type dropdown,
or All types. Words and fields combine with AND; an empty name is unrestricted.
Types use the same catalog classification as the map: STATION, NAV · GPS/GLONASS/GALILEO, GEO, VISUAL,
and COMMS · STARLINK (enable DENSE for Starlink). This is a catalog category, not a payload/mission type inferred
from TLE. Existing DENSE controls remain available; the class-count legend is replaced by the filter form.
Toggle Filter off to restore the full catalog. Filters clear and close when the layer is switched OFF, and on reload. Radio also resets its shared tag to All.

Each input change re-reads cached snapshot references using `FT.SEARCH`, scoped to each source collection. It does not
increment the Stream or CMS. An expired/missing snapshot is re-ingested through the normal Stream path.
Scheduled feed refreshes still ingest the complete catalog, then filter only the view. Empty Search results
clear the visualization, and result limits cover the complete snapshot rather than Redis's default first 10.
An index removed by a flush or `FT.DROPINDEX` is recreated, with reads waiting for background indexing.

Satellite JSON also exposes `name`, `type`, `group`, `internationalDesignator`, `classification`, and an `orbit`
object with epoch, inclination, ascending node, eccentricity, argument of perigee, mean anomaly, mean motion,
revolution number and B* drag term. `classification` is the TLE security-classification letter, separate from type.
Position/altitude/speed are SGP4 estimates at `positionAt`; `positionStatus` indicates whether propagation succeeded.
They are not live measurements. The browser still propagates the retained `source.text` using original GEV code.
On the next normal ingestion, existing satellite documents gain these fields through the Stream projector.
Overlapping catalog groups follow GEV's priority rather than last-arrival order.

Military flights automatically create `gev:military:idx` on `gev:military:entity:ac:` documents.
The inline **Label / Type** filter works while Redis and the layer are ON. Label uses word-prefix
`FT.SEARCH`; Type is an exact match on the provider's `source.t` aircraft designator (such as C17),
indexed as `typeName` / `typeNameExact`. `FT.AGGREGATE` ranks the top 20 known types by count among
flights matching the label. Filtering only re-reads Redis; it does not add Stream events or CMS counts.

```text
FT.SEARCH gev:military:idx '@kind:{ac} @label:(RCH*) @typeNameExact:{C17}' LIMIT 0 100
```

## Layer statistics

The main line is **“12,345 events · 3s ago”**. Idle, disabled layers have no metadata line:

- Events = `XINFO STREAM` → `entries-added`, the lifetime total including commit events. Trimming does not reset it.
- Last ingested = millisecond portion of `last-generated-id`, because ingestion uses automatic `XADD *` IDs.
  This is ingestion time, not a source observation timestamp or proof the consumer finished processing.
- Hover the text for exact `entries-added`, `last-generated-id`, and retained `length` values.
- Pending/lag appears only when work is outstanding. Original source errors/fallback state remain visible.
- The count beside each layer name remains GEV's current rendered-object count.

CMS increments for every object record applied by a snapshot commit, including identical source values.
Redelivery of the completed commit does not increment it again. Counters persist across toggles/restarts; approximation is inherent to CMS.
The obsolete collection hashes and metrics hashes have been removed. Stream history and sketches are retained;
schema 3 migrates old `:view:` manifests to compact metadata plus Lists and moves ownership into entity JSON.
It preserves entity values, Stream history, CMS counts, and pending schema-2 events.

## Stream settings and checks

`MAXLEN ~ 100000 ACKED` applies to Flights and Live AIS; other layers use `MAXLEN ~ 10000 ACKED` by default. Both trim acknowledged events only. One stable `local-view` consumer per layer uses
`COUNT 200`, `BLOCK 1000`, and a dedicated blocking connection. Each read is processed by scripts of at most
25 records; commits also publish and remove memberships in batches of 25. Restart drains pending entries
and resumes a durable commit cursor. Each batch's entity writes, CMS increments, and cursor advance are atomic,
so replay does not count the batch twice. Entity enrichment is assembled on unindexed staging keys before one
indexed JSON write per entity. Scripts use cached `EVALSHA`, with automatic reload after `SCRIPT FLUSH`.

Ingestion pipelines up to 100 `XADD` commands. Snapshot reads pipeline up to 100 `JSON.GET` commands, and
`FT.SEARCH` runs outside Lua. The default snapshot API verifies the layer revision before and after
fetching and retries overlapping publication. Metadata/member-list publication and the final Stream
acknowledgement happen together.

The browser opts into progressive reads. HTTP ingestion immediately returns a receipt over an NDJSON
control stream, then reports progress/completion while the upstream fetch and projection continue.
The browser reads cached Redis JSON immediately and refreshes it as batches finish; a cold snapshot
returns HTTP 202 until its first batch exists. Each document is written atomically, but a progressive
view may combine new batches and previous cached objects until final publication removes stale members.
Map data always comes from the Redis snapshot endpoint, never from the control stream or provider.
Layer OFF aborts ingestion and pending reads. Snapshot reads remain pipelined in bounded batches.

The consumer also trims to the layer’s target (100,000 or 10,000) after each read batch and completed commit. Unacknowledged events are protected, so retention can temporarily exceed the target. Large snapshots remain valid because earlier entries are staged before trimming. Intake pauses above twice the retention target; `noeviction` makes memory pressure visible. Keep one projector
process for this MVP. Before adding workers, add ordering/ownership rules and abandoned-consumer claiming.
Source polling is retained. The ingestion control stream triggers coalesced Redis view refreshes only when publication advances, plus one final refresh. Keepalives are silent, and background reads do not show loading banners or change the layer button to LOADING. It does not use Redis Pub/Sub or browser SSE.

```sh
node --test server/redis/pipeline.test.mjs
node --test server/redis/projectionBatches.test.mjs
node --test --test-concurrency=1 server/redis/*.test.mjs
node --test src/data/redisMode.test.mjs src/data/manager.test.mjs
npm run build
```

Tests cover payload fidelity, individual JSON keys, Search indexing, per-update counting, removals, empty
snapshots, pending recovery, repeated commits, overlapping/expired memberships, schema migration, Redis edit/readback without ingestion, and XINFO totals after trimming.

For a repeatable load check, use a disposable Redis instance:

```sh
REDIS_URL=redis://127.0.0.1:16379 node scripts/redis-load-check.mjs
```

It ingests 10,000 flights and 12,500 AIS vessels concurrently for three rounds, checks Search results and
Stream retention, and measures a separate client's PING latency. Synthetic keys and indexes are removed afterward.

A small warning beneath the Redis toggle reports connection, consumer, ingestion, or snapshot-read failures.
Source fetch failures include the layer and endpoint, so an upstream timeout is not reported as a Redis crash.
Click the warning to check Redis, repair enabled layer infrastructure, and refresh enabled layers sequentially.
The warning clears after successful recovery; continuing failures remain visible. Retry preserves layer toggles
and the current map view. It does not erase stored data.

Live AIS allows 75 seconds for the complete Redis ingestion/projection/read path; No Redis retains the original
10-second request limit. Health checks allow 10 seconds so a busy projector is less likely to cause a false
connection warning. Upstream source requests remain bounded at 35 seconds, independently of Redis processing.
After enqueueing a commit, the server allows up to two minutes while the consumer advances, but fails after
30 seconds without consumer progress. Browser cancellation still stops the request; an already accepted commit
can finish in the background. A busy layer can take longer to refresh without blocking unrelated Redis clients.

## Docker resources and BUSY errors

`BUSY Redis is busy running a script` means a script exceeded Redis's busy-response threshold (normally five
seconds). It does not mean the Redis memory limit was reached. Increasing the threshold masks the symptom;
small scripts and fewer indexed writes address the blocking work. Do not use `SHUTDOWN NOSAVE` as demo recovery.

There are three separate resource limits:

- Docker Desktop **Settings → Resources → Advanced** controls the VM's total CPUs and memory, shared by all containers.
- Container `--memory` and `--cpus` flags are ceilings, not reserved allocations. An unconstrained container already
  shares all resources available to Docker; adding a CPU limit does not give it more CPU.
- Redis `maxmemory` limits its managed dataset. Leave additional container memory for indexes, buffers, fragmentation,
  and persistence work; retain `noeviction` so infrastructure and pending data are not silently evicted.

On the inspected machine, Docker had 10 CPUs and 7.65 GiB, Redis had no container-specific cap, and Redis's dataset
limit was 768 MiB. A larger dataset can use a 2 GiB Redis limit inside a 4 GiB container ceiling, provided other
containers have sufficient headroom. These commands change the existing container without deleting its volume:

```sh
docker update --memory 4g --memory-swap 4g gev-redis
docker exec gev-redis redis-cli CONFIG SET maxmemory 2gb
```

The Redis setting is runtime-only for the current command-line-configured container. For persistence across
container restarts/recreation, set `--maxmemory 2gb` in its `redis-server` startup command and retain the existing
`gev-redis-data:/data` volume. Resource changes above are optional and were not applied by the code change.
See [Docker resources](https://docs.docker.com/desktop/settings-and-maintenance/settings/) and
[Redis script execution](https://redis.io/docs/latest/develop/programmability/).

## Recovery after a manual flush

`FLUSHDB` / `FLUSHALL` remove entities, Stream history, groups and CMS counters. The next status poll or
ingestion recreates missing Streams, consumer groups and sketches; the Vite server does not need restarting.
The existing `projection-schema` key also carries a generation ID, so an in-flight writer cannot publish an
old generation after recovery. A reset during ingestion retries the full snapshot once. A reset between the
browser's receipt and snapshot read also retries the Redis path once, preserving cancellation.

Switching **No Redis → Redis** performs the repairing connection check before reloading the page. While
Redis is selected, the two-second status poll detects a new generation and automatically reloads the current
shared view to clear layer caches and re-ingest enabled feeds, including static layers. A connection outage
shows the warning; successful health checks clear it without reloading the page. A transient timeout is not
a database reset. Hidden tabs check when visible again. Traffic tile loading is limited to four concurrent
requests, and disabling traffic cancels queued tiles to reduce load during CCTV startup.
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

## Focused-object update counts

In Redis mode, focused/tracked map labels show **“≈ 123 updates”**, refreshed every two seconds while the
layer is enabled. The browser uses read-only `GET /api/redis/updates?layer=<layer>&id=<source-id>`, which runs
`CMS.QUERY gev:<layer>:frequency <source-id>`. Callsigns and display names are not sketch keys. Counts are
approximate; unavailable Redis is shown as unavailable, not zero. No Redis mode makes no count queries.

The consumer increments `CMS.INCRBY` for every entity applied by a completed projection, even if its source
values are unchanged. Re-delivering the completed commit does not count twice. Cancelled partial snapshots
that never commit do not count as projected updates. Existing sketches retain their previous counts; the new
per-update semantics apply from this change onward. Flush Redis for a fresh demo count.

## Natural-language search (beta)

`POST /api/redis/search/transcribe` accepts a bounded audio recording; `/search/plan` reads `FT._LIST`
and `FT.INFO`, obtains a structured Terra plan, and compiles it into an allowed command. `/search/run`
accepts only a server-issued plan ID, not arbitrary command arguments. Commands have a one-second
Redis timeout and at most 20 returned rows. Aggregations compute across the matching set before limiting
output rows. Concurrent runs of the same plan are rejected; UI refreshes never overlap.

Existing entity indexes gain ID, speed, altitude, latitude/longitude and GEO fields on first search.
`geoLocation` is a nullable GEO-safe projection of the same coordinates: Redis GEO excludes polar
latitudes beyond ±85.05112878°, while numeric coordinate fields preserve those entities for other queries.
Existing JSON documents gain this derived field in bounded pipelines; new projection records include it.
The original `location` and source measurements are preserved. Index setup does not increment CMS counts.
Geo radius and approximate area queries use Redis Search, nearest lookup uses `geodistance`, and numeric
aggregates exclude missing measurements. Empty aggregates display no matches, never a fabricated zero.

Query planning also receives the top 20 existing values and counts for satellite/aircraft types,
datacenter operators, and radio tags. Scalar fields use a bounded `FT.AGGREGATE` grouping. Radio tags
are multi-valued: `FT.TAGVALS` discovers the small category vocabulary, then pipelined `FT.AGGREGATE`
counts each tag independently so secondary tags are included. Suggestions are not exhaustive.
The current tab's layer availability accompanies planning and execution. Disabled layers produce
an enable-layer message even if Redis retains their documents; disabling an active aggregate stops it.

`POST /api/redis/search/preset` accepts an allowlisted preset ID plus current selection/view and layer
states. The server builds the query itself, checks only the target index (without categorical sampling),
and returns a plan ID for the same execution/refresh path. No OpenAI call is made. The first search may
initialize missing common index fields; subsequent clicks run against the existing schema. Preset
coordinates are captured when clicked, so a live aggregation keeps its requested area until dismissed.
