/**
 * SITE-INTEGRATION-001 Slice A: the one new port production identity
 * resolution composes against. Provider-neutral by design (no vendor SDK
 * type, no credential shape) - this repository still selects no real
 * external identity provider; this interface only defines the trust
 * boundary a future provider-specific adapter must satisfy.
 *
 * `verify` receives ONLY the caller-supplied session token - never a
 * route/query/body/cookie value naming a tenant, customer, or project.
 * Those identifiers may only ever originate from the `VerifiedIdentityAssertion`
 * this function itself returns, never from anything else the caller sent.
 */
export interface VerifiedIdentityAssertion {
  readonly principalId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly displayName: string;
  readonly projectId?: string;
  readonly issuedAt: string;
}

export interface IdentityVerifier {
  verify(sessionToken: string): VerifiedIdentityAssertion | undefined;
}
