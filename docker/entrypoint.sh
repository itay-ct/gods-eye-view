#!/usr/bin/env bash
set -Eeuo pipefail
# Both portal launchers expose the same VM through exact, predictable aliases.
# Discover those from non-secret GCP metadata on each boot. Local Docker falls
# back to the normal Host check; explicit deployment configuration wins.
if [[ -z "${GEV_PUBLIC_ORIGIN:-}" && -z "${GEV_PUBLIC_ORIGINS:-}" ]]; then
  export GEV_PUBLIC_ORIGINS="$(/opt/gev-node/node /opt/gev/docker/discover-origin.mjs)"
fi
mkdir -p /data/redis /data/redisinsight /data/gev /tmp/nginx
# Keep runtime provider settings and source caches across container recreation.
touch /data/gev/.env
chmod 600 /data/gev/.env
# RedisInsight's file encryption key is unique to each runtime volume, never baked.
if [[ ! -s /data/redisinsight/encryption.key ]]; then
  (umask 077; openssl rand -hex 32 > /data/redisinsight/encryption.key)
fi
export RI_ENCRYPTION_KEY="$(cat /data/redisinsight/encryption.key)"
export RI_ENCRYPTION_KEYTAR=false
for key in GOOGLE_MAPS_API_KEY CESIUM_ION_TOKEN OPENAI_API_KEY OPENSKY_CLIENT_ID OPENSKY_CLIENT_SECRET AISSTREAM_API_KEY TOMTOM_API_KEY FIRMS_MAP_KEY LL2_API_TOKEN; do
  if [[ -z "${!key:-}" ]]; then unset "$key"; fi
done
mkdir -p /data/gev/cache
ln -sfn /data/gev/cache /opt/gev/.gev-cache
pids=()
stop() {
  trap - TERM INT EXIT
  kill -TERM "${pids[@]}" 2>/dev/null || true
  wait || true
}
trap stop TERM INT EXIT
redis-server --bind 127.0.0.1 --protected-mode yes --dir /data/redis \
  --appendonly yes --maxmemory "${REDIS_MAXMEMORY:-2gb}" --maxmemory-policy noeviction \
  --loadmodule /usr/local/lib/redis/modules/rejson.so \
  --loadmodule /usr/local/lib/redis/modules/redisearch.so \
  --loadmodule /usr/local/lib/redis/modules/redisbloom.so &
pids+=("$!")
for attempt in {1..60}; do
  if redis-cli ping >/dev/null 2>&1; then break; fi
  kill -0 "${pids[0]}" 2>/dev/null || exit 1
  sleep 1
done
redis-cli ping >/dev/null
(cd /usr/src/app && node redisinsight/api/dist/src/main) &
pids+=("$!")
(cd /opt/gev && /opt/gev-node/node node_modules/vite/bin/vite.js --strictPort) &
pids+=("$!")
nginx -e /dev/stderr -g 'daemon off;' &
pids+=("$!")
# Any service exit terminates the container, so Docker restarts the entire stack.
set +e
wait -n "${pids[@]}"
exit 1
