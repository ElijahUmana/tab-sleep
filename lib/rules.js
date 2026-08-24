// URL/domain/regex allowlist and denylist rules plus temporary keep-awake
// grants. Pure functions only — the engine owns storage; policy.js consumes
// these helpers inside its gate walk so every decision carries a reason code.

export const RULE_TYPES = Object.freeze({ DOMAIN: "domain", URL_PREFIX: "url-prefix", REGEX: "regex" });
export const RULE_LISTS = Object.freeze({ ALLOW: "allow", DENY: "deny" });
export const KEEP_AWAKE_SCOPES = Object.freeze({ TAB: "tab", DOMAIN: "domain", WINDOW: "window", GROUP: "group", DURATION: "duration" });

export const DEFAULT_RULE_SETTINGS = Object.freeze({
  denylistEnabled: true,
  allowlistEnabled: false
});

export const TEMPORARY_GRANT_MAX_MINUTES = 480;

function normalizePattern(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeRules(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const normalizeList = (value) => Array.isArray(value)
    ? value
        .map((rule) => {
          if (!rule || typeof rule !== "object") return null;
          const type = Object.values(RULE_TYPES).includes(rule.type) ? rule.type : null;
          const pattern = normalizePattern(rule.pattern);
          if (!type || !pattern) return null;
          let regexSource = null;
          if (type === RULE_TYPES.REGEX) {
            try { new RegExp(pattern); } catch { return null; }
            regexSource = pattern;
          }
          return { type, pattern, ...(regexSource ? { regexSource } : {}) };
        })
        .filter(Boolean)
    : [];
  return {
    denylistEnabled: typeof source.denylistEnabled === "boolean" ? source.denylistEnabled : DEFAULT_RULE_SETTINGS.denylistEnabled,
    allowlistEnabled: typeof source.allowlistEnabled === "boolean" ? source.allowlistEnabled : DEFAULT_RULE_SETTINGS.allowlistEnabled,
    allow: normalizeList(source.allow),
    deny: normalizeList(source.deny)
  };
}

export function urlMatchesRule(url, rule) {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    if (rule.type === RULE_TYPES.DOMAIN) {
      const pattern = rule.pattern.toLowerCase();
      return parsed.hostname === pattern || parsed.hostname.endsWith(`.${pattern}`);
    }
    if (rule.type === RULE_TYPES.URL_PREFIX) {
      // Compare on the normalized origin + path so a prefix without the
      // scheme still matches both http and https variants.
      const candidate = `${parsed.host}${parsed.pathname}`;
      const prefix = rule.pattern.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      const rest = candidate.slice(prefix.length);
      // "/guides" must not match prefix "/guide" — require a path boundary
      // unless the candidate ends exactly at the prefix.
      return candidate.toLowerCase().startsWith(prefix.toLowerCase()) && (rest === "" || rest.startsWith("/"));
    }
    if (rule.type === RULE_TYPES.REGEX) return new RegExp(rule.pattern).test(url);
  } catch {}
  return false;
}

export function firstMatchingRule(url, list) {
  for (const rule of list) {
    if (urlMatchesRule(url, rule)) return rule;
  }
  return null;
}

export function evaluateRules(url, rules) {
  const normalized = normalizeRules(rules);
  // Deny wins: when both lists match the same URL the tab stays sleepable.
  if (normalized.denylistEnabled && firstMatchingRule(url, normalized.deny)) return "deny-rule";
  if (normalized.allowlistEnabled && firstMatchingRule(url, normalized.allow)) return "allow-rule";
  return null;
}

export function normalizeGrants(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : 0;
  const grants = {};
  const source = input.grants && typeof input.grants === "object" ? input.grants : {};
  for (const [key, grant] of Object.entries(source)) {
    if (!grant || typeof grant !== "object") continue;
    const scope = Object.values(KEEP_AWAKE_SCOPES).includes(grant.scope) ? grant.scope : null;
    if (!scope) continue;
    const expiresAt = Number.isFinite(grant.expiresAt) ? grant.expiresAt : Infinity;
    if (expiresAt <= now) continue;
    grants[key] = { scope, createdAt: Number.isFinite(grant.createdAt) ? grant.createdAt : now, expiresAt };
  }
  return grants;
}

export function grantKey(scope, value) {
  return `${scope}:${String(value ?? "")}`;
}

// A tab matches a grant when any of its identities collide with an active
// grant of that scope. `context` supplies everything the tab could belong to:
// { tabId, domain, windowId, groupId }.
export function matchingGrantKeys(context, grants, now) {
  const hits = [];
  if (!Number.isInteger(context?.tabId)) return hits;
  for (const [key, grant] of Object.entries(grants ?? {})) {
    if (grant.expiresAt <= now) continue;
    if (grant.scope === KEEP_AWAKE_SCOPES.TAB && key === grantKey(KEEP_AWAKE_SCOPES.TAB, context.tabId)) hits.push(key);
    if (grant.scope === KEEP_AWAKE_SCOPES.DOMAIN && context.domain && key === grantKey(KEEP_AWAKE_SCOPES.DOMAIN, context.domain)) hits.push(key);
    if (grant.scope === KEEP_AWAKE_SCOPES.WINDOW && Number.isInteger(context.windowId) && key === grantKey(KEEP_AWAKE_SCOPES.WINDOW, context.windowId)) hits.push(key);
    if (grant.scope === KEEP_AWAKE_SCOPES.GROUP && Number.isInteger(context.groupId) && key === grantKey(KEEP_AWAKE_SCOPES.GROUP, context.groupId)) hits.push(key);
  }
  return hits;
}
