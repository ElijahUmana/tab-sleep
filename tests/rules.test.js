import assert from "node:assert/strict";
import test from "node:test";
import {
  KEEP_AWAKE_SCOPES,
  evaluateRules,
  firstMatchingRule,
  grantKey,
  matchingGrantKeys,
  normalizeGrants,
  normalizeRules,
  urlMatchesRule
} from "../lib/rules.js";

test("normalizeRules drops malformed entries and invalid regex", () => {
  const rules = normalizeRules({
    allowlistEnabled: "yes",
    denylistEnabled: false,
    allow: [
      { type: "domain", pattern: " example.com " },
      { type: "bogus", pattern: "x" },
      { type: "regex", pattern: "(" },
      null
    ],
    deny: [{ type: "url-prefix", pattern: "https://news.example.com/tech" }]
  });
  // Non-boolean flags fall back to their defaults (allow off, deny on).
  assert.equal(rules.allowlistEnabled, false);
  assert.equal(rules.denylistEnabled, false);
  assert.deepEqual(rules.allow, [{ type: "domain", pattern: "example.com" }]);
  assert.deepEqual(rules.deny, [{ type: "url-prefix", pattern: "https://news.example.com/tech" }]);
});

test("domain rule matches host and subdomains only", () => {
  const rule = { type: "domain", pattern: "example.com" };
  assert.equal(urlMatchesRule("https://example.com/a", rule), true);
  assert.equal(urlMatchesRule("https://api.example.com/b", rule), true);
  assert.equal(urlMatchesRule("https://notexample.com/", rule), false);
  assert.equal(urlMatchesRule("https://example.com.evil.io/", rule), false);
});

test("URL prefix rule matches path prefix on both schemes", () => {
  const rule = { type: "url-prefix", pattern: "https://docs.example.com/guide" };
  assert.equal(urlMatchesRule("https://docs.example.com/guide/intro", rule), true);
  assert.equal(urlMatchesRule("http://docs.example.com/guide/x", rule), true);
  assert.equal(urlMatchesRule("https://docs.example.com/guides", rule), false);
});

test("regex rule tests the full URL and rejects invalid patterns in normalizeRules", () => {
  const rules = normalizeRules({ deny: [{ type: "regex", pattern: "\\.pdf$" }] });
  assert.equal(firstMatchingRule("https://a.example/doc.pdf", rules.deny[0] ? rules.deny : [])?.pattern, "\\.pdf$");
  assert.equal(normalizeRules({ deny: [{ type: "regex", pattern: "[" }] }).deny.length, 0);
});

test("evaluateRules honors enable flags with deny winning over allow", () => {
  const both = normalizeRules({
    allowlistEnabled: true,
    denylistEnabled: true,
    allow: [{ type: "domain", pattern: "example.com" }],
    deny: [{ type: "domain", pattern: "example.com" }]
  });
  assert.equal(evaluateRules("https://example.com/", both), "deny-rule");
  const allowOnly = normalizeRules({ allowlistEnabled: true, allow: [{ type: "domain", pattern: "example.com" }], denylistEnabled: false });
  assert.equal(evaluateRules("https://example.com/", allowOnly), "allow-rule");
  assert.equal(evaluateRules("https://other.com/", allowOnly), null);
});

test("expired grants are pruned by normalizeGrants", () => {
  const grants = normalizeGrants({
    now: 1000,
    grants: {
      "tab:5": { scope: "tab", expiresAt: 999 },
      "domain:a.com": { scope: "domain", expiresAt: 2000 },
      "window:1": { scope: "window" }
    }
  });
  assert.deepEqual(Object.keys(grants).sort(), ["domain:a.com", "window:1"]);
});

test("matchingGrantKeys hits every colliding scope for a tab context", () => {
  const now = 5000;
  const grants = normalizeGrants({
    now,
    grants: {
      [grantKey(KEEP_AWAKE_SCOPES.TAB, 7)]: { scope: "tab", expiresAt: Infinity },
      [grantKey(KEEP_AWAKE_SCOPES.DOMAIN, "a.com")]: { scope: "domain", expiresAt: Infinity },
      [grantKey(KEEP_AWAKE_SCOPES.WINDOW, 2)]: { scope: "window", expiresAt: Infinity },
      [grantKey(KEEP_AWAKE_SCOPES.GROUP, 9)]: { scope: "group", expiresAt: now - 1 },
      [grantKey(KEEP_AWAKE_SCOPES.DOMAIN, "b.com")]: { scope: "domain", expiresAt: Infinity }
    }
  });
  const hits = matchingGrantKeys({ tabId: 7, domain: "a.com", windowId: 2, groupId: 9 }, grants, now);
  assert.deepEqual(hits.sort(), ["domain:a.com", "tab:7", "window:2"]);
});
