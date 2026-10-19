import { Agent } from "../src/index.js";

const [url, goal] = Bun.argv.slice(2);
if (!url || !goal) throw new Error('Usage: bun examples/run.ts https://example.com "Your goal"');
await using agent = await Agent.create(url, goal);
for await (const state of agent.run()) console.log(state.elapsed_ms, state.status, state.page.url);
console.log("Inspect the final page and recorded checkpoints to review completion evidence.");
