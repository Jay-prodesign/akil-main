import { requireInternalOsAccess, type StaffAccessGrant } from "./internal-os-access.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import type { Organization } from "../domain/organization.js";
import {
  createProtectedDecisionRecord,
  reviseProtectedDecisionRecord,
  type ProtectedDecisionRecord,
} from "../domain/protected-decision-record.js";

type CreateDomainInput = Parameters<typeof createProtectedDecisionRecord>[0];
type ReviseDomainInput = Parameters<typeof reviseProtectedDecisionRecord>[0];

interface StaffIngress {
  readonly organization: Organization;
  readonly provider: StaffSessionProvider;
  readonly sessionToken: string | undefined;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
}

/**
 * Rev188 F3-item4 (authenticated decision-record ingress): `createProtectedDecisionRecord`/
 * `reviseProtectedDecisionRecord` (`protected-decision-record.ts`) each
 * re-resolve `EffectiveAccessResolution` fresh from raw ingredients
 * immediately before use (Rev188 item4's own fix to that domain module),
 * but - mirroring every other consumer of `resolveEffectiveOrganizationAccess`
 * in this repository - neither authenticates `currentPrincipalRef` itself.
 * These are the missing application boundaries, exactly mirroring
 * `connector-connection-admin-access.ts` (Rev188 F2) and
 * `resume-protected-decision-admin-access.ts` (Rev188 item2): authenticate
 * the staff session first (`requireInternalOsAccess`), THEN hand the
 * domain function the now-proven `membership`/`currentPrincipalRef`/
 * `roleContext` for its own independent re-resolution. A forged identity
 * fails inside `requireInternalOsAccess` itself, before either domain
 * function is ever reached.
 */
export function createProtectedDecisionRecordAsAuthenticatedStaff(
  input: Omit<CreateDomainInput, "organization" | "membership" | "currentPrincipalRef" | "roleContext"> & StaffIngress,
): ProtectedDecisionRecord {
  const context = requireInternalOsAccess({
    provider: input.provider,
    sessionToken: input.sessionToken,
    organization: input.organization,
    grants: input.grants,
  });
  const { provider, sessionToken, grants, organization, ...rest } = input;
  return createProtectedDecisionRecord({
    ...rest,
    organization,
    membership: context.membership,
    currentPrincipalRef: context.session.principal.principalId,
    ...(context.grant.roleContext !== undefined ? { roleContext: context.grant.roleContext } : {}),
  });
}

export function reviseProtectedDecisionRecordAsAuthenticatedStaff(
  input: Omit<ReviseDomainInput, "organization" | "membership" | "currentPrincipalRef" | "roleContext"> & StaffIngress,
): ProtectedDecisionRecord {
  const context = requireInternalOsAccess({
    provider: input.provider,
    sessionToken: input.sessionToken,
    organization: input.organization,
    grants: input.grants,
  });
  const { provider, sessionToken, grants, organization, ...rest } = input;
  return reviseProtectedDecisionRecord({
    ...rest,
    organization,
    membership: context.membership,
    currentPrincipalRef: context.session.principal.principalId,
    ...(context.grant.roleContext !== undefined ? { roleContext: context.grant.roleContext } : {}),
  });
}
