# 发布与提交工作流

## Workflow cadence (core memo)

日常源码修改、检查与当前 Desktop 生效流程见 [AGENTS.md](../../AGENTS.md)；独立 Web profile 见 [Install / use in DSH Web](../maintenance-reference.md#install--use-in-dsh-web)。发布流程只在 [Release discipline](#release-discipline-default-after-every-release) 维护。

**获准提交时**：源码与重新生成的 bundle 一起提交；沿用 `feat:` / `fix:` / `refactor:` / `docs:` / `chore:` 前缀。

**Board**: this workspace uses dsh-graph (`.dsh-graph/`, gitignored) for goal tracking; run `graph_*` tools only from the repository root so they resolve the correct graph root. `.dsh-plugin-smoke/` and `.dsh-graph/` are local/runtime data, not application source.

## Publish

The project owner publishes releases manually:

```bash
npm publish --access public
```

Confirm the package version in `package.json` and complete npm 2FA when prompted.

## Release discipline (default after every release)

本节只在明确要求发布时触发，授权边界以 [AGENTS.md](../../AGENTS.md) 为准。项目发布线是 `main`；获准采用开发分支时，从 `main` 建立 `<version>-dev`（例如 `1.4.0-dev`）。分支创建、切换和删除均应在本次授权内；既有未提交改动继续保留。

After each feature/fix set is tested and you are asked to release, follow this order for the authorized dev-branch workflow:

1. On the current dev branch: bump `package.json` version and write the release notes into `CHANGELOG.md` and `CHANGELOG.zh.md` (the new version's section at the top of each file, newest first; the two files are kept in sync, with the English file brief and the Chinese file carrying the complete history). The READMEs carry no release-note bodies — each links to the two changelogs.
2. Run `pnpm run check` and the relevant tests before release; `check` includes syntax checks of both lib files.
3. Merge the dev branch into `main` (fast-forward when `main` has not diverged).
4. Create an annotated tag on `main` at the release commit, e.g. `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
5. When branch cleanup/creation is authorized, **create the next dev branch** from `main` and **clean up the old dev branch**, e.g. `git checkout -b vNext-dev` then `git branch -d <old-dev>`. Otherwise report that handoff as pending instead of modifying branches.

The owner handles [npm publishing](#publish) manually (npm 2FA). A commit/push request does not authorize npm publishing, tags, or extra branch refs. Before Git delivery, verify the selected remote is user-owned and writable, then push only the authorized `HEAD:main`. A read-only or disabled upstream remote remains a source, not a publishing target. External contributions follow the owner's review process and are credited in the README acknowledgements and release notes (precedent: PR #1 by @Marcuss2).

`pnpm publish` git-checks only require a clean working tree (not a tagged HEAD); a stray generated `pnpm-lock.yaml` is gitignored so it does not dirty the tree.
