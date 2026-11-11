import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckProcess } from "./run-check-process.mjs";

try {
  const [action, ...args] = process.argv.slice(2);
  if (action === "--help") {
    console.log("dsh-desktop.mjs <check|manifest|search> --resources <desktop resources> [options]\ncheck: run the project's full pre-activation check\nmanifest/search: see dsh-inspect.mjs --help\nCaptures and waits for a hidden Electron Node child; never opens the desktop UI.");
  } else {
    if (!["check", "manifest", "search"].includes(action)) throw new Error("choose check, manifest or search; see --help");
    const index = args.indexOf("--resources");
    if (index < 0 || !args[index + 1]) throw new Error("--resources is required");
    const resources = resolve(args[index + 1]);
    const script = join(dirname(fileURLToPath(import.meta.url)), action === "check" ? "check-local-bundle.mjs" : "dsh-inspect.mjs");
    const result = await runCheckProcess(join(dirname(resources), "DeepSeek Harness.exe"), [
      "--expose-internals", script, ...action === "check" ? [] : [action], ...args,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: action === "check" ? 180_000 : 15_000, maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
} catch (error) {
  process.stderr.write(`dsh-desktop: ${error.message}\n${String(error.stderr ?? "").slice(-5000)}`);
  process.exitCode = 1;
}
