import { readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectManifest } from "./dsh-inspect.mjs";
import { runCheckProcess } from "./run-check-process.mjs";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

export async function checkLocalBundle({ projectRoot, resourcesPath, expectedHostVersion }) {
  const project = await readJson(join(projectRoot, "package.json"));
  if (typeof project.scripts?.check !== "string" || !project.scripts.check.trim()) {
    throw new Error("local bundle check: package.json must declare scripts.check");
  }
  const peers = Object.entries(project.devDependencies ?? {}).filter(([name]) => name.startsWith("@deepseek-ai/") || name === "zod");
  if (!peers.length) throw new Error("local bundle check: no pinned host test dependencies");
  const runtime = await inspectManifest(resourcesPath, peers.map(([name]) => name));
  if (expectedHostVersion !== undefined && runtime.dshVersion !== expectedHostVersion) {
    throw new Error(`running/installed host version mismatch: running=${expectedHostVersion} installed=${runtime.dshVersion}`);
  }
  const versions = {};
  for (const [name, pin] of peers) {
    const installed = await readJson(join(projectRoot, "node_modules", name, "package.json"));
    const hostVersion = runtime.packages[name].version;
    if (pin !== installed.version || installed.version !== hostVersion) {
      throw new Error(`host/test version mismatch: ${name} pin=${pin} test=${installed.version} host=${hostVersion}`);
    }
    versions[name] = hostVersion;
  }
  const dependencies = join(resourcesPath, "runtime/primary-runtime/dependencies");
  const nodePath = join(dependencies, "node/bin", process.platform === "win32" ? "node.exe" : "node");
  const pnpmPath = join(dependencies, "pnpm/bin/pnpm.cjs");
  const { stdout: versionText } = await runCheckProcess(nodePath, ["--version"], { timeout: 10_000 });
  const nodeVersion = versionText.trim();
  if (!/^v(?:2[4-9]|[3-9]\d)\./.test(nodeVersion)) throw new Error(`bundled Node 24+ required, got ${nodeVersion}`);
  // pnpm's check script must also resolve bare `node` to this bundled runtime.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = `${dirname(nodePath)}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await runCheckProcess(nodePath, [pnpmPath, "run", "check"], {
      cwd: projectRoot, env, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (error.code === "ERR_CHECK_CLEANUP") throw error;
    throw new Error(`pnpm run check failed (exit ${error.code ?? "unknown"}): ${String(error.message).slice(0, 500)} ${String(error.stdout || error.stderr || "").slice(-3500)}`);
  }
  return {
    status: "passed", checkedAt: new Date().toISOString(), projectRoot,
    projectVersion: project.version, hostVersion: runtime.dshVersion, nodeVersion,
    command: "pnpm run check", testDependencyVersions: versions,
  };
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      resources: { type: "string" }, "project-root": { type: "string" },
      "expected-host-version": { type: "string" }, help: { type: "boolean" },
    } });
    if (values.help) {
      console.log("check-local-bundle.mjs --resources <desktop resources> [--project-root <local project>] [--expected-host-version <running version>]\nRuns the pinned host dependency check and bundled Node/pnpm check; no profile changes. Use Electron with ELECTRON_RUN_AS_NODE=1 for app.asar.");
    } else {
      if (!values.resources) throw new Error("--resources is required");
      const report = await checkLocalBundle({
        resourcesPath: resolve(values.resources),
        projectRoot: values["project-root"] ? resolve(values["project-root"]) : fileURLToPath(new URL("..", import.meta.url)),
        expectedHostVersion: values["expected-host-version"],
      });
      console.log(JSON.stringify(report, null, 2));
    }
  } catch (error) {
    console.error(String(error.message).slice(-5000));
    process.exitCode = 1;
  }
}
