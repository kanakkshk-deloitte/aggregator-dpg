# RBAC edge enforcement — aggregator-dpg

## Summary

Move permission enforcement out of the API process and in front of it: an Envoy sidecar asks OPA whether the caller holds the route's permission, and a refused request never reaches the API. The API keeps only the checks that need the target record or the response (reach, list filtering, contact masking). Builds on a roles claim in the access token (section 3.2) and on the current design ([rbac-design-aggregator.md](rbac-design-aggregator.md)).

Status: proposal. Describes the code at `06668001` (`feat/871-rbac-catalogue-view`).

---

## 1. Problem

Today the API is the enforcement point. OPA runs beside it, but only as a decision service the API calls during the request.

| Step                                                    | Where it runs today                                    | Code                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Verify the Keycloak token                               | API, in each route file's auth wrapper                 | `apps/api/src/services/auth/access-token.ts`                                                               |
| Read the user, their memberships and live roles         | API → Postgres, on every request (not cached)          | `apps/api/src/services/authz/guard.ts:82`; [rbac-design-aggregator.md](rbac-design-aggregator.md) line 264 |
| Expand roles to permissions for the target organisation | API, from the role snapshot                            | `actorPermissions`, `apps/api/src/services/authz/guard.ts:102`                                             |
| Decide allow or deny                                    | OPA sidecar, over HTTP (`POST /v1/data/rbac/decision`) | `packages/rbac/src/opa/index.ts:35`; `apps/api/src/services/authz/runtime.ts:119`                          |
| Refuse (403)                                            | API                                                    | `enforceRouteAccess`, `apps/api/src/services/authz/route-access.ts:219`                                    |

What this means:

- **A refused request still reaches the API.** It is accepted, its body is validated, its token is verified and the user is read from Postgres before the permission check refuses it.
- **Every protected request costs a database read and at least one OPA call** (timeout 500 ms, one retry: `apps/api/src/config.ts:410-414`). An OPA failure is a deny (`guard.ts:155`).
- **Enforcement depends on each route calling it.** There is no global hook. Each route file's auth wrapper calls `enforceRouteAccess` (11 call sites, plus `requireActor` for the console routes at `apps/api/src/services/auth/actor/require.ts:80`). The boot check (`assertRouteDeclared`, `apps/api/src/app.ts:210`) guarantees every route declares a permission, not that the declaration is checked.
- **The policy in OPA is small.** The API sends a ready-made permission list. The role-to-permission mapping and reach live in the API, so OPA cannot be reasoned about, tested or reused on its own.

**Goal:** a request without the route's permission is refused before it reaches the API, by a policy that holds the permission rules itself, while the API keeps the checks that genuinely need its data.

**Non-goals:**

- Moving reach (which records an organisation may touch), list filtering or contact masking out of the API (decision E2).
- Changing the permission model, the roles or the catalogue ([rbac-permissions-and-roles.md](rbac-permissions-and-roles.md)).
- signals-dpg.

---

## 2. Target architecture

Every request to the API passes through an Envoy sidecar in the API pod. Envoy verifies the token, asks OPA (the `opa-envoy-plugin` build, gRPC `ext_authz`) whether the caller holds the route's permission, and forwards only allowed requests. The API listens on `127.0.0.1` inside the pod, so nothing reaches it except through Envoy (decision E3).

