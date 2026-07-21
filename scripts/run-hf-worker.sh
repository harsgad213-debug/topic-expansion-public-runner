#!/usr/bin/env bash
set -euo pipefail

WORK_ROOT="${WORK_ROOT:-/data}"
INPUT_DIR="${INPUT_DIR:-$WORK_ROOT/input}"
OUTPUT_ROOT="${OUTPUT_ROOT:-$WORK_ROOT/output}"
mkdir -p "$INPUT_DIR" "$OUTPUT_ROOT"

if [ -z "${GITHUB_KEYS:-}" ]; then
  echo "[hf-worker] Missing GITHUB_KEYS secret."
  exit 2
fi

KEY_COUNT="$(node -e 'const raw=process.env.GITHUB_KEYS||""; console.log(raw.split(/[\n,;]+/).map(s=>s.trim()).filter(Boolean).length)')"
echo "[hf-worker] Starting topic expansion worker"
echo "[hf-worker] Keys loaded: ${KEY_COUNT}"
echo "[hf-worker] Shard: ${TOPIC_SHARD_INDEX:-0}/${TOPIC_SHARD_COUNT:-1}"
echo "[hf-worker] Topic limit: ${TOPIC_LIMIT:-none}"
echo "[hf-worker] Summary concurrency: ${GITHUB_PHASE1_SUMMARY_CONCURRENCY:-2}"
echo "[hf-worker] Topic concurrency: ${STAGE_A_TOPIC_CONCURRENCY:-1}"

if [ -n "${ORGANIZED_DIR:-}" ] && [ -d "$ORGANIZED_DIR" ]; then
  echo "[hf-worker] Using existing ORGANIZED_DIR=$ORGANIZED_DIR"
else
  ZIP_PATH=""
  if [ -n "${TOPIC_DATA_ZIP_URL:-}" ]; then
    ZIP_PATH="$INPUT_DIR/topic_data.zip"
    echo "[hf-worker] Downloading topic data ZIP from TOPIC_DATA_ZIP_URL"
    curl -L --fail --retry 5 --retry-delay 5 "$TOPIC_DATA_ZIP_URL" -o "$ZIP_PATH"
  elif [ -n "${TOPIC_DATA_ZIP_PATH:-}" ] && [ -f "$TOPIC_DATA_ZIP_PATH" ]; then
    ZIP_PATH="$TOPIC_DATA_ZIP_PATH"
    echo "[hf-worker] Using TOPIC_DATA_ZIP_PATH=$TOPIC_DATA_ZIP_PATH"
  elif [ -f "topic_data_balanced_100.zip" ]; then
    ZIP_PATH="topic_data_balanced_100.zip"
    echo "[hf-worker] Using bundled topic_data_balanced_100.zip"
  elif [ -f "pilot_topic_data.zip" ]; then
    ZIP_PATH="pilot_topic_data.zip"
    echo "[hf-worker] Using bundled pilot_topic_data.zip"
  else
    echo "[hf-worker] No topic data found. Set TOPIC_DATA_ZIP_URL, TOPIC_DATA_ZIP_PATH, or ORGANIZED_DIR."
    exit 3
  fi

  rm -rf "$INPUT_DIR/FreshArchive"
  unzip -q "$ZIP_PATH" -d "$INPUT_DIR"
  export ORGANIZED_DIR="$INPUT_DIR/FreshArchive/organized"
fi

if [ ! -d "$ORGANIZED_DIR" ]; then
  echo "[hf-worker] ORGANIZED_DIR does not exist: $ORGANIZED_DIR"
  exit 4
fi

export OUT_DIR="${OUT_DIR:-$OUTPUT_ROOT/knowledge_output}"
mkdir -p "$OUT_DIR"

LOG_FILE="$OUTPUT_ROOT/hf-worker-shard-${TOPIC_SHARD_INDEX:-0}.log"
echo "[hf-worker] ORGANIZED_DIR=$ORGANIZED_DIR"
echo "[hf-worker] OUT_DIR=$OUT_DIR"
echo "[hf-worker] Log file=$LOG_FILE"

set +e
node scripts/run-topic-expansion.js 2>&1 | tee "$LOG_FILE"
STATUS="${PIPESTATUS[0]}"
set -e

FULL_COUNT="$(find "$ORGANIZED_DIR" -path "*/response_parts/*_FULL.txt" -type f 2>/dev/null | wc -l | tr -d " ")"
DLQ_COUNT="$(find "$ORGANIZED_DIR" -path "*/response_parts/stage-a-dlq.json" -type f 2>/dev/null | wc -l | tr -d " ")"
echo "[hf-worker] Full output files: $FULL_COUNT"
echo "[hf-worker] Stage A DLQ files: $DLQ_COUNT"
echo "[hf-worker] Exit status: $STATUS"

if [ "${PACK_OUTPUT_TAR:-false}" = "true" ]; then
  TAR_PATH="$OUTPUT_ROOT/topic-expansion-shard-${TOPIC_SHARD_INDEX:-0}.tgz"
  echo "[hf-worker] Packing response_parts into $TAR_PATH"
  tar -czf "$TAR_PATH" -C "$INPUT_DIR" FreshArchive || true
fi

exit "$STATUS"
