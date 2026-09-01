import type { TenantScope } from "./tenant-scope.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import { resolveCurrentOwner, type OwnershipAssignment } from "./ownership-assignment.js";

/**
 * V3 Workstream E (§8), spine item F - reuses the Workstream B
 * foundation (V3-OWN-001: `OwnershipAssignment`/`resolveCurrentOwner`)
 * for its one reference field. "Commission ledger distinguishes
 * projected / earned-or-eligible / approved / settled-or-paid
 * equivalents only where authoritative financial truth supports them."
 * No commission, billing, or settlement system exists anywhere in this
 * repository (no persistence beyond the existing in-memory adapters, no
 * payment/financial provider integration), so this module deliberately
 * does NOT invent a commission ledger state machine - the single-literal
 * type below makes it structurally impossible to ever claim a known
 * commission ledger state. Same "declared honestly as UNKNOWN, not
 * invented" discipline already established by `ContractualSlaStatus`
 * (V3-SLA-001) and `EtaProjection` (V2-CDO-005).
 */
export type CommissionLedgerStatus = "UNKNOWN";

/**
 * §8: "discount UI/read model can distinguish VIEW_ONLY / RECOMMEND_ONLY
 * / APPROVAL_REQUIRED / COMMIT_ALLOWED equivalents based on authoritative
 * policy." All four states are declared so a future real DEC-146
 * pricing-authority integration can produce any of them, but this
 * checkpoint's own `buildCommercialAuthoritySnapshot` can only ever
 * produce `APPROVAL_REQUIRED` (see below) - `VIEW_ONLY`, `RECOMMEND_ONLY`
 * and `COMMIT_ALLOWED` are reserved for that future integration, the
 * same "declared, not yet producible in this slice" discipline already
 * established by `AssignmentStatus`'s `NOT_APPLICABLE`/`UNKNOWN`
 * (V3-ORG-001).
 */
export type DiscountAuthorityLevel =
  | "VIEW_ONLY"
  | "RECOMMEND_ONLY"
  | "APPROVAL_REQUIRED"
  | "COMMIT_ALLOWED";

/**
 * §8 acceptance direction: "expose commercial state safely without
 * creating a payment engine or inventing policy." This type deliberately
 * carries no commission percentage/basis/attribution/reversal/tax/
 * payout, discount threshold/limit, reseller/wholesale economics or
 * binding SLA term field - those "deferred activation fields" remain
 * unresolved until finance/legal/economic/Founder authority exists
 * (§8), so there is structurally nowhere on this type for them to be
 * invented.
 */
export interface CommercialAuthoritySnapshot {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: ProjectOwnershipRef["customerId"];
  readonly projectId: ProjectOwnershipRef["projectId"];
  readonly commissionLedgerStatus: CommissionLedgerStatus;
  readonly discountAuthorityLevel: DiscountAuthorityLevel;
  readonly dealOwnerMembershipId?: OwnershipAssignment["membershipId"];
}

/**
 * §8: "delivery completion never implies commission settlement/
 * payment." This function does not import `outcome-job.ts` at all -
 * job/delivery state cannot influence `commissionLedgerStatus` even by
 * accident, because there is no parameter through which it could.
 *
 * §8: "no role or ownership label silently grants quote/discount/
 * settlement/payment authority" + "unknown authority fails closed."
 * Absent a real, authoritative DEC-146 pricing-policy integration -
 * which does not exist anywhere in this repository yet -
 * `discountAuthorityLevel` is always `APPROVAL_REQUIRED`: the one level
 * that asserts no standing permission at all, rather than guessing a
 * more permissive one. `dealOwnerMembershipId` is reused directly from
 * V3-OWN-001's `resolveCurrentOwner` (the deal's commercial owner, not a
 * discount/commission authority grant) and is `undefined` - a
 * legitimate "unknown/unassigned" state, never guessed - when no
 * `DEAL_OWNER` assignment exists or no history is supplied. A history
 * entry for a foreign tenant/customer/project is never matched
 * (delegated entirely to `resolveCurrentOwner`'s own exact-scope
 * filtering), so a caller cannot smuggle in an unrelated deal's owner.
 */
export function buildCommercialAuthoritySnapshot(input: {
  ownership: ProjectOwnershipRef;
  dealOwnerHistory?: ReadonlyArray<OwnershipAssignment>;
}): CommercialAuthoritySnapshot {
  let dealOwnerMembershipId: OwnershipAssignment["membershipId"] | undefined;
  if (input.dealOwnerHistory !== undefined) {
    const currentDealOwner = resolveCurrentOwner({
      history: input.dealOwnerHistory,
      ownership: input.ownership,
      ownerRole: "DEAL_OWNER",
    });
    dealOwnerMembershipId = currentDealOwner?.membershipId;
  }

  return {
    tenantId: input.ownership.tenantId,
    customerId: input.ownership.customerId,
    projectId: input.ownership.projectId,
    commissionLedgerStatus: "UNKNOWN",
    discountAuthorityLevel: "APPROVAL_REQUIRED",
    ...(dealOwnerMembershipId !== undefined ? { dealOwnerMembershipId } : {}),
  };
}
