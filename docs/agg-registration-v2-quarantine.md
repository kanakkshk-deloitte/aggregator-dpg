# Quarantine: `agg-registration-v2` (PR #426)

**Status:** 🚫 Quarantined — do not merge until remediated.
**Branch:** `agg-registration-v2` · **PR:** [#426](https://github.com/Blue-Dots-Economy/aggregator-dpg/pull/426) (draft, conflicting) · **Last substantive commit:** 2026-06-18.
**Tracking:** PLAN item **1.17** (this quarantine) / **2.16** (remediation).

## Why this exists

`agg-registration-v2` introduces a registration **finite-state-machine + reconciler** (plus design docs) intended to replace the current registration flow. It was reviewed on **2026-06-18** and found to carry **unfixed P0 issues**. The branch was never merged.

**The production path is not affected.** `develop` ships a simpler **token-based email-approval** flow (signed approval-token links → approver page → atomic CAS on the row → Keycloak enable/role assign). That flow does **not** contain the v2 FSM/reconciler code, so the P0s below are latent-on-a-branch, not live. This document exists so the branch is not merged by accident before the P0s are fixed.

## Unfixed P0s (2026-06-18 review)

| #   | Issue                                              | Risk                                                                                                                     |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | **No reconcile timeout**                           | The reconciler can hang indefinitely — a stuck external call (Keycloak, DB) blocks the loop with no bound.               |
| 2   | **Fire-and-forget `void` async IIFEs**             | Background work is launched unawaited; rejections are swallowed and never surface (no log, no retry, no failure signal). |
| 3   | **No heartbeat / liveness** on the reconciler loop | A silently-dead reconciler looks healthy; stuck registrations never get reconciled and nothing alerts.                   |
| 4   | **No tests** for the FSM or reconciler             | State transitions and failure/retry paths are entirely unverified.                                                       |

These mirror the repo-wide rules the v2 code violates: `error-handling.md` (timeouts + retry + no silent swallowing on every external call) and `testing-requirements.md` (≥70% coverage, failure-path tests).

## Merge gate

The PR is **draft** and carries the **`do-not-merge`** label. Before that label is removed and the branch is merged, **all four P0s must be remediated** (bounded reconcile timeouts, `await`ed/propagated background work, a reconciler heartbeat, and FSM/reconciler test coverage) against the full 2026-06-18 P0 list — tracked as **PLAN item 2.16** (effort L) — **or the branch must be explicitly retired**. Record review sign-off on PR #426 before clearing the label.
