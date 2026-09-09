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

## Build a GCP image

Follows the PS [Image Builder guide](https://redislabs.atlassian.net/wiki/spaces/PS/pages/5790924827/Ps-Portal+Image+Builder+Guide)
and its [GitHub Actions instructions](https://redislabs.atlassian.net/wiki/spaces/PS/pages/6336610353/Ps-Portal+Image+Builder+-+GitHub+Actions).
The required `docker-compose.yml`, `build.sh`, and executable `start.sh` are at
the repository root. Packer builds and saves the Docker image during baking.

1. Push this implementation to GitHub.
2. Set the repository Actions secret `PS_IMAGE_BUILDER_TOKEN` to a valid PS
   token permitted to dispatch `Redis-ProfessionalService/ps-portal-image-builder`.
3. For a private source repo, also set `SOURCE_REPO_READ_TOKEN` to a read-only
   source PAT. The public source repo can use the PS token for the clone too.
4. Run **Build PS Portal image** on the desired branch with a new version such
   as `1.0.0`. The source is pinned to that run's exact commit.
5. Follow the linked infrastructure run through completion. Retrieve the
   `image-manifest` artifact and its `image_version` field.
6. In PS Portal choose **I've my own image**, use that manifest value as
   **Image location**, and use application port **80**. Supply provider variables
   at launch. The expected family for this repo at 1.0.0 is
   `portal-images-gods-eye-view-1-0-0`; use the successful manifest as authority.

The caller dispatch succeeding only means the build was requested. The GCP image
is ready only when the infrastructure run succeeds and publishes its manifest.

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
