import { config } from "./config.js";

function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

const devUnlimitedEmails = parseAllowlist(config.DEV_UNLIMITED_EMAILS);

// Dev-team accounts on the DEV_UNLIMITED_EMAILS allowlist bypass the store
// economy limits (ticket cap, ticket-pack purchase cooldown, coin balance).
// Matched case-insensitively so a different-cased login still resolves.
export function isUnlimitedDevEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return devUnlimitedEmails.has(email.trim().toLowerCase());
}
