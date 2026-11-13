# Tests for the edge decision (edge.rego). Most cases use a small route table
# and catalogue; the last group runs against the generated routes.json.

package rbac.edge_test

import rego.v1

import data.rbac.edge

routes := {
	"version": 1,
	"unchecked_prefixes": ["/documentation"],
	"routes": [
		{"method": "GET", "path": "/v1/aggregator-config", "access": {"access": "public"}},
		{"method": "POST", "path": "/admin/v1/invites", "access": {"access": "link_token"}},
		{"method": "GET", "path": "/v1/orgs", "access": {"access": "service"}},
		{"method": "GET", "path": "/v1/user/read/me", "access": {"access": "signed_in"}},
		{"method": "GET", "path": "/v1/user/read/:id", "access": {"anyCapability": ["org.manage", "network.administer"]}},
		{"method": "POST", "path": "/v1/links/create", "access": {"capability": "profiles.onboard"}},
		{"method": "POST", "path": "/v1/roles/create", "access": {"capability": "network.administer", "strict": true}},
	],
}

catalogue(mode) := {
	"mode": mode,
	"roles": {
		"coordinator": {"permissions": ["profiles.view", "profiles.onboard", "campaigns.run"]},
		"org_admin": {"permissions": ["profiles.view", "org.manage", "contact.unmask", "orgs.onboard"]},
		"network_admin": {"permissions": ["network.administer", "orgs.onboard"]},
		"pii_access": {"permissions": ["profiles.view_pii"]},
	},
}

req(method, path, payload) := {"attributes": {
	"request": {"http": {"method": method, "path": path, "headers": {"x-request-id": "req-1"}}},
	# The shape the opa-envoy-plugin hands OPA (protobuf JSON names), as captured
	# from a real Envoy with jwt_authn `payload_in_metadata: jwt_payload`.
	"metadataContext": {"filterMetadata": {"envoy.filters.http.jwt_authn": {"jwt_payload": payload}}},
}}

anon(method, path) := {"attributes": {"request": {"http": {"method": method, "path": path, "headers": {}}}}}

user(roles) := {"sub": "u1", "preferred_username": "someone", "roles": roles}

decide(i, mode) := d if {
	d := edge.decision with input as i
		with data.edge as routes
		with data.catalogue as catalogue(mode)
}

body(d) := json.unmarshal(d.body).error

# ── Public, link and plugin routes ──────────────────────────────────────────

test_public_route_needs_no_token if decide(anon("GET", "/v1/aggregator-config"), "enforce").allowed

test_link_token_route_needs_no_token if decide(anon("POST", "/admin/v1/invites"), "enforce").allowed

test_unchecked_prefix_is_allowed if decide(anon("GET", "/documentation/json"), "enforce").allowed

# ── Capability routes ───────────────────────────────────────────────────────

test_role_with_the_permission_is_allowed if {
	d := decide(req("POST", "/v1/links/create", user(["coordinator"])), "enforce")
	d.allowed
	d.dynamic_metadata.rbac_edge.outcome == "allow"
}

test_role_without_the_permission_is_refused if {
	d := decide(req("POST", "/v1/links/create", user(["pii_access"])), "enforce")
	not d.allowed
	d.http_status == 403
	b := body(d)
	b.code == "FORBIDDEN"
	b.title == "Access denied"
	b.fields.permission == "profiles.onboard"
	b.requestId == "req-1"
	d.headers["x-request-id"] == "req-1"
}

test_any_capability_is_allowed_with_one_of_them if {
	decide(req("GET", "/v1/user/read/abc", user(["network_admin"])), "enforce").allowed
}

test_any_capability_is_refused_with_none if {
	d := decide(req("GET", "/v1/user/read/abc", user(["coordinator"])), "enforce")
	d.http_status == 403
	body(d).fields.permission == "org.manage|network.administer"
}

test_permissions_are_the_union_over_roles if {
	decide(req("POST", "/v1/links/create", user(["pii_access", "coordinator"])), "enforce").allowed
}

test_unknown_role_keys_grant_nothing if {
	decide(req("POST", "/v1/links/create", user(["superuser"])), "enforce").http_status == 403
}

# The proto field names are not what the plugin sends; a token there is not seen.
test_snake_case_metadata_is_not_a_token if {
	i := {"attributes": {
		"request": {"http": {"method": "POST", "path": "/v1/links/create", "headers": {}}},
		"metadata_context": {"filter_metadata": {"envoy.filters.http.jwt_authn": {"jwt_payload": user(["coordinator"])}}},
	}}
	decide(i, "enforce").http_status == 401
}

test_missing_token_on_a_protected_route_is_401 if {
	d := decide(anon("POST", "/v1/links/create"), "enforce")
	d.http_status == 401
	b := body(d)
	b.code == "UNAUTHORIZED"
	b.fields.permission == "profiles.onboard"
}

