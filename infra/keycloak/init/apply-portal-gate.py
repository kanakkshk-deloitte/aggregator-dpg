#!/usr/bin/env python3
"""Apply the aggregator-portal entitlement gate to a LIVE Keycloak realm.

Mirrors infra/keycloak/realms/realm.json for stacks whose realm was already
imported (--import-realm only runs on an empty realm). Idempotent.

Fail-CLOSED apply order (build -> verify -> rebind -> delete):

  1. Build a COMPLETE new flow tree under generation-suffixed aliases, while
     the client stays bound to whatever it is bound to now.
  2. Verify the new tree structurally — both gates present, DENY executions
     REQUIRED, and both OTP gates positioned BEFORE otp-channel-choice-form
     (the property that stops an OTP being issued to an ineligible user).
  3. Only then rebind aggregator-portal, in a single PUT.
  4. Only then delete the superseded flows.

Nothing destructive happens before the rebind succeeds, so an interrupted run
(assert trip, transport drop, 409, Keycloak restart) leaves the PREVIOUS
binding intact rather than dropping the client onto the ungated default
browser flow. Any failure restores the entry-time binding, prints a loud
"GATE NOT APPLIED", and exits non-zero.

Generation suffixes exist because Keycloak flow/config aliases are unique per
realm: a stale alias blocks recreation, so the new tree cannot reuse the old
names while the old tree is still live. The FIRST apply on a realm with no
aggregator-portal-* flows uses the canonical aliases and the pinned FLOW_ID
(matching realm.json); later re-applies use `-gN` aliases and a
Keycloak-assigned id, which is immaterial because the client is rebound by the
id read back from the server.

Phase 5 (user & org): the gate admits org owners too. Each gate is a
CONDITIONAL sub-flow whose conditions Keycloak ANDs:

  * entitled — deny when the user has NO aggregator_id AND NOT the org_owner
    realm role (a Signals participant);
  * approved — deny when the user HAS an aggregator_id AND decision_made is
    not "approved" (an unapproved coordinator). Owners carry no decision.

`verify()` checks that structure and the conditions' configs, so a realm still
on the older coordinator-only tree fails it and is rebuilt.
"""
import json, os, re, sys, urllib.request, urllib.parse, urllib.error

KC = os.environ.get("KC_URL", "http://localhost:8080")
REALM = os.environ.get("KC_REALM", "bluedots")
USER = os.environ.get("KC_ADMIN_USERNAME", "admin")

BASE_FLOW = "aggregator-portal-browser"
ALIAS_PREFIX = "aggregator-portal-"
FLOW_ID = "9f3b1c52-7a41-4c8e-9d16-3b0f5a2e7c84"


def req(method, path, body=None, tok=None, raw=False):
    url = path if path.startswith("http") else f"{KC}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if tok:
        r.add_header("Authorization", f"Bearer {tok}")
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            txt = resp.read().decode()
            return resp.status, (txt if raw else (json.loads(txt) if txt else None))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def token():
    body = urllib.parse.urlencode(
        {"client_id": "admin-cli", "username": USER,
         "password": os.environ["KC_ADMIN_PASSWORD"], "grant_type": "password"}
    ).encode()
    r = urllib.request.Request(f"{KC}/realms/master/protocol/openid-connect/token", data=body)
    with urllib.request.urlopen(r) as resp:
        return json.load(resp)["access_token"]


TOK = None  # set by main()
A = f"/admin/realms/{REALM}/authentication"
C = f"/admin/realms/{REALM}/clients"


def executions(flow):
    return req("GET", f"{A}/flows/{urllib.parse.quote(flow)}/executions", tok=TOK)[1]


def flows():
    return req("GET", f"{A}/flows", tok=TOK)[1]


def find_exec(flow, display=None, provider=None):
    for e in executions(flow):
        if provider and e.get("providerId") == provider:
            return e
        if display and e.get("displayName") == display:
            return e
    return None


def set_req(flow, ex, requirement):
    ex = dict(ex)
    ex["requirement"] = requirement
    st, b = req("PUT", f"{A}/flows/{urllib.parse.quote(flow)}/executions", ex, tok=TOK)
    assert st in (202, 204), (st, b)


