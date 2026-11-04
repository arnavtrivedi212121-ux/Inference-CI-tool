Idk it was a cool thing I built this to check whether a vLLM update or config change made a server slower. It sends the same requests to your old and new servers and compares latency, throughput and errors.
You can try it with fake servers first. You'll need Node 24+ and pnpm 11.25.0. From the repo folder, run:

pnpm install --frozen-lockfile

pnpm build

node dist/cli.js demo --all --trials 3 --aa-evaluations 3

The demo prints a path to an HTML report you can open and for your own servers, edit examples/inferencegate.json replace the endpoint URLs, model names and mock deployment details, including the tokenizer. Add your prompts to examples/workloads/smoke.json, then run:

node dist/cli.js compare --config examples/inferencegate.json

Reports go under reports/latest/. You'll get PASS, FAIL, INCONCLUSIVE or ERROR, with the details behind each result and it's been tested on real vLLM, but latency can vary enough that even unchanged servers come back INCONCLUSIVE. Check the report before using it to make a release decision. More setup notes are in docs/usage.md. pnpm check runs the tests and build.
