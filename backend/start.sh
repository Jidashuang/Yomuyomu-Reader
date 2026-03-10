#!/bin/sh
set -eu

DATA_DIR="/app/backend/data"
BOOTSTRAP_DIR="/bootstrap-data"

mkdir -p \
  "$DATA_DIR" \
  "$DATA_DIR/cloud" \
  "$DATA_DIR/import_jobs" \
  "$DATA_DIR/backups"

for filename in jmdict.db jlpt_levels.json jlpt_levels.json.example; do
  if [ ! -f "$DATA_DIR/$filename" ] && [ -f "$BOOTSTRAP_DIR/$filename" ]; then
    cp "$BOOTSTRAP_DIR/$filename" "$DATA_DIR/$filename"
  fi
done

exec python3 backend/server.py --host 0.0.0.0 --port "${PORT:-8000}"
