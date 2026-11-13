package rbac_test

import data.rbac
import rego.v1

# Every shared vector gives the expected decision. The same file runs in
# packages/rbac/src/__tests__/vectors.test.ts against the TypeScript mirror.
test_shared_vectors if {
	every v in data.rbac_vectors {
		got := rbac.decision with input as v.input
		got == v.expected
	}
}

test_vectors_present if count(data.rbac_vectors) > 0

test_empty_input_denies if {
	got := rbac.decision with input as {}
	got.allow == false
}

all_capabilities := [
	"profiles.view", "profiles.export", "profiles.view_pii", "profiles.onboard",
	"profiles.verify", "profiles.retire", "profiles.move", "profiles.act_on_behalf",
	"campaigns.run", "orgs.onboard", "orgs.block", "org.manage",
	"contact.unmask", "agreement.manage", "network.administer",
]

# For every vector's actor and organisation, the permission list equals
# exactly the permissions a single decision allows.
test_capabilities_agree_with_decisions if {
	every v in data.rbac_vectors {
		list_input := {"actor": v.input.actor, "org": v.input.org, "candidates": all_capabilities}
		listed := rbac.capabilities with input as list_input
		allowed := {c |
			some c in all_capabilities
			d := rbac.decision with input as {"actor": v.input.actor, "org": v.input.org, "capability": c}
			d.allow
		}
		listed == allowed
	}
}

test_capabilities_empty_for_inactive if {
	listed := rbac.capabilities with input as {
		"actor": {"active": false, "permissions": ["profiles.view"]},
		"org": {"id": "A", "orgType": "aggregator"},
		"candidates": ["profiles.view"],
	}
	count(listed) == 0
}

test_no_personal_data_listed_through_root if {
	listed := rbac.capabilities with input as {
		"actor": {"active": true, "permissions": ["profiles.view", "profiles.view_pii"]},
		"org": {"id": "NF", "orgType": "network_facilitator"},
		"candidates": ["profiles.view", "profiles.view_pii"],
	}
	listed == {"profiles.view"}
}
