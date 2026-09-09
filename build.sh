#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# Packer bakes the built image; provider credentials are runtime-only.
docker compose build
