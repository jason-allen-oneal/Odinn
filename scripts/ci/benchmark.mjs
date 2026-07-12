import { performance } from "node:perf_hooks";
import { runInferenceProtocolSmoke } from "./inference-smoke.mjs";

const samples = [];
for (let index = 0; index < 20; index += 1) {
  const started = performance.now();
  await runInferenceProtocolSmoke();
  samples.push(performance.now() - started);
}

samples.sort((left, right) => left - right);
const percentile = (value) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)];
const report = {
  samples: samples.length,
  p50Ms: Number(percentile(0.5).toFixed(2)),
  p95Ms: Number(percentile(0.95).toFixed(2)),
  maxMs: Number(samples.at(-1).toFixed(2))
};

console.log(JSON.stringify(report, null, 2));
if (report.p95Ms > 500) {
  throw new Error(`OpenAI-compatible protocol smoke p95 exceeded 500 ms: ${report.p95Ms} ms`);
}
