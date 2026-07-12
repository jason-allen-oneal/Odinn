import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export async function runInferenceProtocolSmoke() {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      if (!Array.isArray(payload.messages) || typeof payload.model !== "string") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid request" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "odinn-ci-smoke",
        object: "chat.completion",
        model: payload.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ODINN_INFERENCE_PROTOCOL_OK" } }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 }
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not expose a TCP port");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "odinn-ci-fixture", messages: [{ role: "user", content: "ping" }] })
    });
    if (!response.ok) throw new Error(`fixture returned HTTP ${response.status}`);
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (text !== "ODINN_INFERENCE_PROTOCOL_OK") throw new Error(`unexpected inference output: ${String(text)}`);
    return payload;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runInferenceProtocolSmoke();
  console.log(result.choices[0].message.content);
}
