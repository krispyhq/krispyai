#!/usr/bin/env bash
# Seed the local database with demo data. Thin wrapper over the @krispy/db seed script.
# Usage:  ./scripts/seed.sh
set -euo pipefail

echo "→ Seeding database via @krispy/db"
exec bun --filter @krispy/db seed