def add_exec(flow, provider, requirement, config=None, config_alias=None):
    # Identify the execution we just created by diffing ids, not by looking up
    # the provider. A gate can hold two conditions with the SAME provider (the
    # approved gate uses conditional-user-attribute twice), and a provider
    # lookup returns the first one every time — so the second add_exec would
    # re-mark the first condition and leave the new one at Keycloak's default
    # of DISABLED, which verify() then rejects.
    before = {e["id"] for e in executions(flow)}
    st, b = req("POST", f"{A}/flows/{urllib.parse.quote(flow)}/executions/execution",
                {"provider": provider}, tok=TOK)
    assert st in (200, 201), (provider, st, b)
    added = [e for e in executions(flow) if e["id"] not in before]
    assert len(added) == 1, (provider, "expected exactly one new execution", added)
    ex = added[0]
    set_req(flow, ex, requirement)
    if config:
        st, b = req("POST", f"{A}/executions/{ex['id']}/config",
                    {"alias": config_alias, "config": config}, tok=TOK)
        assert st in (200, 201), (config_alias, st, b)
    return ex


def add_subflow(parent, alias, description, requirement):
    before = {e["id"] for e in executions(parent)}
    st, b = req("POST", f"{A}/flows/{urllib.parse.quote(parent)}/executions/flow",
                {"alias": alias, "type": "basic-flow", "description": description}, tok=TOK)
    assert st in (200, 201), (alias, st, b)
    added = [e for e in executions(parent) if e["id"] not in before]
    assert len(added) == 1, (alias, "expected exactly one new subflow", added)
    ex = added[0]
    set_req(parent, ex, requirement)
    return ex


def gate(parent, alias, description, conditions, deny_msg, deny_alias):
    """A CONDITIONAL sub-flow: its conditions (ANDed by Keycloak) + Deny access.

    @param conditions - [(provider, config, config_alias), ...] in order.
    """
    add_subflow(parent, alias, description, "CONDITIONAL")
    for provider, config, config_alias in conditions:
        add_exec(alias, provider, "REQUIRED", config, config_alias)
    add_exec(alias, "deny-access-authenticator", "REQUIRED",
             {"denyErrorMessage": deny_msg}, deny_alias)


NO_AGG_ID = {"attribute_name": "aggregator_id", "attribute_expected_value": ".+",
             "regex": "true", "include_group_attributes": "false", "not": "true"}
HAS_AGG_ID = dict(NO_AGG_ID, **{"not": "false"})
OWNER_ROLE = "org_owner"
NOT_OWNER = {"condUserRole": OWNER_ROLE, "negate": "true"}
NOT_APPROVED = {"attribute_name": "decision_made", "attribute_expected_value": "approved",
                "regex": "false", "include_group_attributes": "false", "not": "true"}
# Message-BUNDLE KEYS, not literals: deny-access-authenticator resolves the
# configured string against the login theme's bundle and falls back to printing
# it verbatim when there is no match, so a realm applied before the theme ships
# degrades to the key rather than breaking. Copy lives in
# themes/otp/login/messages/messages_en.properties, next to the escape hatch on
# error.ftl that these denies now land on.
DENY_ENTITLED = "portalDenyNotEntitled"
DENY_APPROVED = "portalDenyNotApproved"
OTP_CHOICE = {"otpChoice.codeLength": "6", "otpChoice.ttl": "300",
              "otpChoice.maxRetries": "3", "otpChoice.phoneAttribute": "phoneNumber"}


def _truthy(v):
    return str(v).lower() == "true"


def check_gate(name, children, config_of):
    """Assert one gate sub-flow's conditions and deny.

    @param name - The gate's display name (`...-gate-<path>-<kind>[-gN]`).
    @param children - Its direct child executions, in order.
    @param config_of - execution -> its config dict ({} when none).
    @raises AssertionError - When the gate does not match its kind.
    """
    kind = "entitled" if "-entitled" in name else "approved" if "-approved" in name else None
    assert kind, f"unknown gate {name}"
    providers = [c.get("providerId") for c in children]
    assert providers[-1:] == ["deny-access-authenticator"], (name, "deny must come last")
    conds = [(c.get("providerId"), config_of(c)) for c in children[:-1]]
    for c in children:
        assert c["requirement"] == "REQUIRED", (name, "every step must be REQUIRED", c)
    attrs = {(cfg.get("attribute_name"), _truthy(cfg.get("not"))) for p, cfg in conds
             if p == "conditional-user-attribute"}
    roles = {(cfg.get("condUserRole"), _truthy(cfg.get("negate"))) for p, cfg in conds
             if p == "conditional-user-role"}
    if kind == "entitled":
        assert len(conds) == 2 and attrs == {("aggregator_id", True)} and roles == {(OWNER_ROLE, True)}, (
            name, "must deny only when there is no aggregator_id AND no org_owner role", conds)
    else:
        assert len(conds) == 2 and roles == set() and attrs == {
            ("aggregator_id", False), ("decision_made", True)}, (
            name, "must deny only a coordinator whose decision_made is not approved", conds)
        decision = next(cfg for p, cfg in conds if cfg.get("attribute_name") == "decision_made")
        assert decision.get("attribute_expected_value") == "approved", (name, decision)


