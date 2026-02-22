/**
 * Feedback Sanitizer
 *
 * Strips PII and sensitive data from feedback text before local storage
 * or remote submission. Reuses patterns from diagnostics/anonymizer.ts.
 */

/** Regex patterns for sensitive data (subset of anonymizer patterns) */
const PATTERNS = {
  HOME_PATH: /(?:\/Users\/[^\/\s]+|\/home\/[^\/\s]+|C:\\Users\\[^\\]+)/gi,
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  API_KEY: /(?:sk|pk)[_-](?:test|live|or)?[_-]?[a-zA-Z0-9]{10,}/gi,
  JWT: /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g,
  BEARER_TOKEN: /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/gi,
};

/**
 * Sanitize feedback text by removing PII, secrets, code blocks, and env vars.
 */
export function sanitizeFeedbackText(text: string): string {
  return text
    .replace(PATTERNS.HOME_PATH, "[PATH]")
    .replace(PATTERNS.EMAIL, "[EMAIL]")
    .replace(PATTERNS.API_KEY, "[KEY]")
    .replace(PATTERNS.BEARER_TOKEN, "[TOKEN]")
    .replace(PATTERNS.JWT, "[TOKEN]")
    .replace(/```[\s\S]*?```/g, "[CODE_BLOCK]")
    .replace(/\$[A-Z_]+=[^\s]+/g, "[ENV_VAR]");
}
