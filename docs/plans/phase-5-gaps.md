# Phase 5: design vs code gaps

**Date:** 2026-10-28
**Checked against:** `feat/rbac-edge-enforcement` at `67fffce1` (contains `origin/feature` `8c66c99f`).
**Design sources:** `apis-phase-5.md`, `phase-5-rbac-handoff.md` (identical copies in `docs/plans/` and `docs/rbac/`), `docs/rbac/rbac-*.md`, `user-org-target-model.md`.
**Rule used:** items the handoff's "Not done in Phase 5" list defers (agreed 2026-10-07) are not counted as gaps.

---

## 1. Real gaps

| #   | Gap                                                                                                                                                                                                                                        | Evidence                                                      | Severity |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------- |
| 1   | **Org Onboarder role grants nothing.** `POST /v1/org/decision/:id` requires `orgs.onboard` at the edge, then the handler calls `requireNetworkAdmin`, so a non-root holder gets 403. The console still offers the role in the owner panel. | `apps/api/src/routes/v1-org.ts:238`, `:254`, `:308`           | High     |
| 2   | ~~`known_as` not implemented.~~ Done: each parent org defines its children's `known_as` values (`docs/org-hierarchy.md`).                                                                                                                  | —                                                             | —        |
| 3   | **`parent_id` not locked in the DB.** `organisations_lock` covers `org_type` and the aggregator slug only. Moves go through the store under the tree lock (`PATCH /v1/org/parent/update/:id`); no trigger stops another writer.            | `0028_organisations.sql`                                      | Low      |
| 4   | **Legacy API contract unguarded.** No `USER_ORG_API_ENABLED` flag, no `openapi-legacy-paths` snapshot test, no `deprecated` markers.                                                                                                       | No matches; routes register unconditionally                   | Medium   |
| 5   | **Coordinator "My account" screen (W1) missing.** `/profile` still has the "Request an update" stub.                                                                                                                                       | `apps/web/src/app/(protected)/profile/ProfileFormView.tsx:18` | Medium   |
| 6   | **Six permissions gate no route:** `orgs.block`, `profiles.verify`, `profiles.move`, `profiles.retire`, `agreement.manage`, `profiles.act_on_behalf`.                                                                                      | 0 references each in `apps/api/src/routes/*.ts`               | Medium   |
| 7   | **`org/read` returns owner contact without a `contact.unmask` check or audit.** No exposure today (owners reach only their own orgs; Network Admin and Org Admin both hold `contact.unmask`), but it differs from the user routes.         | `v1-org.ts:134`; compare `v1-user.ts:168`                     | Low      |
| 8   | ~~Org search filter has `status` and `name_prefix` only.~~ Done: `descendants_of` filter.                                                                                                                                                  | —                                                             | —        |
| 9   | **`users.metadata` column not added**; user metadata update accepts `serves` only.                                                                                                                                                         | `packages/db-schema/src/schema.ts` (users)                    | Low      |
| 10  | **No E2E for the console** (owner login, invite, accept).                                                                                                                                                                                  | `.claude/skills/aggregator-e2e/` has no `/console` steps      | Low      |

## 2. Built differently from the design (docs stale)

| Item                                                                       | Design                                 | Code                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| `GET /v1/org/read/:id` response                                            | `{org, admins[], child_count}`         | `{org, owner, coordinator_count, pending_count}`                           |
| `POST /v1/user/create`                                                     | single user, `201 {user, invite_sent}` | bulk invite `{org_id, recipients[]}` → `{sent, resent, invalid, existing}` |
| Update responses                                                           | `{org}` / `{user}`                     | bare `OrgSchema` / `UserSchema`                                            |
| Coordinator self rows (`user/read/<self>`, self `metadata/update`)         | allowed                                | admin capability required except `read/me` (handoff: deliberate)           |
| RBAC design D1 (org routes = `org.manage`)                                 | `org.manage`                           | `anyCapability ['org.manage','orgs.onboard']`                              |
| RBAC implementation plan R3                                                | `config/rbac.yaml` + sync at start     | roles seeded by `0031_rbac_seed.sql`; file does not exist                  |
| `rbac-design-aggregator.md`: custom-roles API "No console page calls them" | none                                   | `console/roles/page.tsx` (unlinked, behind `RBAC_CUSTOM_ROLES_ENABLED`)    |
| Handoff path `train-online.ts`                                             | —                                      | `apps/api/src/tools/instance-upgrade-online.ts`                            |
| `rbac-edge-enforcement.md` status                                          | "proposal"                             | implemented                                                                |

## 3. Deferred by design (handoff §3)

- Child orgs: `POST /v1/org/create`, `PATCH /v1/org/parent/update`, `ORG_CHILD_LIMIT` / `ORG_DEPTH_LIMIT` / `ORG_PARENT_CYCLE`, console W5/W6.
- Several admins per org: `PATCH /v1/org/user/update`, `LAST_ADMIN`, `PRIMARY_NOT_MEMBER`.
- Contact change with OTP: `contact/update`, SMS provider, `contact_change_audit`, `OTP_*` errors.
- Deactivate (#851), including removing `org_owner` and logging out; claim rename (#852).
- Database audit table for console actions; Keycloak group rename.

## 4. Org hierarchy (nesting)

Built: parent at registration, stored `depth`, `max_depth` / `max_children` / `max_total_orgs`, a move route with cycle and limit checks, read-only view of the orgs below an owner's own, and the console tree, Move dialog and hierarchy settings. See `docs/org-hierarchy.md`.

Still open:

| Layer       | Needed                                                                         |
| ----------- | ------------------------------------------------------------------------------ |
| Permissions | Ancestors are the real parent chain, so roles held at a parent apply below it. |
| Approval    | The parent org's admins approve their children (gap 1).                        |
| Create      | Org admins create child orgs from the console (`POST /v1/org/create`, W5).     |
| DB lock     | A trigger that blocks `parent_id` changes outside the move path (gap 3).       |
| Keycloak    | Optionally sub-groups that mirror the tree.                                    |

## 5. Not verifiable in this repo

- Edge design E3 expects the API bound to `127.0.0.1`; `apps/api/src/config.ts:28` defaults `HOST` to `0.0.0.0`. May be set in the bluedots-automation deployment.