| Hop                        | Does                                                                                                                                                                                                                         | Refuses with            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1. Envoy `jwt_authn`       | Verifies the Keycloak access token: issuer, signature (JWKS), expiry, `azp` allow-list. Passes the verified claims to the next filter. Routes declared `public` or `link_token` are allowed without a token.                 | 401                     |
| 2. Envoy `ext_authz` → OPA | Sends method, path and the verified claims to OPA. OPA looks up the route's declaration, expands the caller's roles from the token to permissions, and decides. Fail closed: if OPA does not answer, the request is refused. | 403 (OPA's body)        |
| 3. API                     | Runs the handler. Keeps only the checks that need its data or the response (section 4).                                                                                                                                      | 404 (reach), 409, 400 … |

What each side owns after the change:

| Concern                                                             | Today                                     | Target                                                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Token verification                                                  | API                                       | Envoy (the API may keep its own as defense in depth, phase 2)                                                    |
| Route → permission                                                  | `config.rbac` in code, checked by the API | Same declarations, exported to OPA as data; decided by OPA at the edge                                           |
| User's roles                                                        | Postgres, per request                     | Edge: a flat `roles` claim in the token (decisions E1, E5). API: still Postgres, for its per-organisation checks |
| Role → permissions                                                  | Role snapshot in the API                  | Catalogue held by OPA as data                                                                                    |
| Permission decision                                                 | OPA, called by the API                    | OPA, called by Envoy, before the API                                                                             |
| Reach (404), list filtering, contact masking, role-assignment rules | API                                       | API (decision E2)                                                                                                |

The decision at the edge is the same one the API makes today. The route-level check passes no target organisation (`requirePermission`, `apps/api/src/services/authz/guard.ts:225-250`), so it asks "does the caller hold this permission in any of its organisations". OPA can answer that from the token alone, so the claim carries role keys only, with no organisation (decision E5). The per-organisation questions stay in the API, which reads them from Postgres as it does today.

---

## 3. What OPA needs at the edge

### 3.1 Route → permission map

Today every route declares its access in `config.rbac` (65 declarations: 34 `capability`, 5 `anyCapability`, 26 `access`). The boot check records each one (`assertRouteDeclared`, `apps/api/src/services/authz/route-access.ts:154`) and a snapshot test lists them all (`apps/api/src/services/authz/__tests__/route-access.test.ts:313`).

Plan:

- **Generate, never hand-write.** A script dumps `listDeclaredRoutes()` (`route-access.ts:111`) to `policy/rbac/edge/routes.json`: method, path template, declaration. Same pattern as the OpenAPI dump (`pnpm --filter @aggregator-dpg/api spec:dump`).
- **CI drift check.** CI regenerates the file and fails if it changed, like the OpenAPI drift step in `.github/workflows/ci.yml`. A new route cannot ship without its entry.
- **Matching.** OPA matches the request's method and path against the templates (`/v1/user/read/:id`). Templated registrations such as `/v1/campaign/${channel}` are already concrete in `listDeclaredRoutes()`, so the file holds real paths.
- **Unknown route = deny.** A request that matches no entry is refused at the edge (the API's 404 for unknown routes becomes Envoy's 403/404, open question 6).

### 3.2 Roles from the token

Decisions E1 and E5: the edge reads the caller's roles from a claim in the access token, a flat list of role keys:

```json
"roles": ["network_admin", "org_admin"]
```

| In the claim     | Rule                                                                                                                                                                                    | Today's equivalent                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Base roles       | Only for active memberships: an approved coordinator holds `coordinator`, the owner of an active aggregator organisation holds `org_admin`, the owner of the root holds `network_admin` | The actor resolver (`apps/api/src/services/auth/actor/store.ts:40`, `:107`) |
| Additional roles | Unrevoked and unexpired `user_role` rows                                                                                                                                                | `roleStore.listLive`                                                        |
| Not in the claim | Organisation ids, permissions, names, contact data                                                                                                                                      | —                                                                           |

Because base roles are listed only for active memberships, a token with at least one role belongs to an active account. The claim is top-level `roles`, separate from Keycloak's own `realm_access.roles` (realm roles such as `org_owner`, read by the web app at `apps/web/src/lib/jwt.ts:60-62`).

The claim is coarse by design: it says the user holds a role somewhere, never where. Nothing may use it for a per-organisation decision; those stay in the API (section 4). For example, the network admin's claim holds `org_admin` (it owns the Default organisation), so it passes the edge on `org.manage` routes; the API then answers 404 for coordinators of other organisations, as it does today.

**How it gets into the token.** The same pattern as `decision_made` and `signalstack_org_id`:

- **Attribute.** An admin-only, multivalued user attribute `roles`, declared next to the existing ones (`infra/keycloak/init/apply-user-profile.sh:92-96`) and included in the boot verification that they are admin-only (`:136-138`).
- **Mapper.** An `oidc-usermodel-attribute-mapper` on the portal client: access token only, multivalued, `String`. Added to `infra/keycloak/realms/realm.json` beside the existing mappers (`:450-516`) and to `ensure_mapper` (`apply-user-profile.sh:338`) so existing realms get it.
- **Source of truth.** Postgres. The attribute is a projection: one function recomputes the user's whole role list from the database and writes it with `setAttributes` (`apps/api/src/services/idp-admin/interface.ts:72`). Writing the whole list, never adding or removing one role, makes every write idempotent.
- **Concurrency.** `setAttributes` reads and rewrites the whole Keycloak user (`apps/api/src/services/idp-admin/keycloak.ts:226-249`), so two writes to the same user can overwrite each other. The recompute and write run under a per-user lock in Redis.
- **Finding the Keycloak user.** Coordinators by their `aggregator_id` attribute (`findByAttribute`, as in `apps/api/src/services/decisions/coordinator.ts:116`); admins by their `user_identities` subject.
- **Failure.** A failed write never fails the user's request. It is logged (`rbac.token_roles.sync`, `status: failure`), retried once with backoff, and the user is marked for the sweep below.

**When it is written.** After the database change commits, on every change that adds or removes a role:

| Change                                                                       | Code                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Additional role assigned / revoked                                           | `assignRole` / `revokeRole`, `apps/api/src/services/authz/roles.ts:193`, `:253`                                                                              |
| Roles revoked on leaving an organisation                                     | `revokeRolesOnLeave`, `roles.ts:298` (called from `apps/api/src/services/decisions/coordinator.ts:318` and `apps/api/src/services/organisation-root.ts:531`) |
| Coordinator approved / rejected                                              | `apps/api/src/services/decisions/coordinator.ts:224`, `:301`                                                                                                 |
| Organisation approved (owner gains `org_admin`)                              | `grantOwnerAccess`, `apps/api/src/services/decisions/org.ts:88`                                                                                              |
| Organisation rejected, retired or deleted (owner loses it)                   | The organisation decision path and store (`apps/api/src/services/decisions/org.ts`, `apps/api/src/services/organisation-store/`)                             |
| Root or Default owner changed at boot                                        | `apps/api/src/services/organisation-root.ts:295`, `:315`                                                                                                     |
| A timed role expires (PII Access, 90 days at most)                           | No event: the sweep below                                                                                                                                    |
| Bulk role changes (`scripts/sql/rbac-backfill-roles.sql`, instance upgrades) | A full reconcile after the run                                                                                                                               |

**Expiry and drift.** A sweep every minute rewrites the users whose timed roles expired since the last run and the users marked after a failed write. A full reconcile rewrites every user at boot and then daily. Both run on a timer in the API, like the catalogue refresh, under a Redis lock so one replica runs each (`apps/api/src/services/authz/token-roles-sweep.ts`; `RBAC_TOKEN_ROLES_SWEEP_MS`, default 60 s, and `RBAC_TOKEN_ROLES_RECONCILE_MS`, default one day; open question 4).

**Other callers.** Service accounts carry no roles claim: `access: 'service'` routes are decided from `preferred_username` (`service-account-<client>`), as the API does today (`isServiceAccount`, `route-access.ts:99`). A user token without the claim is refused at the edge once enforcement is on; in phase 1 (dry-run) it is logged.

### 3.3 Role → permission catalogue

The catalogue is the built-in roles (`packages/rbac/src/builtin-roles.ts`, seeded by migration `apps/api/drizzle/migrations/0031_rbac_seed.sql`) plus custom roles in the database (only with `RBAC_CUSTOM_ROLES_ENABLED`, `apps/api/src/config.ts:403`). The API reloads it when its revision changes, every `RBAC_CATALOGUE_REFRESH_MS` (default 30 s, `config.ts:419`).

The API pushes the catalogue, with the RBAC mode, to its own OPA sidecar (`PUT /v1/data/catalogue`, `apps/api/src/services/authz/edge-catalogue.ts`) at boot and on every refresh tick, not only when the revision changes, so a restarted OPA is filled again within one tick (`apps/api/src/services/authz/runtime.ts`).

- OPA keeps the last catalogue it received, in memory. If it restarts empty, the edge refuses every permission route until the API pushes again (fail closed); `public` routes pass as soon as OPA answers.
- The edge policy is its own package, `policy/rbac/edge.rego` (tests in `policy/rbac/edge_test.rego`): it expands the token's role keys with the catalogue and matches the request against `policy/rbac/edge/routes.json`. It percent-decodes each path segment before matching, as Fastify does, so an encoded path (`/v1/bulk-uploads/te%6dplate`) is decided against the route the API serves.
- An OPA bundle served from the API or object storage was the alternative (open question 3); the push was chosen.

---

## 4. What stays in the API

The edge answers "does the caller hold this permission at all". Everything that needs the target record, the request body or the response stays in the API (decision E2, which keeps design decision D3 in [rbac-design-aggregator.md](rbac-design-aggregator.md)).

| Check                                                                                                                                                                                                                                      | Why it cannot move                                                                                                                                     | Where it is                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission in the target organisation: `org.manage` in the coordinator's organisation (#873), `contact.unmask` in the target user's, a role's `assigned_by` in the organisation it is assigned in, no `profiles.view_pii` through the root | The claim has no organisation (decision E5); the API reads memberships and roles from Postgres                                                         | `apps/api/src/services/authz/manage-scope.ts:55`, `apps/api/src/routes/v1-user.ts:169`, `apps/api/src/services/authz/roles.ts:193`, `policy/rbac/rbac.rego` |
| Reach on routes with a path id: 18 of the 39 permission-gated routes (`/v1/user/read/:id`, `/v1/user/decision/:id`, `/v1/org/read/:id`, `/v1/links/:id`, `/v1/bulk-uploads/:id`, `/v1/campaign/{channel}/:job_id`, …)                      | The target's organisation is known only after reading the record. Out of reach answers 404 so ids cannot be probed.                                    | `apps/api/src/services/authz/scope.ts`, `manage-scope.ts`                                                                                                   |
| Reach on targets in the body (`org_id` in `POST /v1/user/create`, filters in `POST /v1/user/search`)                                                                                                                                       | The edge does not read request bodies                                                                                                                  | Same                                                                                                                                                        |
| List filtering (`/v1/user/search`, `/v1/org/search`)                                                                                                                                                                                       | Narrows the query; a yes/no answer cannot                                                                                                              | `scope.ts`, `manage-scope.ts`                                                                                                                               |
| Contact masking (`contact.unmask`)                                                                                                                                                                                                         | Decided per record, on the response                                                                                                                    | `showsContact`, `apps/api/src/routes/v1-user.ts`                                                                                                            |
| Role-assignment rules: `assigned_by`, account type, organisation type, `max_days`, not yourself                                                                                                                                            | Need the target user and role                                                                                                                          | `apps/api/src/services/authz/roles.ts`                                                                                                                      |
| Account state: approved coordinator, active owner (`NOT_APPROVED`, `NOT_ORG_ADMIN`, `USER_NOT_PROVISIONED`)                                                                                                                                | The edge only knows the account is active (roles are listed only for active memberships, section 3.2); the API keeps its own check as the second layer | `apps/api/src/services/auth/actor/require.ts:60-80`                                                                                                         |
| `link_token` routes (7)                                                                                                                                                                                                                    | The signed link is the credential; the route verifies it                                                                                               | Each route                                                                                                                                                  |
| `public` routes (7)                                                                                                                                                                                                                        | No caller to check; rate limits apply                                                                                                                  | Each route                                                                                                                                                  |

The API therefore still reads the user, their memberships and their roles from Postgres on the routes that need a per-organisation answer. What moves out is the decision and the refusal: a request without the permission never reaches the API.

---

## 5. Behaviour changes

| Area                                | Today                                                                                                                   | After                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who answers 403                     | The API (`FORBIDDEN` from `enforceRouteAccess`)                                                                         | Envoy, with OPA's body                                                                                                                                                                                                                                                                                                                                                      |
| 403 body                            | API envelope `{ error: { code, title, detail, fields, requestId, timestamp } }` (`apps/api/src/errors/serialize.ts:37`) | OPA builds the same envelope (`code: FORBIDDEN`, `fields.permission`), so the web BFF and the UI need no change                                                                                                                                                                                                                                                             |
| Request id                          | API takes `x-request-id` or generates one (`apps/api/src/app.ts:61-80`)                                                 | Envoy generates or propagates `x-request-id`; OPA's decision log and the API log carry the same id                                                                                                                                                                                                                                                                          |
| Deny log                            | `rbac.decide` / `rbac.access` pino lines in the API                                                                     | OPA decision logs (allow and deny), keyed by request id; the API logs only its own checks (reach, masking)                                                                                                                                                                                                                                                                  |
| `RBAC_MODE`                         | `off` / `log` / `enforce` for the API's checks (`apps/api/src/config.ts`)                                               | One switch for the edge and the API (decision E7). The API publishes it to OPA with the catalogue: `log` allows and records would-denies at the edge (`strict` routes refuse in `log` too, as today) and in the API's per-organisation checks; `enforce` refuses in both; `off` runs no RBAC and expects no edge                                                            |
| Revocation and grants               | Apply on the next request (roles read per request)                                                                      | At the edge, when the user's token is refreshed: access tokens live 300 s (`infra/keycloak/realms/realm.json:13`) and the web app refreshes them 60 s before expiry, so a revoked role passes the edge, and a newly granted one is refused, for up to about 5 minutes (a timed role's expiry adds up to one sweep, 60 s). Accepted (decision E6); the API does not recheck. |
| A refused request's cost to the API | Body validation, token check, Postgres read, OPA call                                                                   | None: it never arrives                                                                                                                                                                                                                                                                                                                                                      |
| OPA unavailable                     | The API denies (`engine_unavailable`, `guard.ts:155`)                                                                   | Envoy denies (`ext_authz` fail closed)                                                                                                                                                                                                                                                                                                                                      |
| Unknown route                       | API 404                                                                                                                 | Refused at the edge (open question 6)                                                                                                                                                                                                                                                                                                                                       |

