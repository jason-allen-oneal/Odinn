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
const maxP95Ms = Number(process.env.ODINN_BENCHMARK_P95_MAX_MS || 1500);
if (report.p95Ms > maxP95Ms) {
  throw new Error(`OpenAI-compatible protocol smoke p95 exceeded ${maxP95Ms} ms: ${report.p95Ms} ms`);
}
