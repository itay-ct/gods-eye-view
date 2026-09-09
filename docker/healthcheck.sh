#!/bin/sh
set -eu
redis-cli ping | grep -q PONG
curl --fail --silent --max-time 5 http://127.0.0.1:8080/ >/dev/null
curl --fail --silent --max-time 5 http://127.0.0.1:8080/redisinsight/api/health/ >/dev/null
