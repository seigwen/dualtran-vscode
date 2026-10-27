/**
 * mock endpoint for the VS Code E2E: one OpenAI-compatible route whose
 * behaviour is switched between checks (ok / reject-reasoning / 401).
 */
import http from "node:http";

export async function startMock() {
  const requests = [];
  let mode = "ok";

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ url: req.url, body, headers: req.headers, mode });

      if (req.url === "/requests") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(requests.filter((entry) => entry.url === "/v1/chat/completions")));
        return;
      }
      if (req.url === "/reset") {
        requests.length = 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      if (req.url === "/mode") {
        mode = (body && body.mode) || "ok";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ mode }));
        return;
      }

      if (mode === "401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      if (mode === "reject-reasoning" && body && body.reasoning_effort) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unsupported parameter: reasoning_effort" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "译文" } }] }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    setMode: (next) => (mode = next),
    clear: () => (requests.length = 0),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
