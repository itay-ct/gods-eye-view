# GEV + Redis + RedisInsight on PS Portal

One Docker container runs GEV (Node 24.14.0), Redis 8.10.0 with JSON, Search,
and Bloom/CMS, RedisInsight 3.4.2, and nginx. Only HTTP port 8080 is published;
Redis and RedisInsight listen on loopback inside the container. Compose maps
host port 80 to it. RedisInsight is available at `/redisinsight/`; the small
external-link icon beside the Redis toggle opens its **GEV Redis** database
browser in a new tab. The link works with both Redis toggle states.

The container uses GEV's Vite server because the existing source proxy and Redis
pipeline APIs are development-server plugins. This is a PS demo deployment.
Use the portal's authenticated access for the combined UI, including RedisInsight.

The personal-lab image enables `GEV_TRUST_SETUP_PROXY=true` to retain the
**POWER UP** key-entry panel behind nginx, with no additional password screen.
Everyone with access to the lab can edit its provider keys. nginx overwrites
the internal setup marker; Vite listens only on container loopback. Setup
writes still require an exact Origin match (including HTTPS and port), JSON,
and the existing credential validation. Ordinary non-container launches retain
the local-only policy. Set `GEV_TRUST_SETUP_PROXY=false` in the container
environment to disable setup through the proxy for a shared demo.

## Local build and launch

```sh
./build.sh
GEV_BIND_ADDRESS=127.0.0.1 GEV_HTTP_PORT=18080 ./start.sh
```

Open <http://localhost:18080>. RedisInsight may ask you to accept its terms on
first use; the local Redis connection is already registered as **GEV Redis**.
GEV defaults to **No Redis**; turn Redis on to populate it from enabled layers.

`start.sh` can run repeatedly and does not rebuild or download images on boot.
`gev-data` persists Redis AOF, RedisInsight settings, and GEV provider settings
and caches. `docker compose down` preserves this volume; `down -v` deletes it.
Set `REDIS_MAXMEMORY` to adjust Redis's default 2 GB dataset budget. Allow at
least 4 GB RAM for the container and additional headroom for the VM.

Provider credentials are optional for startup. Supply them at runtime through
the environment / portal Custom Variables, or use GEV Provider Settings where
available. Supported environment names are listed in `docker-compose.yml`.
Local `.env` values are picked up by Compose, but **never copied into the image**.
Build context uses an allowlist that excludes local keys, Git metadata, logs,
caches, and the Terraform credentials file. No PS token belongs in `.env`.

## Build a GCP image with Backstage

Follow the [PS Backstage image-builder guide](https://redislabs.atlassian.net/wiki/spaces/PS/pages/6337560612/Ps-Portal+Image+Builder+-+Backstage).
The required Compose file and executable `start.sh`, plus `build.sh`, are at the
repository root. Packer builds and saves the Docker image during baking.

1. Open <https://backstage.ps-redis.com/> and sign in with Okta.
2. Select **Create → Build PS Portal Image**.
3. Use source repository `https://github.com/itay-ct/gods-eye-view`, the tested
   commit SHA from `codex/ps-portal-all-in-one`, and a new version such as
   `1.0.1`. Leave **Source Directory** empty.
4. Supply a valid GitHub **Repository Access Token** with source read access.
   Backstage requires this even for the public repository. Do not put it in
   application files or provider settings.
5. Keep the PS project, region, zone, and disk defaults from the live form.
6. Review and create. Wait for the build to succeed and retrieve **Image Family**
   from the catalog entry. The expected 1.0.1 family is
   `portal-images-gods-eye-view-1-0-1`; the successful build result is authoritative.
7. To deploy, use **Create → Launch PS Portal Image**, select that family, and
   application port **80**. Configure provider keys at runtime with POWER UP.

No direct GCP credentials or PS builder-dispatch token are needed through
Backstage. The repository's GitHub Actions trigger remains an optional legacy
route; it is not used by these steps. A submitted build is not a ready image:
wait for the infrastructure run to succeed and publish its result.

### Portal rewrites the Host header

The corrected 1.0.1 image discovers its VM name and `DOMAIN` from non-secret
GCP metadata at startup. It accepts only that VM's two portal HTTPS origins:
`https://<instance>.labs.ps-redis.com` and
`https://80-p-<instance>.labs.ps-redis.com`. This applies to Redis ingestion and
POWER UP. Fresh launches need no custom variables or startup scripts.

For a different deployment, set `GEV_PUBLIC_ORIGIN` to its exact public origin
(no path or fragment), or `GEV_PUBLIC_ORIGINS` to a comma-separated list of exact
origins. Explicit configuration takes precedence over discovery. Local Docker
without GCP metadata retains normal Host-based checks. These settings are not
provider keys and do not go in POWER UP.

The first 1.0.1 build (`gods-eye-view-20260910042831`) required explicit origin
configuration; use the latest successful image in the 1.0.1 family for discovery.
Version 1.0.0 does not support these settings.

The origin check still rejects other websites. Redis-off requests bypass the
ingestion endpoint, so direct layers can work while Redis-on layers are rejected.
Changing a local checkout or baking a new image does not update an existing VM.

The legacy portal's lab network currently has no `ps-infra-prod-labs` subnet in
`europe-west1`. Building an image in Belgium succeeds, but launching there fails
unless the platform team supplies a compatible regional subnet. The supported
default launch region is `us-east1`.

## Verification and logs

```sh
docker compose ps
docker compose logs --tail 100
docker compose exec gev /opt/bin/healthcheck.sh
docker compose exec gev redis-cli MODULE LIST
```

The health check covers Redis PING, GEV HTTP, and RedisInsight HTTP. The container
runs as a non-root user. If any service exits, the supervisor stops the remaining
services and Compose restarts the container. Redis receives SIGTERM and saves
its AOF on shutdown. Provider credentials are not necessary for health checks.
