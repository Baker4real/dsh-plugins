import { mkdir, writeFile } from "node:fs/promises";

const proxy = process.env.WEB_ACCESS_PROXY ?? "http://localhost:3456";
const targetUrl = process.argv[2] ?? "http://127.0.0.1:10366/";
const timeoutMs = 20_000;
const resultPath = "D:/agents/run-evidence/dsh-compaction-256k/ui-smoke-result.json";

async function request(path, options = {}) {
  const response = await fetch(`${proxy}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`web-access ${path}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text.length === 0 ? null : JSON.parse(text);
}

const expression = `(() => {
  const element = document.querySelector('[data-compaction-remaining]');
  const page = {
    title: document.title,
    readyState: document.readyState,
    bodyText: element === null ? (document.body?.innerText.slice(0, 500) ?? '') : undefined,
  };
  if (element === null) return { ...page, meter: null };
  const clone = element.cloneNode(true);
  clone.querySelectorAll('style').forEach((style) => style.remove());
  return {
    ...page,
    meter: {
      text: clone.textContent?.trim() ?? '',
      remaining: element.getAttribute('data-compaction-remaining'),
      threshold: element.getAttribute('data-compaction-threshold'),
      title: element.getAttribute('title') ?? '',
    },
  };
})()`;

function validateMeter(meter) {
  if (meter === null) return false;
  const remaining = Number(meter.remaining);
  const threshold = Number(meter.threshold);
  return Number.isInteger(remaining) && remaining >= 0 && remaining <= 100
    && Number.isInteger(threshold) && threshold > 0
    && meter.text.includes(`${remaining}%`)
    && meter.title.length > 0;
}

let targetId;
let openedByUs = false;
let result;
try {
  const health = await request("/health");
  if (health.connected !== true) throw new Error("web-access proxy has no connected browser");
  const targets = await request("/targets");
  const origin = new URL(targetUrl).origin;
  const existing = targets.find((target) => {
    try { return new URL(target.url).origin === origin; } catch { return false; }
  });
  if (existing !== undefined) {
    targetId = existing.targetId;
  } else {
    const opened = await request("/new", { method: "POST", body: targetUrl });
    targetId = opened.targetId;
    openedByUs = true;
  }
  const deadline = Date.now() + timeoutMs;
  let observation;
  do {
    const evaluated = await request(`/eval?target=${encodeURIComponent(targetId)}`, {
      method: "POST",
      body: expression,
    });
    if (evaluated.error !== undefined) throw new Error(`UI eval failed: ${evaluated.error}`);
    observation = evaluated.value;
    if (validateMeter(observation?.meter)) break;
    if (observation?.bodyText?.includes("dsh web authentication required")) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);

  result = {
    status: validateMeter(observation?.meter) ? "pass" : "fail",
    scope: "client-dom",
    targetUrl,
    reusedExistingPage: !openedByUs,
    page: {
      title: observation?.title,
      readyState: observation?.readyState,
      bodyText: observation?.bodyText,
    },
    meter: observation?.meter ?? null,
  };
} catch (error) {
  result = {
    status: "fail",
    scope: "client-dom",
    targetUrl,
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  if (targetId !== undefined && openedByUs) {
    try {
      await request(`/close?target=${encodeURIComponent(targetId)}`);
    } catch (error) {
      result = {
        ...result,
        status: "fail",
        cleanupError: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

await mkdir("D:/agents/run-evidence/dsh-compaction-256k", { recursive: true });
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (result.status !== "pass") process.exitCode = 1;
