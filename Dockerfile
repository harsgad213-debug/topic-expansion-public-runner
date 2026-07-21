FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl tar unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY src ./src
COPY README.md ./

RUN chmod +x scripts/run-hf-worker.sh

ENV USE_GITHUB_PHASE1=true \
    PIPELINE_STAGE=a \
    TEST_STAGE=stress \
    TOPIC_SHARD_COUNT=1 \
    TOPIC_SHARD_INDEX=0 \
    TOPIC_LIMIT=100 \
    TOPIC_OFFSET=0 \
    GITHUB_PHASE1_SUMMARY_CONCURRENCY=2 \
    STAGE_A_TOPIC_CONCURRENCY=1 \
    FORCE_GITHUB_PHASE1_REGEN=false \
    DISABLE_GROQ=true \
    DISABLE_GEMINI=true \
    DISABLE_CEREBRAS=true \
    DISABLE_MISTRAL=true \
    DISABLE_CLOUDFLARE=true

CMD ["bash", "scripts/run-hf-worker.sh"]
