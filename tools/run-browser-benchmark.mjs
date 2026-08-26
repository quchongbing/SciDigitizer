const debuggingPort = process.env.CHROME_DEBUG_PORT ?? "9222";
const appOrigin = process.env.SCIDITIZER_ORIGIN ?? "http://127.0.0.1:8000";
const benchmarkPath = process.env.BENCHMARK_PATH ?? "/tools/browser-benchmark.html";
const outputSelector = process.env.OUTPUT_SELECTOR ?? "#output";
const target = await fetch(
  `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent(`${appOrigin}${benchmarkPath}`)}`,
  { method: "PUT" },
).then((response) => response.json());

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let messageId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  const id = ++messageId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await command("Runtime.enable");
const deadline = Date.now() + 30_000;
let title = "";
while (Date.now() < deadline) {
  const result = await command("Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });
  title = result.result.value;
  if (title === "done") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (title !== "done") throw new Error("Browser benchmark timed out");

const result = await command("Runtime.evaluate", {
  expression: `document.querySelector(${JSON.stringify(outputSelector)}).textContent`,
  returnByValue: true,
});
process.stdout.write(`${result.result.value}\n`);
socket.close();