test_a_single_role_as_a_string_is_accepted if {
	decide(req("POST", "/v1/links/create", user("coordinator")), "enforce").allowed
}

# ── Service and signed-in routes ────────────────────────────────────────────

test_service_route_accepts_a_service_account if {
	payload := {"sub": "x", "preferred_username": "service-account-aggregator-bff"}
	decide(req("GET", "/v1/orgs", payload), "enforce").allowed
}

test_service_route_refuses_an_end_user if {
	d := decide(req("GET", "/v1/orgs", user(["network_admin"])), "enforce")
	d.http_status == 403
	body(d).fields.permission == "service"
}

test_signed_in_needs_at_least_one_role if {
	decide(req("GET", "/v1/user/read/me", user(["coordinator"])), "enforce").allowed
	d := decide(req("GET", "/v1/user/read/me", user([])), "enforce")
	d.http_status == 403
	body(d).fields.permission == "signed_in"
}

# ── Route matching ──────────────────────────────────────────────────────────

test_static_segment_beats_a_parameter if {
	# /v1/user/read/me is `signed_in`, not the any-capability /:id route.
	d := decide(req("GET", "/v1/user/read/me", user(["coordinator"])), "enforce")
	d.allowed
	d.dynamic_metadata.rbac_edge.route == "/v1/user/read/me"
}

test_an_encoded_static_segment_matches_the_static_route if {
	# Fastify serves /v1/user/read/m%65 as /v1/user/read/me, so the edge decides it as that route.
	d := decide(req("GET", "/v1/user/read/m%65", user(["coordinator"])), "enforce")
	d.allowed
	d.dynamic_metadata.rbac_edge.route == "/v1/user/read/me"
}

test_an_encoded_static_segment_is_held_to_its_own_permission if {
	d := decide(req("POST", "/v1/links/cr%65ate", user(["org_admin"])), "enforce")
	d.http_status == 403
	d.dynamic_metadata.rbac_edge.permission == "profiles.onboard"
}

test_an_encoded_slash_stays_inside_one_segment if {
	d := decide(req("GET", "/v1/user/read/a%2Fb", user(["org_admin"])), "enforce")
	d.allowed
	d.dynamic_metadata.rbac_edge.route == "/v1/user/read/:id"
}

test_a_plus_is_not_a_space if {
	d := decide(req("GET", "/v1/user/read/a+b", user(["org_admin"])), "enforce")
	d.dynamic_metadata.rbac_edge.route == "/v1/user/read/:id"
}

test_an_invalid_escape_is_404 if {
	decide(req("GET", "/v1/user/read/%zz", user(["network_admin"])), "enforce").http_status == 404
}

test_head_is_decided_as_get if decide(anon("HEAD", "/v1/aggregator-config"), "enforce").allowed

test_query_string_is_ignored if {
	decide(req("POST", "/v1/links/create?x=1", user(["coordinator"])), "enforce").allowed
}

test_a_parameter_needs_a_value if {
	decide(req("GET", "/v1/user/read/", user(["network_admin"])), "enforce").http_status == 404
}

test_unknown_route_is_404 if {
	d := decide(req("GET", "/v1/nope", user(["network_admin"])), "enforce")
	d.http_status == 404
	b := body(d)
	b.code == "NOT_FOUND"
	not b.fields
}

test_method_must_match if {
	decide(req("GET", "/v1/links/create", user(["coordinator"])), "enforce").http_status == 404
}

# ── Modes ───────────────────────────────────────────────────────────────────

test_log_mode_allows_and_records_a_would_deny if {
	d := decide(req("POST", "/v1/links/create", user(["pii_access"])), "log")
	d.allowed
	d.dynamic_metadata.rbac_edge.outcome == "would_deny"
	d.dynamic_metadata.rbac_edge.permission == "profiles.onboard"
}

test_log_mode_still_refuses_a_strict_route if {
	d := decide(req("POST", "/v1/roles/create", user(["coordinator"])), "log")
	not d.allowed
	d.http_status == 403
}

test_off_mode_allows_everything if {
	decide(req("POST", "/v1/roles/create", user([])), "off").allowed
	decide(anon("GET", "/v1/nope"), "off").allowed
}

test_unknown_mode_falls_back_to_enforce if {
	d := decide(req("POST", "/v1/links/create", user(["pii_access"])), "sometimes")
	d.http_status == 403
}

# ── Catalogue not pushed yet ────────────────────────────────────────────────

test_without_a_catalogue_capability_routes_are_refused if {
	d := edge.decision with input as req("POST", "/v1/links/create", user(["coordinator"]))
		with data.edge as routes
		with data.catalogue as {}
	d.http_status == 403
}

test_without_a_catalogue_public_routes_still_work if {
	d := edge.decision with input as anon("GET", "/v1/aggregator-config")
		with data.edge as routes
		with data.catalogue as {}
	d.allowed
}

# ── The generated route table (routes.json) ─────────────────────────────────