The stale-page case tested in Scenario A (a role revoked while a page is open) changes: today the next click is refused at once; with roles in the token it is refused once the token refreshes, up to about 5 minutes later (decision E6). The phase-1 dry run showed exactly this. The reverse also holds: after a grant the UI (which reads permissions from the database) offers the action before the edge accepts it; if that matters, the web app can refresh the token when its permissions change, rather than the API checking twice.

---

## 6. Phased rollout

| Phase                   | Work                                                                                                                                                                                                                                                                                                                                                                                 | Done when                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 0. Prerequisites        | The `roles` claim (section 3.2): attribute and mapper in both realms, sync on every role change, expiry sweep and reconcile. `routes.json` generator and CI drift check. Catalogue push to OPA. Policy rewritten to expand roles itself, with Rego tests and the shared vectors.                                                                                                     | Tokens carry the roles claim; `routes.json` is generated and checked in CI; the new policy passes `opa test` and the vectors |
| 1. Edge in dry-run      | Envoy + OPA in front of the API in every environment; the edge never refuses, it logs its decision. The API keeps enforcing as today.                                                                                                                                                                                                                                                | Over an agreed period, and the RBAC end-to-end suite, every edge decision matches the API's decision for the same request id |
| 2. Enforce at the edge  | The edge refuses. The API's route-level permission check stays as defense in depth.                                                                                                                                                                                                                                                                                                  | The end-to-end suite passes; a refused request leaves no API log line; OPA unavailable refuses at the edge                   |
| 3. Remove the duplicate | Drop the API's route-level permission check entirely (`enforceRouteAccess` capability branches, `route-access.ts:234-247`), data-release permissions included (decision E6): each check exists in one place. Keep reach, filtering, masking, assignment rules and account state (section 4), which the edge cannot decide. Keep the boot check that every route declares its access. | Unit and end-to-end suites pass; the API makes no OPA call for route-level decisions                                         |