def verify_tree(exs, config_of, flow="<flow>"):
    """Assert a gate tree actually gates, BEFORE it is bound.

    @param exs - The flow's executions, depth-first, as the admin API lists them.
    @param config_of - execution -> its config dict ({} when none).
    @param flow - Alias, for messages.
    @raises AssertionError - When a gate is missing or mis-shaped, a DENY is not
        REQUIRED, or an OTP gate does not precede otp-channel-choice-form (which
        would let an ineligible user receive a code — the whole point of the gate).
    """
    providers = [e.get("providerId") for e in exs]
    names = [e.get("displayName") or "" for e in exs]

    assert providers.count("deny-access-authenticator") == 4, (
        "expected 4 deny-access executions (2 OTP-path + 2 SSO-path), got "
        f"{providers.count('deny-access-authenticator')}"
    )
    assert providers.count("conditional-user-role") == 2, (
        "expected 2 conditional-user-role executions (the org_owner admission), got "
        f"{providers.count('conditional-user-role')}"
    )
    assert providers.count("conditional-user-attribute") == 6, (
        "expected 6 conditional-user-attribute executions, got "
        f"{providers.count('conditional-user-attribute')}"
    )
    for p in ("auth-cookie", "otp-identifier-form", "otp-channel-choice-form"):
        assert p in providers, f"missing execution {p} in {flow}"

    gates = [i for i, d in enumerate(names) if d.startswith("aggregator-portal-gate-")]
    kinds = sorted(re.sub(r"-g\d+$", "", names[i]) for i in gates)
    assert kinds == sorted([
        "aggregator-portal-gate-otp-entitled", "aggregator-portal-gate-otp-approved",
        "aggregator-portal-gate-sso-entitled", "aggregator-portal-gate-sso-approved",
    ]), ("unexpected gates", kinds)
    for i in gates:
        assert exs[i]["requirement"] == "CONDITIONAL", ("gate not CONDITIONAL", exs[i])
        level = exs[i]["level"]
        children = []
        for e in exs[i + 1:]:
            if e["level"] <= level:
                break
            if e["level"] == level + 1:
                children.append(e)
        check_gate(names[i], children, config_of)

    # Depth-first order: every OTP-path gate must sit ahead of the code issuer.
    otp_idx = providers.index("otp-channel-choice-form")
    otp_gates = [i for i in gates if names[i].startswith("aggregator-portal-gate-otp-")]
    assert len(otp_gates) == 2, ("expected 2 OTP-path gates, got", otp_gates)
    assert max(otp_gates) < otp_idx, (
        "OTP entitlement gate is ordered AFTER otp-channel-choice-form — an "
        "ineligible user would be sent a code"
    )


def live_config(execution):
    """The config of a live execution, read from the admin API."""
    cid = execution.get("authenticationConfig")
    if not cid:
        return {}
    st, b = req("GET", f"{A}/config/{cid}", tok=TOK)
    assert st == 200, ("config read failed", cid, st)
    return (b or {}).get("config") or {}


def verify(flow):
    """Assert the live flow `flow` gates (see verify_tree)."""
    verify_tree(executions(flow), live_config, flow)
    print(f"  verified {flow}: 2 OTP gates + 2 SSO gates, all ahead of OTP dispatch")


