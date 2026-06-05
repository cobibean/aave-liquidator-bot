const SENSITIVE_ASSIGNMENT =
  /\b(private_key|secret|token|api[_-]?key|authorization|password|passwd|rpc[_-]?url|digitalocean_api_token|do_api_token)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AUTH_HEADER = /\bAuthorization\s*:\s*(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const URL_CREDENTIALS = /\b(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const SENSITIVE_QUERY = /([?&](?:api[_-]?key|apikey|key|token|access_token|auth|signature|sig)=)[^&\s]+/gi;
const LONG_SECRET = /\b(?!0x[a-fA-F0-9]{40,}\b)[A-Za-z0-9_-]{40,}\b/g;

function redact(input) {
  if (input === null || input === undefined) {
    return input;
  }

  return String(input)
    .replace(AUTH_HEADER, "Authorization: $1 [REDACTED]")
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(SENSITIVE_QUERY, "$1[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, (_match, key) => `${key}=[REDACTED]`)
    .replace(LONG_SECRET, "[REDACTED_LONG_SECRET]");
}

function redactObject(value) {
  if (typeof value === "string") {
    return redact(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactObject);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactObject(item)])
    );
  }

  return value;
}

module.exports = {
  redact,
  redactObject,
};
