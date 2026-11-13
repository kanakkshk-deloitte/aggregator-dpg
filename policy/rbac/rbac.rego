# Access decisions for aggregator-dpg.
#
# Query: POST /v1/data/rbac/decision with {"input": DecisionInput}
# (DecisionInput is defined in packages/rbac/src/interface.ts).
#
# Answers "does the actor hold this permission in this organisation". The API
# computes the actor's permissions from their base and additional roles
# (design §3); the policy allows when the actor is active and holds the
# permission, and never allows personal data through the root organisation.
#
# Reach (which targets) is not decided here: the API's scope checks answer it
# after this decision, with 404 (design decision D3).
#
# packages/rbac/src/evaluate.ts mirrors these rules; vectors.json runs
# against both.
package rbac

import rego.v1

not_through_root := {"profiles.view_pii"}

cap := input.capability

held if cap in input.actor.permissions

through_root if {
	cap in not_through_root
	input.org.orgType == "network_facilitator"
}

default allow := false

allow if {
	input.actor.active
	held
	not through_root
}

reasons contains "inactive" if not input.actor.active

reasons contains "not_held" if not held

reasons contains "not_through_root" if through_root

# The candidate permissions the actor holds (input.candidates), each one that
# `decision` would allow. One call for the portal's menus and buttons.
capabilities contains c if {
	some c in input.candidates
	allow with input.capability as c
}

decision := {"allow": true, "reasons": []} if allow

decision := {"allow": false, "reasons": sort(reasons)} if not allow