Phases 1 and 2 are reversible by configuration (mode and Envoy filter). Phase 3 is a code change.

---

## 7. Local and deployment changes

### 7.1 Local (`local-setup/docker-compose.yml`)

| Today                                                                                                                  | Change                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opa` service, plain OPA image, HTTP on `127.0.0.1:8181`                                                               | Add the `opa-envoy-plugin` image (gRPC `ext_authz`), keep the HTTP API for the catalogue push                                                                           |
| `aggregator-api` publishes `4000` to the host, because emailed links built from `PUBLIC_API_URL` open the API directly | `aggregator-api` stops publishing; a new `aggregator-envoy` service publishes `4000` and forwards to the API. `PUBLIC_API_URL` keeps `http://localhost:4000`, now Envoy |
| `aggregator-web` calls `API_BASE_URL: http://aggregator-api:4000`                                                      | `API_BASE_URL` points at Envoy                                                                                                                                          |
| —                                                                                                                      | Envoy needs Keycloak's JWKS: issuer `http://keycloak:8080/realms/bluedots`, as the API uses today                                                                       |
| Keycloak declares no roles attribute                                                                                   | `roles` declared admin-only and its mapper added (`infra/keycloak/init/apply-user-profile.sh`, `infra/keycloak/realms/realm.json`)                                      |

