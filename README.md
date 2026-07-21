# Topic Expansion Public Runner

This repository is a sanitized public compute runner for topic expansion.

It intentionally contains:

- runner code,
- workflow configuration,
- no provider keys,
- no transcript archive,
- no generated outputs,
- no private git history.

## Required Secrets

Add these in GitHub:

```text
GH_MODELS_KEYS
TOPIC_DATA_ZIP_URL
OUTPUT_REPO
OUTPUT_REPO_TOKEN
```

`GH_MODELS_KEYS` can be used for a small pilot. For larger runs, prefer sharded secrets:

```text
GH_MODELS_KEYS_00
GH_MODELS_KEYS_01
...
GH_MODELS_KEYS_15
```

The workflow chooses a key shard by `TOPIC_SHARD_INDEX % 16`, falling back to `GH_MODELS_KEYS` if a shard secret is missing.

`TOPIC_DATA_ZIP_URL` must point to a ZIP with:

```text
FreshArchive/
  organized/
    ...
```

`OUTPUT_REPO` should be a private repository such as:

```text
owner/private-output-repo
```

`OUTPUT_REPO_TOKEN` needs permission to create releases/upload assets in that private output repository.

## Safety Rules

- Do not enable `pull_request` triggers.
- Do not print environment variables.
- Do not upload outputs as public Actions artifacts.
- Do not commit data ZIPs.
- Do not commit generated outputs.

## Recommended Pilot

```text
shard_count=4
max_parallel=4
topic_limit=100
summary_concurrency=2
stage_a_topic_concurrency=1
```

If clean, move to:

```text
shard_count=8
max_parallel=8
```

Then:

```text
shard_count=16
max_parallel=16
```
