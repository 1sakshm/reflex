/**
 * Reflex quickstart: no API key, no model download.
 *
 * A toy research agent decides, for each sub-question, whether to answer from
 * cache, search the web, query internal docs (RAG), or think with the frontier
 * model. A fake "frontier model" (always right, 1.2 s and $0.02 per call) makes
 * the decisions Reflex isn't sure about, and Reflex learns from it.
 *
 *   npm run quickstart            # shadow mode: Reflex only watches
 *   npx reflex stats              # what it would have done
 *   npx reflex train --promote    # turn traces into a policy
 *   npm run quickstart -- --auto  # Reflex now takes the routine calls itself
 */
import { action, createReflex, type ActionSpec } from "@reflex-ai/core";

const auto = process.argv.includes("--auto");
const reflex = createReflex({
  workload: "quickstart/research-agent",
  mode: auto ? "auto" : "shadow",
  dataDir: ".reflex",
});

const actions: ActionSpec[] = [
  action.cache("use_cache", { description: "The answer is already cached" }),
  action.search("web_search", { description: "Needs fresh information from the web" }),
  action.retrieval("internal_docs", { description: "Answer from internal documentation" }),
  action.frontier({ description: "Needs multi-step reasoning or synthesis" }),
];

const QUESTIONS: [string, string][] = [
  ["What is our refund policy for annual plans?", "internal_docs"],
  ["What is the latest stable Node.js release?", "web_search"],
  ["What did we decide about pricing in yesterday's answer?", "use_cache"],
  ["Compare the trade-offs of our three caching strategies and recommend one", "frontier"],
  ["How do I configure SSO in our admin panel?", "internal_docs"],
  ["What are today's exchange rates for EUR to INR?", "web_search"],
  ["Repeat the summary you gave earlier", "use_cache"],
  ["Design a migration plan from Postgres 14 to 17 with zero downtime", "frontier"],
];

async function fakeFrontier(correct: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 20)); // stands in for ~1.2 s
  return correct;
}

let frontierCalls = 0;
let autoCalls = 0;
for (let task = 0; task < 120; task++) {
  const [question, correct] = QUESTIONS[task % QUESTIONS.length] as [string, string];
  const variant = `${question} (ticket #${1000 + task})`;
  const decision = await reflex.decide({
    point: "route_subquestion",
    taskId: `task-${task}`,
    state: { goal: "answer the user's research question", lastObservation: { type: "subquestion", text: variant } },
    actions,
  });
  let chosen: string;
  if (decision.type === "auto") {
    autoCalls++;
    chosen = decision.action.id; // System 1: execute immediately
  } else {
    frontierCalls++;
    chosen = await fakeFrontier(correct); // System 2
    reflex.observeChoice(decision.id, chosen); // ← the learning signal
  }
  reflex.taskOutcome({ taskId: `task-${task}`, success: chosen === correct });
}

await reflex.close();
const stats = reflex.stats();
console.log(`mode: ${auto ? "auto" : "shadow"} · policy ${reflex.policyVersion}`);
console.log(`decisions: ${stats.decisions} · handled by Reflex: ${autoCalls} · frontier calls: ${frontierCalls}`);
console.log(`Reflex latency p50 ${stats.latencyMs.p50.toFixed(3)} ms · p95 ${stats.latencyMs.p95.toFixed(3)} ms`);
console.log(`task success: ${(stats.tasks.successRate * 100).toFixed(1)}%`);
if (!auto) {
  console.log(`shadow agreement: ${stats.shadow.agreed}/${stats.shadow.labeled} · would auto-decide ${stats.shadow.wouldAuto} (${stats.shadow.wouldAutoAgreed} correct)`);
  console.log("\nNext: npx reflex stats  →  npx reflex train --promote  →  npm run quickstart -- --auto");
}