The root `docker-compose.yml` (the docker-only / VM stack, and `pnpm stack:up`, which layers `docker-compose.dev.yml` on it) has the same edge: an `envoy` service in front of `api`, the opa-envoy-plugin build of `opa`, and nginx's `/backend/` and the web app routed through Envoy (`API_BASE_URL=http://envoy:4000`). Its default stays `RBAC_MODE=log`. `infra/envoy/envoy.yaml` is a template both stacks fill in at start: the API's hostname, the token issuer (the public `…/auth/realms/<realm>` in the root stack) and the JWKS URL.

Running the API on the host (`pnpm dev`) has no edge: requests reach it directly, so it must not run `RBAC_MODE=enforce`.

### 7.2 Deployment (bluedots-automation)

Follow-ups only. I have not read the deployment repository.

- Envoy and the `opa-envoy-plugin` build as sidecars in the API pod; the API container binds `127.0.0.1`.
- The Service and ingress target Envoy's port, not the API's.
- Kubernetes probes for `/health/live` and `/health/ready` go through Envoy (declared `public`) or to the API port inside the pod.
- The `roles` attribute (admin-only) and its mapper in the deployment realm.

---

## 8. Decisions and open questions

| #   | Decision                               | Chosen                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Where the edge gets the caller's roles | A `roles` claim in the access token, kept in step by the API (section 3.2)                                                                       | No database call at the edge; same pattern as `decision_made`                                                                                                                                                                                                                                                                                               |
| E2  | Where object-level checks run          | The API (reach, filtering, masking, assignment rules)                                                                                            | They need the target record or the response; keeps design decision D3                                                                                                                                                                                                                                                                                       |
| E3  | Where Envoy runs                       | Sidecar in the API pod; the API binds `127.0.0.1`                                                                                                | Nothing can bypass it; mirrors today's OPA sidecar                                                                                                                                                                                                                                                                                                          |
| E4  | Deliverable                            | This design, then issues per phase                                                                                                               | —                                                                                                                                                                                                                                                                                                                                                           |
| E5  | What the claim carries                 | Role keys only: no organisation, no permissions                                                                                                  | The edge decides \"in any organisation\"; per-organisation checks stay in the API (E2), so an organisation in the claim would serve nothing at the edge                                                                                                                                                                                                     |
| E6  | Revocation and grant delay at the edge | Accepted: up to the access-token lifetime (about 5 minutes; plus one sweep for an expiry). No API recheck, not even for data-release permissions | Each check exists in one place; a duplicate route-level check in the API is not wanted. The per-organisation checks in section 4 are not duplicates: the edge cannot make them                                                                                                                                                                              |
| E7  | How the edge and the API are switched  | One `RBAC_MODE` for both; no separate edge mode                                                                                                  | Two modes existed only for the rollout (edge in `log` while the API enforced). Once route checks live only at the edge, a second switch only adds ways to misconfigure. Consequence: the API cannot tell whether an edge is in front, so an instance running `RBAC_MODE=enforce` must run the edge (decision E3: the API binds `127.0.0.1` in the pod)      |
| E8  | Custom-role authoring without the edge | Accepted: `POST /v1/roles/create`, `PATCH /v1/roles/update/:key` and `POST /v1/roles/delete/:key` have no network-admin check in the API         | They are the only routes whose sole permission check is at the edge (`network.administer`, strict); in the API any org owner passes `requireActor`. They exist only with `RBAC_CUSTOM_ROLES_ENABLED=true` (default `false`), so an instance that turns it on must run the edge. Every route that predates RBAC keeps its own account-type checks in the API |

