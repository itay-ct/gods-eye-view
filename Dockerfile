# syntax=docker/dockerfile:1
FROM redis:8.10.0-alpine AS redis
FROM node:24.14.0-alpine AS gev
WORKDIR /opt/gev
COPY package.json package-lock.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --no-audit --no-fund
COPY . .

FROM redis/redisinsight:3.4.2
USER root
RUN apk add --no-cache bash nginx tini libstdc++ libgcc openssl curl
COPY --from=redis /usr/local/bin/redis-server /usr/local/bin/redis-cli /usr/local/bin/
COPY --from=redis /usr/local/lib/redis /usr/local/lib/redis
COPY --from=gev /usr/local/bin/node /opt/gev-node/node
COPY --from=gev --chown=node:node /opt/gev /opt/gev
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh docker/healthcheck.sh /opt/bin/
ENV RI_APP_HOST=127.0.0.1 RI_APP_PORT=5540 RI_PROXY_PATH=redisinsight \
    RI_REDIS_HOST=127.0.0.1 RI_REDIS_PORT=6379 RI_REDIS_ALIAS="GEV Redis" \
    RI_APP_FOLDER_ABSOLUTE_PATH=/data/redisinsight \
    HOST=127.0.0.1 PORT=4173 GEV_ENV_DIR=/data/gev GEV_TRUST_SETUP_PROXY=true REDIS_URL=redis://127.0.0.1:6379 \
    VITE_REDISINSIGHT_URL=/redisinsight/0/browser/
RUN chmod +x /opt/bin/*.sh && mkdir -p /data/redis /data/redisinsight /data/gev /tmp/nginx \
    && chown -R node:node /data /tmp/nginx
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=15s --start-period=120s --retries=3 CMD /opt/bin/healthcheck.sh
ENTRYPOINT ["/sbin/tini", "--", "/opt/bin/entrypoint.sh"]
