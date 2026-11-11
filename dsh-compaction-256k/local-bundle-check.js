import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckProcess } from "./scripts/run-check-process.mjs";

export const localProjectRoot = fileURLToPath(new URL(".", import.meta.url));
export const localBundleNames = new Set([
  "@local/dsh-compaction-256k",
  "@local/dsh-compaction-context-meter",
  "@local/daily-update-guards",
]);

/** Run the same check used by the CLI, in the installed Electron's read-only ASAR environment. */
export async function runLocalBundleCheck({ signal, runtimeVersion, resourcesPath = process.resourcesPath } = {}) {
  if (typeof resourcesPath !== "string" || !resourcesPath) {
    throw new Error("local bundle check: desktop resourcesPath is unavailable; use the documented Electron check entry");
  }
  let stdout;
  try {
    ({ stdout } = await runCheckProcess(join(dirname(resourcesPath), "DeepSeek Harness.exe"), [
      "--expose-internals", join(localProjectRoot, "scripts/check-local-bundle.mjs"),
      "--resources", resourcesPath,
      ...runtimeVersion ? ["--expected-host-version", runtimeVersion] : [],
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 180_000, maxBuffer: 1024 * 1024, signal,
    }));
  } catch (error) {
    if (error.code === "ERR_CHECK_CLEANUP") throw error;
    throw new Error(`local bundle check failed: ${String(error.message).slice(0, 500)} ${String(error.stderr || error.stdout || "").slice(-3500)}`, { cause: error });
  }
  const report = JSON.parse(stdout);
  if (report.status !== "passed") throw new Error("local bundle check: missing passed result");
  return report;
}