| #   | Open question                    | Options                                                                                                                                                                                                           |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Revocation window at the edge    | Resolved: accepted, no API recheck (decision E6)                                                                                                                                                                  |
| 2   | `self` / `signed_in` at the edge | Resolved: a valid token with at least one role passes (roles are listed only for active memberships); the API keeps its account-state check (`requireActor`, `requireApproved`), which is not a route-level check |
| 3   | Catalogue delivery to OPA        | Resolved: push from the API on every refresh tick (section 3.3)                                                                                                                                                   |
| 4   | Sweep and reconcile trigger      | Resolved: a timer in the API, under a Redis lock (section 3.2)                                                                                                                                                    |
| 5   | Defense in depth after phase 3   | Rely on the `127.0.0.1` bind; or have the API also verify a header Envoy adds                                                                                                                                     |
| 6   | Unknown routes                   | Resolved: the edge answers 404, as the API did                                                                                                                                                                    |
| 7   | Stale design document            | Resolved: [rbac-design-aggregator.md](rbac-design-aggregator.md) now says built-in roles are defined in code and seeded by migration 0031                                                                         |
| 8   | signals-dpg                      | Out of scope; the same edge pattern could serve it later                                                                                                                                                          |
| 9   | Tracking issue                   | #870 describes an organisation-scoped claim the API reads; update it to match this design (flat claim, edge only)                                                                                                 |