def main():
    """Build, verify and bind the gate on the live realm (see module doc)."""
    global TOK
    TOK = token()

    # --- resolve the client + its CURRENT binding (nothing mutated yet) ----------
    _clients = req("GET", f"{C}?clientId=aggregator-portal", tok=TOK)[1]
    assert _clients, "client aggregator-portal not found in realm " + REALM
    CID = _clients[0]["id"]
    PREV_BINDING = dict(
        req("GET", f"{C}/{CID}", tok=TOK)[1].get("authenticationFlowBindingOverrides") or {}
    )
    print(f"  aggregator-portal current browser binding: {PREV_BINDING.get('browser') or '(none)'}")


    def bind(flow_id):
        """Point aggregator-portal's browser flow at `flow_id` in a single PUT.

        An empty string clears the override (an empty map is silently ignored on
        update); clearing means the realm-default, UNGATED browser flow.
        """
        rep = req("GET", f"{C}/{CID}", tok=TOK)[1]
        rep["authenticationFlowBindingOverrides"] = {"browser": flow_id or ""}
        st, b = req("PUT", f"{C}/{CID}", rep, tok=TOK)
        assert st in (200, 204), (st, b)


    # --- pick this run's generation ---------------------------------------------
    # Aliases are realm-unique, so a rebuild that must coexist with the live tree
    # needs fresh names. Generation 0 == the canonical realm.json aliases.
    _existing = [f["alias"] for f in flows() if f["alias"].startswith(ALIAS_PREFIX)]
    _gens = [0] if BASE_FLOW in _existing else []
    for _a in _existing:
        m = re.fullmatch(re.escape(BASE_FLOW) + r"-g(\d+)", _a)
        if m:
            _gens.append(int(m.group(1)))
    # ANY leftover aggregator-portal-* alias forces a fresh generation, including an
    # orphaned sub-flow from a half-finished older run — reusing gen 0 there would
    # collide on the sub-flow alias, not just the top-level one.
    GEN = 0 if not _existing else (max(_gens) + 1 if _gens else 1)
    SUFFIX = "" if GEN == 0 else f"-g{GEN}"

    PORTAL_FLOW = BASE_FLOW + SUFFIX
    AUTH = "aggregator-portal-auth" + SUFFIX
    FORMS = "aggregator-portal-otp-forms" + SUFFIX
    NEW_ALIASES = set()


    def n(alias):
        """Namespace an alias into this run's generation and record it as ours."""
        a = alias + SUFFIX
        NEW_ALIASES.add(a)
        return a


    for _a in (PORTAL_FLOW, AUTH, FORMS):
        NEW_ALIASES.add(_a)


    # --- already gated? then this is a no-op -------------------------------------
    # Lets the keycloak-init sidecar run this on EVERY boot: a realm freshly
    # imported from realm.json already carries the gate (with the pinned FLOW_ID),
    # so rebuilding would churn the tree and discard that id for no benefit. Only a
    # missing or structurally broken gate triggers a rebuild.
    _bound_id = PREV_BINDING.get("browser")
    if _bound_id:
        _bound_alias = next((f["alias"] for f in flows() if f["id"] == _bound_id), None)
        if _bound_alias:
            try:
                verify(_bound_alias)
                print(f"\nGate already present on '{_bound_alias}' — nothing to do.")
                sys.exit(0)
            except AssertionError as e:
                print(f"  bound flow '{_bound_alias}' failed verification ({e}) — rebuilding")
        else:
            print(f"  bound flow id {_bound_id} no longer exists — rebuilding")

    print(f"  building generation {GEN} (aliases suffixed {SUFFIX or '<none>'})")

    try:
        # --- build the new tree, in execution order -----------------------------
        body = {
            "alias": PORTAL_FLOW, "providerId": "basic-flow",
            "topLevel": True, "builtIn": False,
            "description": "aggregator-portal only; bound by flow ID. Adds a portal-entitlement gate to aggregator-otp-browser.",
        }
        # Pin the realm.json id only on a clean realm; on a rebuild the old tree
        # still holds it, so let Keycloak assign one and bind by the id read back.
        if GEN == 0:
            body["id"] = FLOW_ID
        st, b = req("POST", f"{A}/flows", body, tok=TOK)
        assert st in (200, 201), (st, b)
        print(f"  created flow {PORTAL_FLOW}")

        # The ALTERNATIVE pair must live one level down: Keycloak ignores every
        # ALTERNATIVE at a level that also holds REQUIRED/CONDITIONAL executions.
        add_subflow(PORTAL_FLOW, AUTH, "Cookie or OTP forms (ALTERNATIVE pair).", "REQUIRED")
        add_exec(AUTH, "auth-cookie", "ALTERNATIVE")

        add_subflow(AUTH, FORMS,
                    "Identifier resolution, entitlement gate, then OTP channel choice.", "ALTERNATIVE")
        add_exec(FORMS, "otp-identifier-form", "REQUIRED")
        gate(FORMS, n("aggregator-portal-gate-otp-entitled"),
             "Deny before OTP dispatch: neither a coordinator nor an org owner.",
             [("conditional-user-attribute", NO_AGG_ID, n("aggregator-portal-cond-no-aggregator-id")),
              ("conditional-user-role", NOT_OWNER, n("aggregator-portal-cond-not-owner"))],
             DENY_ENTITLED, n("aggregator-portal-deny-not-entitled"))
        gate(FORMS, n("aggregator-portal-gate-otp-approved"),
             "Deny before OTP dispatch: a coordinator not approved yet.",
             [("conditional-user-attribute", HAS_AGG_ID, n("aggregator-portal-cond-has-aggregator-id")),
              ("conditional-user-attribute", NOT_APPROVED, n("aggregator-portal-cond-not-approved"))],
             DENY_APPROVED, n("aggregator-portal-deny-not-approved"))
        add_exec(FORMS, "otp-channel-choice-form", "REQUIRED", OTP_CHOICE,
                 n("aggregator-portal-otp-choice-config"))

        gate(PORTAL_FLOW, n("aggregator-portal-gate-sso-entitled"),
             "Entitlement gate on the auth-cookie path (shared-realm SSO bypass).",
             [("conditional-user-attribute", NO_AGG_ID, n("aggregator-portal-cond-no-aggregator-id-sso")),
              ("conditional-user-role", NOT_OWNER, n("aggregator-portal-cond-not-owner-sso"))],
             DENY_ENTITLED, n("aggregator-portal-deny-not-entitled-sso"))
        gate(PORTAL_FLOW, n("aggregator-portal-gate-sso-approved"),
             "Approval gate on the auth-cookie path.",
             [("conditional-user-attribute", HAS_AGG_ID, n("aggregator-portal-cond-has-aggregator-id-sso")),
              ("conditional-user-attribute", NOT_APPROVED, n("aggregator-portal-cond-not-approved-sso"))],
             DENY_APPROVED, n("aggregator-portal-deny-not-approved-sso"))

        # --- verify BEFORE the client is pointed at it --------------------------
        verify(PORTAL_FLOW)

        # --- swap: single PUT, gated tree already complete ----------------------
        new_id = [f for f in flows() if f["alias"] == PORTAL_FLOW][0]["id"]
        bind(new_id)
        now = req("GET", f"{C}/{CID}", tok=TOK)[1].get("authenticationFlowBindingOverrides") or {}
        assert now.get("browser") == new_id, ("rebind did not stick", now)
        print(f"  bound aggregator-portal browser flow -> {new_id} "
              f"(pinned id honoured: {new_id == FLOW_ID})")
    except Exception as e:
        # Nothing destructive has run yet: the client is still on its entry-time
        # binding, or we restore it here if the failing step was the rebind.
        print(f"\n  !! apply failed: {type(e).__name__}: {e}", file=sys.stderr)
        try:
            bind(PREV_BINDING.get("browser", ""))
            restored = PREV_BINDING.get("browser") or "(none — realm default)"
            print(f"  restored previous browser binding: {restored}", file=sys.stderr)
        except Exception as e2:
            print(f"  !! could not restore previous binding: {e2}", file=sys.stderr)
        if not PREV_BINDING.get("browser"):
            print("\n*** GATE NOT APPLIED — aggregator-portal is on the UNGATED default "
                  "browser flow. Ineligible users can be sent OTPs. Re-run this script "
                  "before exposing the portal. ***", file=sys.stderr)
        else:
            print("\n*** GATE NOT APPLIED — aggregator-portal is still bound to its "
                  "previous flow; no change took effect. Re-run this script. ***",
                  file=sys.stderr)
        sys.exit(1)

    # --- retire superseded generations (client is already on the new tree) -------
    # Children are not cascade-deleted, and a stale alias would block a later run.
    for f in flows():
        if f["alias"].startswith(ALIAS_PREFIX) and f["alias"] not in NEW_ALIASES:
            st, _ = req("DELETE", f"{A}/flows/{f['id']}", tok=TOK)
            print(f"  removed superseded flow {f['alias']} -> HTTP {st}")

    print("\nFinal structure:")
    for e in executions(PORTAL_FLOW):
        print(f"  lvl{e['level']} idx{e['index']} | {e.get('displayName')} | {e['requirement']} | {e.get('providerId') or 'SUBFLOW'}")


if __name__ == "__main__":
    main()