decide_real(i) := d if {
	d := edge.decision with input as i with data.catalogue as catalogue("enforce")
}

test_real_table_pii_export_needs_pii_access if {
	d := decide_real(req("POST", "/v1/dashboard/export/profiles", user(["coordinator"])))
	d.http_status == 403
	body(d).fields.permission == "profiles.view_pii"
	decide_real(req("POST", "/v1/dashboard/export/profiles", user(["coordinator", "pii_access"]))).allowed
}

test_real_table_decision_needs_org_manage if {
	decide_real(req("POST", "/v1/user/decision/0b1c", user(["org_admin"]))).allowed
	decide_real(req("POST", "/v1/user/decision/0b1c", user(["coordinator"]))).http_status == 403
}

test_real_table_me_is_signed_in if {
	d := decide_real(req("GET", "/v1/user/read/me", user(["coordinator"])))
	d.allowed
	d.dynamic_metadata.rbac_edge.route == "/v1/user/read/me"
}

test_real_table_public_submit_needs_no_token if {
	decide_real(anon("POST", "/public/v1/aggregators/acme/registrations/walk-in")).allowed
}

# ── Route decisions that moved from the API's unit tests (phase 3) ──────────
# These used to be asserted as API 403s in apps/api/src/routes/v1-console.test.ts;
# the API no longer checks route permissions, so they are pinned here against
# the generated route table.

decide_real_mode(i, mode) := d if {
	d := edge.decision with input as i with data.catalogue as catalogue(mode)
}

test_real_table_catalogue_view_is_network_admin_only if {
	every url in ["/v1/rbac/roles", "/v1/rbac/permissions"] {
		owner := decide_real(req("GET", url, user(["org_admin"])))
		owner.http_status == 403
		body(owner).fields.permission == "network.administer"
		decide_real(req("GET", url, user(["coordinator"]))).http_status == 403
		decide_real(req("GET", url, user(["network_admin"]))).allowed
	}
}

test_real_table_owner_cannot_create_a_role if {
	d := decide_real(req("POST", "/v1/roles/create", user(["org_admin"])))
	d.http_status == 403
	body(d).fields.permission == "network.administer"
	decide_real(req("POST", "/v1/roles/create", user(["network_admin"]))).allowed
}

test_real_table_custom_role_writes_are_strict_in_log_mode if {
	decide_real_mode(req("POST", "/v1/roles/create", user(["org_admin"])), "log").http_status == 403
	decide_real_mode(req("POST", "/v1/roles/delete/data_export", user(["org_admin"])), "log").http_status == 403
	decide_real_mode(req("PATCH", "/v1/roles/update/data_export", user(["org_admin"])), "log").http_status == 403
}

test_real_table_org_routes_need_org_manage_or_orgs_onboard if {
	d := decide_real(req("GET", "/v1/org/read/0b1c", user(["coordinator"])))
	d.http_status == 403
	body(d).fields.permission == "org.manage|orgs.onboard"
	decide_real(req("GET", "/v1/org/read/0b1c", user(["org_admin"]))).allowed
	decide_real(req("GET", "/v1/org/read/0b1c", user(["network_admin"]))).allowed
}

test_real_table_known_as_route_needs_org_manage_or_orgs_onboard if {
	d := decide_real(req("PATCH", "/v1/org/known-as/update/0b1c", user(["coordinator"])))
	d.http_status == 403
	body(d).fields.permission == "org.manage|orgs.onboard"
	decide_real(req("PATCH", "/v1/org/known-as/update/0b1c", user(["org_admin"]))).allowed
	decide_real(req("PATCH", "/v1/org/known-as/update/0b1c", user(["network_admin"]))).allowed
}

# Every owner decides and repairs its child orgs; which ones is the API's check.
test_real_table_owner_decides_and_repairs_child_orgs if {
	decide_real(req("POST", "/v1/org/access/repair/0b1c", user(["org_admin"]))).allowed
	decide_real(req("POST", "/v1/org/decision/0b1c", user(["org_admin"]))).allowed
	decide_real(req("POST", "/v1/org/access/repair/0b1c", user(["network_admin"]))).allowed
	decide_real(req("POST", "/v1/org/decision/0b1c", user(["network_admin"]))).allowed
	d := decide_real(req("POST", "/v1/org/decision/0b1c", user(["coordinator"])))
	d.http_status == 403
	body(d).fields.permission == "orgs.onboard"
}

test_real_table_encoded_template_path_keeps_its_permission if {
	# /v1/bulk-uploads/te%6dplate is the template route in Fastify, not /v1/bulk-uploads/:id.
	d := decide_real(req("GET", "/v1/bulk-uploads/te%6dplate", user(["org_admin"])))
	d.http_status == 403
	body(d).fields.permission == "profiles.onboard"
	d.dynamic_metadata.rbac_edge.route == "/v1/bulk-uploads/template"
}
