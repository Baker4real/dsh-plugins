# 验证与测试

## Validation

```bash
pnpm run check
```

`check` rebuilds `lib/client.js` from the TypeScript sources (`scripts/build.mjs`, which also runs `node --check` on the bundle), runs `tsc --noEmit` on `src/client`, runs `node --check` on `lib/index.js`, and finally runs the bundle-freshness gate (`scripts/verify-fresh.mjs`, which fails only when the sources are unchanged vs HEAD but the rebuilt bundle differs — i.e. a stale committed bundle). Individual steps: `pnpm run build`, `pnpm run verify:build`, `pnpm run typecheck`.

诊断层使用 `node scripts/verify-build.mjs [ref] [--css-selector SELECTOR] [--max-chars N]`：selector 只缩小诊断输出，完整 token/line 比较仍决定成败。行为检查的范围与跳过条件见 [Build / test / lint](#build--test--lint)；真实浏览器、原生标题栏与旧 API 验收见 [Smoke run](#smoke-run)。门禁以 [package.json](../../package.json) 和 [CI](../../.github/workflows/check.yml) 为准。

The golden comparison in `verify:build` defaults to the pinned commit `c1afd17949de7f2136acdd4dea5e876a8544cddf` from upstream tag `v1.3.4` (the last hand-written bundle). The verifier accepts the historical root layout and the current `dsh-subagent-ui/` prefix without requiring imported release tags. It is the one-time migration proof that the TypeScript rewrite did not alter behavior, and afterwards a delta viewer: any intentional behavior change shows up as the exact token/line differences (the first post-migration example is the `scopeKey` → `workspaceKey` latent-bug fix). Pass another ref as `node scripts/verify-build.mjs <ref>` if needed.

## Smoke run

```bash
./test.sh [PORT]                        # local dsh, port ${PORT:-8084}
DSH_VERSION=0.1.6-alpha.2 ./test.sh     # pnpx @deepseek-ai/dsh@<version> (via proxychains4 -q)
DSH_VERSION=0.1.1-rc.2 ./test.sh        # legacy-API compatibility
DSH_SMOKE_HOME=/path ./test.sh          # override the isolated smoke HOME
DSH_PLUGIN_DIR=.worktrees/x ./test.sh   # smoke another checkout's bundle (default: repo root via file:.)
node test/browser-smoke.mjs             # managed DSH + real Chromium; isolated home and verified owned-tree cleanup
pnpm run test:native-titlebar           # real Electron WM_NCHITTEST regression; interactive Windows only
```

真实浏览器与原生标题栏的环境、隔离及进程清理要求见 [现行冒烟说明](../../README.md#smoke-test-any-dsh-version)。

The script uses an isolated `DSH_HOME` (default `$HOME/tmp/dsh-test`, override with `DSH_SMOKE_HOME`) and aborts if that would be the real `~/.dsh`, removes and re-adds the local plugin to the Web profile, then starts `dsh web --no-open --port ${PORT:-8084}`. With `DSH_VERSION` set it runs through `pnpx @deepseek-ai/dsh@<version>` and passes one `--allow-build=<pkg>` per native dsh dependency (pnpm 12 ignores lifecycle scripts by default; `DSH_ALLOW_BUILDS=…` overrides the comma-separated list, `DSH_PROXY=""` bypasses proxychains). A `DSH_VERSION` run needs network access to the npm registry. It is an environment-dependent smoke setup, not a unit-test runner.

## Build / test / lint

There is no `lint` script or lint configuration. [Validation](#validation) owns the build/type/syntax/freshness checks; `pnpm run check` deliberately does **not** run the tests, which are slower and environment-dependent. The deterministic sucrase linker is described in [Code style and conventions](code-style.md#code-style-and-conventions).

`pnpm run test` runs the harnesses in `test/`, in order — `render`, `session-entity`, `purge`, `purge-panel`, `auth` (all plain Node ESM scripts using only built-ins; no test framework is installed, and the host-dependent ones print one `SKIP` line and exit 0 on a machine without a dsh install):

- `test/render.test.mjs` — loads the built `lib/client.js` into a minimal fake DOM/React runtime and renders the **real** manager component from several session shapes. It asserts, among others, that the external-agent row is visible and typed (`外部代理`), that an unmeasured external run reads `状态不可得` and never `已结束`, that only a *measured* ledger edge produces `运行中 · <engine>` / `已结束（…）` and a `⏹ 停止` button, that a provider the plugin does not know is shown verbatim, that a session-less external run (catalog only, no `Session` in `byId`) still yields a row and an `active/total` header count, and that a row present in `byId` is not duplicated by its catalog entry. No skip path: it always runs.
- `test/auth.test.mjs` — mounts the plugin's host entry against the **host's own** `HostConnectionService` (real cordis `Context`, real `admit`, real signed-cookie code) over real HTTP, in five scenarios: the fetch face (`connection.fetch` through the host's `/api` channel), the `webServer` fallback gated by `connection.admit`, the fallback with `webServer` arriving after `apply`, the measured 0.2.1 ordering where `connection` arrives ~1.26 s after activation, and a host whose connection service has **no `admit`** (which must register nothing at all — fail closed). Each scenario refuses every credential-less request with 401 and keeps the pre-migration bodies for an admitted caller. The negative controls are the point of the file: the credential-less request that used to answer 200 must not, and **five forged-cookie variants** that the removed `'shape'` rung admitted (`v1.AAAA.BBBB`, `v1.YWJjZGVm.Z2hpamtsbW5vcA`, a 3-part `v2`, a 2-part value, an empty signature) must all be 401 — removing the gate turns them 200 again. Wrong verbs keep 405 on the legacy surface and 404 on the fetch route.

`test/auth.test.mjs` needs the host's packages on disk: `@deepseek-ai/cordis` (a peer here, so usually present in `node_modules`) and `@deepseek-ai/dsh-client-connection` (only inside a dsh installation). It resolves them in this order — `DSH_HOST_PKGS` override, the repository's own `node_modules`, the install named by the `dsh` launcher on `PATH` (via its realpath), then common global roots (the running node's prefix, `NPM_CONFIG_PREFIX`, fnm/nvm/volta, `HOME`) — and accepts a candidate only when **both** packages resolve through it, so the cordis the plugin runs on and the host service are the same copy. If none does, it prints one `SKIP auth.test.mjs: …` line naming the roots it tried and exits **0** (a machine without a dsh install has nothing to test); set `DSH_HOST_PKGS` to the host's `@deepseek-ai` directory to force a run. When a host is found it always runs for real — never silently skips.

- `test/session-entity.test.mjs` — the host half of the deleted-row fix, with the host's own `dsh-session-persistence-jsonl` as the oracle (`findLog` present iff the plugin says `present`): the reported state (directory removed ⇒ `absent`), the no-false-kill arms (missing root, unreadable root, a project directory that cannot be listed ⇒ `root: 'partial'` and `unavailable`, junk/oversized requests, the id encoder), the authenticated route, and a control where the percent encoder makes a live child look deleted.
- `test/real-data.test.mjs` — opt-in (`DSH_REAL_HOME=~/.dsh`): copies the real `~/.dsh` READ-ONLY into `tmp/`, replays the operator's parent session through the real route and the real built bundle, and asserts the panel renders exactly the children whose directories survive.

The harnesses guard stdout so a closed reader (`… | head`) is not reported as a failure, and exit explicitly because the plugin leaves live timers behind.
