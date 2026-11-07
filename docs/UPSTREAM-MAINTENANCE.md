# Fork maintenance

## 2026-11-07 — 26.11.7-lhg

- Base: `4a06058d683558c77c4d556769e5f414021bedf6` (0.1.2). The MIT-licensed upstream `BPTumbleweed/dsh-session-retitle` remains at `0d01650904d9ebb2e5bbb7a1b04a228d3d8d9716`; no new upstream code was available or merged.
- Fixed a stale contract test that still required the upstream fallback model after this fork deliberately removed runtime model fallback. The check now verifies the fork's manifest defaults and rejects legacy fallback configuration. It runs even when official DSH packages are unavailable.
- Added runtime/package version agreement and no-target-model regression coverage. Updated the installation example to use the already-merged main branch and corrected test counts.
- Preserved the sidebar AI quick rename, header manual rename, target-session model selection, 10-message/10000-character budget, trust fence and permission behavior. Production behavior is unchanged apart from the displayed version.
- Validation: 39 self-tests; all four contract checks using installed official DSH 0.2.0-rc.2 packages; missing-package skip-path check; JavaScript syntax; package dry-run and exported entrypoints. No running DSH browser end-to-end test was performed.
- This repository has no build script or GitHub Actions workflow. No workflow, permission, account, npm publication or release-archive changes were made.
