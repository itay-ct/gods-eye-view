# GEV Redis improvements — spec set

Source of truth: `GEV-Redis-Analysis.md` (PR [itay-ct/gods-eye-view#1](https://github.com/itay-ct/gods-eye-view/pull/1), head `f5a8007`). This directory is one change delta split into numbered parts. Read them in order; `cat specs/redis-improvements/0*.md` reproduces the full document for tooling.

| File | Contents |
|---|---|
| `00-overview-and-baseline.md` | header, summary, terminology, Baseline (REQ-00) table |
| `01-write-path.md` | REQ-02 Lua → WATCH/MULTI (MODIFIED), REQ-04 flat fields (MODIFIED), REQ-05 enrichment-only cold doc + posidx routing (MODIFIED), REQ-03 hot hash + posidx (ADDED) |
| `02-read-path.md` | REQ-01 single LRANGE (MODIFIED), REQ-07 delta reads (ADDED), REQ-08 grid clusters (ADDED) |
| `03-transport-lifecycle.md` | REQ-06 SSE via PUBLISH, REQ-09 expiry events, REQ-10 AIS Bloom dedup (ADDED) |
| `04-showcase.md` | REQ-14 Top-K (MODIFIED), REQ-12 Arrays trails, REQ-13 GEOSHAPE areas, REQ-15 HLL, REQ-16 vectors + LangCache (ADDED) |
| `05-shared-sections.md` | REQ-02R (REMOVED), SUPERSEDED, DEFERRED (DEF-A, DEF-B), Dependency DAG, Cross-REQ Interactions, Non-Goals, Assumptions, Open Decisions, Test Strategy, Security, Consumer Rollback, Validation Report, Execution Handoff, Revision History |

## Analysis → REQ mapping

| Analysis section | REQ | Classification |
|---|---|---|
| §1 Viewport-scoped delta reads | REQ-07 | ADDED |
| §2 Density clustering | REQ-08 | ADDED |
| §3 SSE via explicit PUBLISH | REQ-06 | ADDED |
| §4 Flatten source blobs — projector half | REQ-04 | MODIFIED |
| §4 Flatten source blobs — client half | DEF-A | DEFERRED |
| §5 Lua → MULTI | REQ-02 (+ REQ-02R) | MODIFIED (+ REMOVED) |
| §6 Hot/cold split — hot half | REQ-03 | ADDED |
| §6 Hot/cold split — cold half | REQ-05 | MODIFIED |
| §7 Single LRANGE | REQ-01 | MODIFIED |
| §8 Bloom dedup on AIS | REQ-10 | ADDED |
| §9 Expiry keyspace notifications | REQ-09 | ADDED |
| §10 Redis Arrays | REQ-12 | ADDED |
| §11a GEOSHAPE polygons | REQ-13 | ADDED |
| §11b Top-K | REQ-14 | MODIFIED |
| §11c HyperLogLog | REQ-15 | ADDED |
| §11d Vector search + semantic cache | REQ-16 | ADDED |
| §11e Multi-projector | DEF-B | DEFERRED |
| Acceptance metrics table | REQ-00 Baseline | — |

## Migration order

Topological sort of the `Depends on:` fields (details in `05-shared-sections.md`): REQ-00 → REQ-01 → REQ-02 → REQ-02R → REQ-04 → REQ-16 → REQ-03 → REQ-06 → REQ-14 → REQ-15 → REQ-07 → REQ-09 → REQ-12 → REQ-13 → REQ-08 → REQ-05 → REQ-10.

## Validation

```bash
SPEC="$TMPDIR/gev-redis-spec.md"; cat specs/redis-improvements/0*.md > "$SPEC"
grep -c '^- Depends on:' "$SPEC"; grep -c '^### REQ-' "$SPEC"           # equal
grep -oE '^### REQ-[0-9A-Za-z]+' "$SPEC" | sort | uniq -d                # empty
grep -nEi 'retarget|(after|once|when) REQ-[0-9A-Za-z]+ (lands|ships|is (done|merged|implemented))' "$SPEC" || [ $? -eq 1 ]
```

Repo-native checks referenced by the Test Strategy: `node --test --test-concurrency=1 server/redis/*.test.mjs`, `node --test src/data/redisMode.test.mjs src/data/manager.test.mjs`, `npm run build`, `node scripts/redis-load-check.mjs`.

## Status

Specification only. Implementation is handed to `agent-delegation-planning` (see Execution Handoff in `05-shared-sections.md`). Plan status belongs in `specs/redis-improvements/plans/`, not in these files.
