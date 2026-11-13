"""Unit tests for apply-portal-gate.py's verifier (no Keycloak needed).

Run: python3 -m unittest infra/keycloak/init/test_apply_portal_gate.py

The verifier decides whether a live realm's gate is rebuilt, so it must reject
the pre-Phase-5 coordinator-only tree (design R2) and accept the tree the
script builds.
"""
import importlib.util
import json
import os
import unittest

_spec = importlib.util.spec_from_file_location(
    "apply_portal_gate", os.path.join(os.path.dirname(__file__), "apply-portal-gate.py"))
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

ATTR = "conditional-user-attribute"
ROLE = "conditional-user-role"
DENY = "deny-access-authenticator"


def flat(tree):
    """Flattens [(display, provider, requirement, config, children)] like the admin API."""
    out, configs = [], {}

    def walk(nodes, level):
        for display, provider, requirement, config, children in nodes:
            ex = {"displayName": display, "providerId": provider,
                  "requirement": requirement, "level": level}
            if config is not None:
                ex["authenticationConfig"] = f"cfg-{len(configs)}"
                configs[ex["authenticationConfig"]] = config
            out.append(ex)
            walk(children, level + 1)

    walk(tree, 0)
    return out, lambda e: configs.get(e.get("authenticationConfig"), {})


def entitled(name, role_negate="true", with_role=True):
    conds = [(ATTR, ATTR, "REQUIRED", gate.NO_AGG_ID, [])]
    if with_role:
        conds.append((ROLE, ROLE, "REQUIRED", {"condUserRole": "org_owner", "negate": role_negate}, []))
    return (name, None, "CONDITIONAL", None,
            conds + [(DENY, DENY, "REQUIRED", {"denyErrorMessage": "x"}, [])])


def approved(name, has=True):
    conds = []
    if has:
        conds.append((ATTR, ATTR, "REQUIRED", gate.HAS_AGG_ID, []))
    conds.append((ATTR, ATTR, "REQUIRED", gate.NOT_APPROVED, []))
    return (name, None, "CONDITIONAL", None,
            conds + [(DENY, DENY, "REQUIRED", {"denyErrorMessage": "x"}, [])])


def tree(otp_gates, sso_gates, gates_after_choice=False):
    choice = ("otp-channel-choice-form", "otp-channel-choice-form", "REQUIRED", {}, [])
    forms_children = [("otp-identifier-form", "otp-identifier-form", "REQUIRED", None, [])]
    forms_children += ([choice] + otp_gates) if gates_after_choice else (otp_gates + [choice])
    return [
        ("aggregator-portal-auth", None, "REQUIRED", None, [
            ("auth-cookie", "auth-cookie", "ALTERNATIVE", None, []),
            ("aggregator-portal-otp-forms", None, "ALTERNATIVE", None, forms_children),
        ]),
    ] + sso_gates


def new_tree(**kw):
    return tree(
        [entitled("aggregator-portal-gate-otp-entitled"), approved("aggregator-portal-gate-otp-approved")],
        [entitled("aggregator-portal-gate-sso-entitled"), approved("aggregator-portal-gate-sso-approved")],
        **kw)


def old_gate(name, config):
    return (name, None, "CONDITIONAL", None, [
        (ATTR, ATTR, "REQUIRED", config, []),
        (DENY, DENY, "REQUIRED", {"denyErrorMessage": "x"}, []),
    ])


class VerifyTree(unittest.TestCase):
    def verify(self, t):
        exs, config_of = flat(t)
        gate.verify_tree(exs, config_of)

    def test_accepts_the_built_tree(self):
        self.verify(new_tree())

    def test_accepts_a_later_generation(self):
        t = tree(
            [entitled("aggregator-portal-gate-otp-entitled-g3"), approved("aggregator-portal-gate-otp-approved-g3")],
            [entitled("aggregator-portal-gate-sso-entitled-g3"), approved("aggregator-portal-gate-sso-approved-g3")])
        self.verify(t)

    def test_rejects_the_pre_phase5_coordinator_only_tree(self):
        t = tree(
            [old_gate("aggregator-portal-gate-otp-coordinator", gate.NO_AGG_ID),
             old_gate("aggregator-portal-gate-otp-approved", gate.NOT_APPROVED)],
            [old_gate("aggregator-portal-gate-sso-coordinator", gate.NO_AGG_ID),
             old_gate("aggregator-portal-gate-sso-approved", gate.NOT_APPROVED)])
        with self.assertRaises(AssertionError):
            self.verify(t)

    def test_rejects_an_un_negated_owner_condition(self):
        t = tree(
            [entitled("aggregator-portal-gate-otp-entitled", role_negate="false"),
             approved("aggregator-portal-gate-otp-approved")],
            [entitled("aggregator-portal-gate-sso-entitled"), approved("aggregator-portal-gate-sso-approved")])
        with self.assertRaises(AssertionError):
            self.verify(t)

    def test_rejects_an_approval_gate_that_would_deny_owners(self):
        # Without "has aggregator_id", every owner (no decision) is denied.
        t = tree(
            [entitled("aggregator-portal-gate-otp-entitled"),
             approved("aggregator-portal-gate-otp-approved", has=False)],
            [entitled("aggregator-portal-gate-sso-entitled"), approved("aggregator-portal-gate-sso-approved")])
        with self.assertRaises(AssertionError):
            self.verify(t)

    def test_rejects_gates_after_otp_dispatch(self):
        with self.assertRaises(AssertionError):
            self.verify(new_tree(gates_after_choice=True))


class RealmJson(unittest.TestCase):
    """realm.json (a fresh import) must carry the same gate the script builds."""

    def test_realm_json_gate_passes_the_verifier(self):
        path = os.path.join(os.path.dirname(__file__), "..", "realms", "realm.json")
        with open(path, encoding="utf-8") as f:
            realm = json.load(f)
        flows = {fl["alias"]: fl for fl in realm["authenticationFlows"]}
        configs = {c["alias"]: c["config"] for c in realm["authenticatorConfig"]}
        out = []

        def walk(alias, level):
            for e in sorted(flows[alias]["authenticationExecutions"], key=lambda x: x["priority"]):
                if e.get("authenticatorFlow"):
                    out.append({"displayName": e["flowAlias"], "providerId": None,
                                "requirement": e["requirement"], "level": level})
                    walk(e["flowAlias"], level + 1)
                else:
                    out.append({"displayName": e["authenticator"], "providerId": e["authenticator"],
                                "requirement": e["requirement"], "level": level,
                                "cfg": e.get("authenticatorConfig")})

        walk("aggregator-portal-browser", 0)
        gate.verify_tree(out, lambda e: configs.get(e.get("cfg"), {}), "realm.json")

    def test_flow_descriptions_fit_keycloak(self):
        # Keycloak stores a flow description in VARCHAR(255): a longer one
        # fails the whole realm import ("Database operation failed").
        path = os.path.join(os.path.dirname(__file__), "..", "realms", "realm.json")
        with open(path, encoding="utf-8") as f:
            realm = json.load(f)
        too_long = [fl["alias"] for fl in realm["authenticationFlows"]
                    if len(fl.get("description", "")) > 255]
        self.assertEqual(too_long, [])


if __name__ == "__main__":
    unittest.main()
