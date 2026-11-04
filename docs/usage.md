Usage notes

Start with examples/inferencegate.json. It needs config version 2 and a version 1 workload. Workload and output paths are relative to the config file.

Use the full /v1/chat/completions URL for each server. Replace the mock deployment metadata with the real runtime, model revision, tokenizer and hardware. Both servers need matching tokenizer identities for performance checks.

For authentication, set apiKeyEnv on an endpoint to the name of an environment variable holding its bearer token.

The config sets the workload, concurrency, request spacing, timeout, warmup and thresholds. Each trial uses the same requests and planned arrival times. A request the client couldn't send on time counts as a missed arrival. Those are reported separately from server failures.

You need at least 100 successful requests on each server in each trial. Throughput needs reported completion-token usage. Outputs also need comparable token counts and finish reasons. Supported streams contain text, finish with stop or length, and end with [DONE].

If you get INCONCLUSIVE, check the report for missed arrivals, missing usage, too few successful requests or inconsistent results between trials.

To check whether the client can keep up with a workload:

node dist/cli.js validate-generator --config examples/calibration.json --plan examples/calibration-plan.json

To find a request rate the baseline can handle, set its real endpoint and metadata in examples/calibration.json, then run:

node dist/cli.js calibrate --config examples/calibration.json --plan examples/calibration-plan.json

Calibration tries the rates in the plan and saves lock.json if one qualifies. Keep it alongside preparation.json. To compare using that rate:

node dist/cli.js compare --config examples/calibration.json --lock /path/to/lock.json

The candidate and output directory can change. The workload, baseline and other settings must still match the lock.

For the optional GPU test, use a dedicated native Linux NVIDIA host with Docker GPU support:

node dist/cli.js validate-vllm --mode controlled --config examples/vllm.json --plan examples/calibration-plan.json --aa-evaluations 3

This downloads the pinned vLLM image and model and runs one server at a time. Allow for the download and repeated server startup. Windows/WSL supports functional mode, which always returns INCONCLUSIVE for release decisions.

Reports use schema v3 and request records use v2. Request failure rates count dispatched requests. Missed arrivals are tracked separately. HTML latency summaries are medians of trial metrics.

On an A10, a configuration change caused 892 of 1,000 candidate requests to time out. Three unchanged-deployment comparisons returned INCONCLUSIVE because first-token latency varied. Use the reports to review a change before relying on the exit code to control releases.
