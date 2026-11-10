# Fork maintenance

## 2026-11-10 — 26.11.10-lhg

- Fork base: `acc7cfd48a7f8cb2da4254453e99d7f4dcb80a42`.
  Upstream `BPTumbleweed/dsh-session-retitle` remains at
  `0d01650904d9ebb2e5bbb7a1b04a228d3d8d9716`; original MIT and author retained.
- Official DSH [dsh-v0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1)
  commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`:
  `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css`
  adds `titleCluster` overflow clipping and a mask. The header action slot remains
  in that cluster. Move the rename dialog to a body portal using host React DOM.
- Fixed positioning clamps/flips at viewport edges; resize, captured scroll and
  ResizeObserver maintain anchoring. Portal-aware outside clicks preserve input
  and submit. Failure/retry and in-flight close/reopen retain the busy lock.
  Close/cancel/Escape/unmount dispose listeners/observer and portal.
  Existing sidebar/context menu, theme, model selection, history budgets and
  trust behavior are preserved. React DOM is an optional host peer, not bundled.
- Both official npm rc.1 and rc.5: 39 self-tests + 8 real Session/AgentRegistry/
  SessionTitle service checks + 4 contracts + 20 React DOM checks = 71.
  The old main fails the portal regression before the fix. A deterministic LLM
  stream fixture tests AI routing; no paid model or user session is involved.
- Syntax, whitespace, package contents/import and official rc.1 CLI isolated
  Web-profile local-tarball install/config composition verified. No compiler or
  existing Actions workflow. No workflow/account/permission or npm changes;
  installation archives are local only.
- Visual limitation: Chromium with sandbox enabled is blocked by local socket
  Operation not permitted in this environment, including the elevated execution
  attempt. No disabled sandbox and no claim of user-desktop visual acceptance.


## 2026-11-07 — 26.11.7-lhg

- Base: `4a06058d683558c77c4d556769e5f414021bedf6` (0.1.2). The MIT-licensed upstream `BPTumbleweed/dsh-session-retitle` remains at `0d01650904d9ebb2e5bbb7a1b04a228d3d8d9716`; no new upstream code was available or merged.
- Fixed a stale contract test that still required the upstream fallback model after this fork deliberately removed runtime model fallback. The check now verifies the fork's manifest defaults and rejects legacy fallback configuration. It runs even when official DSH packages are unavailable.
- Added runtime/package version agreement and no-target-model regression coverage. Updated the installation example to use the already-merged main branch and corrected test counts.
- Preserved the sidebar AI quick rename, header manual rename, target-session model selection, 10-message/10000-character budget, trust fence and permission behavior. Production behavior is unchanged apart from the displayed version.
- Validation: 39 self-tests; all four contract checks using installed official DSH 0.2.0-rc.2 packages; missing-package skip-path check; JavaScript syntax; package dry-run and exported entrypoints. No running DSH browser end-to-end test was performed.
- This repository has no build script or GitHub Actions workflow. No workflow, permission, account, npm publication or release-archive changes were made.

