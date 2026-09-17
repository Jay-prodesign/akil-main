/**
 * APP-I18N-001 (TR-EN Client Portal Localization Floor). `Locale` is a
 * closed, deliberately small set - exactly the two operator locales
 * canonical launch authority currently requires, not a generic
 * internationalization platform. Turkish is the Türkiye-launch primary/
 * default; English is the independently adapted secondary locale.
 */
export type Locale = "tr" | "en";

export const DEFAULT_LOCALE: Locale = "tr";

const RECOGNIZED_LOCALES: ReadonlySet<Locale> = new Set(["tr", "en"]);

/**
 * `Set.has()`-based equality check, never bracket-indexing a lookup table
 * with a caller-supplied value - mirrors this codebase's own established
 * `isRecognized*` guard discipline (e.g. `worker-routing-policy.ts`'s
 * `isRecognizedAuthorityLevel`) so an `Object.prototype`-shaped value
 * (`"constructor"`, `"toString"`, ...) can never resolve through the
 * prototype chain instead of failing the check.
 */
export function isRecognizedLocale(value: unknown): value is Locale {
  return typeof value === "string" && RECOGNIZED_LOCALES.has(value as Locale);
}

/**
 * Deterministic, request-header-only resolution. No session/profile-level
 * locale preference field exists anywhere in this repository yet (a
 * "stronger canonical preference source" per the task contract), so the
 * request's own `Accept-Language` header is the only real signal
 * available today - a missing header, an empty value, or a value naming
 * no recognized locale all resolve identically to the explicit Turkish
 * primary fallback, never to an ambient/system locale or an exception.
 */
export function resolveRequestLocale(headers: Readonly<Record<string, string | undefined>>): Locale {
  const raw = headers["accept-language"];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_LOCALE;
  }
  const primaryTags = raw
    .split(",")
    .map((entry) => entry.split(";")[0]?.trim().toLowerCase().split("-")[0])
    .filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
  for (const tag of primaryTags) {
    if (isRecognizedLocale(tag)) {
      return tag;
    }
  }
  return DEFAULT_LOCALE;
}
