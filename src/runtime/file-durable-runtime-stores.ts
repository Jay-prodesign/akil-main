import { readdirSync } from "node:fs";
import { join } from "node:path";
import { FileDurableProjectStore } from "../domain/durable-project-store.js";
import { FileDurableOutcomeJobStore } from "../domain/durable-outcome-job-store.js";
import { FileDurableAuditLog } from "../application/durable-audit-log.js";
import { FileDurableConnectorConnectionStore } from "../domain/durable-connector-connection-store.js";
import { FileDurableCustomerOffboardingRequestStore } from "../domain/durable-customer-offboarding-request-store.js";
import { FileDurableOrganizationResourceBindingStore } from "../domain/durable-organization-resource-binding-store.js";
import { FileDurableOrganizationMembershipStore } from "../domain/durable-organization-membership-store.js";
import { FileDurableOrganizationServicePrincipalStore } from "../domain/durable-organization-service-principal-store.js";
import { FileDurableConfigurationPolicyDecisionStore } from "../domain/durable-configuration-policy-decision-store.js";
import { FileDurableEvidenceReferenceStore } from "../domain/durable-evidence-reference-store.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../domain/durable-controlled-organization-provisioning-store.js";
import { FileDurableStaffAccessGrantStore } from "../domain/durable-staff-access-grant-store.js";
import { FileDurableProtectedDecisionWaitStore } from "../domain/durable-protected-decision-wait-store.js";
import { FileDurableProtectedDecisionRecordStore } from "../domain/durable-protected-decision-record-store.js";
import { FileDurableCustomerRepository } from "../application/durable-customer-repository.js";
import { FileDurableBreakGlassAccessGrantStore } from "../domain/durable-break-glass-access-grant-store.js";
import { FileDurableBreakGlassSupportAccessAuditStore } from "../domain/durable-break-glass-support-access-audit-store.js";
import { FileDurableDelegatedAccessGrantStore } from "../domain/durable-delegated-access-grant-store.js";
import type { HealthProbeResult } from "./health-check.js";

/**
 * C1 (runtime composition root, FILE driver): the fixed on-disk layout of
 * every `FileDurable*` store the deployable runtime reads from, one
 * subdirectory per store under the single configured `AppConfig.dataDir`.
 * Each store needs its OWN directory: most of them write one
 * `<base64url(tenantId)>.json` file per tenant, so two stores sharing one
 * directory would overwrite each other's tenant files.
 *
 * Only stores that a read surface (`/portal` or `/os`) actually uses are
 * composed here. Stores that no served route reads yet (engineering, plan
 * admission, quota reservation, outcome-job execution, external sale
 * bootstrap, protected-decision record) are deliberately not constructed:
 * building a store nothing reads would add a health probe with nothing
 * behind it.
 *
 * C3 Attention slice: the protected-decision WAIT store is now composed,
 * because `/os/attention` reads it (`listByTenant`). Its directory has the
 * same shape a standalone `FileDurableProtectedDecisionWaitStore` uses
 * (per-tenant `.wait.jsonl`/`.resume.jsonl` logs plus its lock
 * directories), and it adds one `file-store:protected-decision-waits`
 * health probe.
 *
 * C4 (first `/os` mutation slice): the durable `CustomerRepository`
 * (`FileDurableCustomerRepository`) is now composed, because the
 * offboarding COMPLETE route reads the customer a request names
 * (`completeCustomerOffboardingAsAuthenticatedStaff`). It adds one
 * `file-store:customers` health probe. No runtime path writes customers
 * yet, so until one does, completing a real request answers 404.
 *
 * C4 slice 3: the protected-decision RECORD store
 * (`FileDurableProtectedDecisionRecordStore`) is now composed, because
 * both the attention decision POST route and `/os/attention`'s own
 * `getProtectedDecisionRecord` read/write it. It adds one
 * `file-store:protected-decision-records` health probe.
 *
 * C7: the break-glass GRANT store (`FileDurableBreakGlassAccessGrantStore`)
 * and break-glass AUDIT store (`FileDurableBreakGlassSupportAccessAuditStore`)
 * are now composed, because the read-only break-glass branch of
 * `GET /os/admin` reads the first and appends to the second. Each adds one
 * health probe (`file-store:break-glass-access-grants`,
 * `file-store:break-glass-support-access-audits`). No runtime path WRITES
 * grants yet (minting/revoking a grant needs its own task contract), so
 * until one does, every break-glass request answers 403 - the honest,
 * fail-closed default.
 *
 * D12 (delegated-access half, unblocked once C7 landed): the delegated-access
 * GRANT store (`FileDurableDelegatedAccessGrantStore`) is now composed,
 * because both the mint/revoke POST routes and the read-only
 * delegated-access branch of `GET /os/admin` read/write it. It adds one
 * `file-store:delegated-access-grants` health probe.
 */
export const FILE_DURABLE_RUNTIME_STORE_LAYOUT = {
  projects: "projects",
  outcomeJobs: "outcome-jobs",
  auditLog: "audit-log",
  connectorConnections: "connector-connections",
  customerOffboardingRequests: "customer-offboarding-requests",
  organizationResourceBindings: "organization-resource-bindings",
  organizationMemberships: "organization-memberships",
  organizationServicePrincipals: "organization-service-principals",
  configurationPolicyDecisions: "configuration-policy-decisions",
  evidenceReferences: "evidence-references",
  controlledOrganizationProvisioning: "controlled-organization-provisioning",
  staffAccessGrants: "staff-access-grants",
  protectedDecisionWaits: "protected-decision-waits",
  customers: "customers",
  protectedDecisionRecords: "protected-decision-records",
  breakGlassAccessGrants: "break-glass-access-grants",
  breakGlassSupportAccessAudits: "break-glass-support-access-audits",
  delegatedAccessGrants: "delegated-access-grants",
} as const;

export type FileDurableRuntimeStoreKey = keyof typeof FILE_DURABLE_RUNTIME_STORE_LAYOUT;

export interface FileDurableRuntimeStores {
  readonly dataDir: string;
  readonly projectStore: FileDurableProjectStore;
  readonly outcomeJobStore: FileDurableOutcomeJobStore;
  readonly auditLog: FileDurableAuditLog;
  readonly connectorConnectionStore: FileDurableConnectorConnectionStore;
  readonly customerOffboardingRequestStore: FileDurableCustomerOffboardingRequestStore;
  readonly organizationResourceBindingStore: FileDurableOrganizationResourceBindingStore;
  readonly organizationMembershipStore: FileDurableOrganizationMembershipStore;
  readonly organizationServicePrincipalStore: FileDurableOrganizationServicePrincipalStore;
  readonly configurationPolicyDecisionStore: FileDurableConfigurationPolicyDecisionStore;
  readonly evidenceReferenceStore: FileDurableEvidenceReferenceStore;
  readonly controlledOrganizationProvisioningStore: FileDurableControlledOrganizationProvisioningStore;
  /** C2: explicit per-membership `/os` access grants (`requireInternalOsAccess` evidence). */
  readonly staffAccessGrantStore: FileDurableStaffAccessGrantStore;
  /** C3 Attention: protected-decision WAIT/resume logs (`/os/attention` "customer approval required"). */
  readonly protectedDecisionWaitStore: FileDurableProtectedDecisionWaitStore;
  /** C4: customers, read by the offboarding COMPLETE route. */
  readonly customerRepository: FileDurableCustomerRepository;
  /** C4 slice 3: protected-decision RECORDS (`/os/attention`'s decide/revoke route and status column). */
  readonly protectedDecisionRecordStore: FileDurableProtectedDecisionRecordStore;
  /** C7: break-glass access grants, read by the break-glass branch of `GET /os/admin`. */
  readonly breakGlassAccessGrantStore: FileDurableBreakGlassAccessGrantStore;
  /** C7: break-glass support-access audits, one appended per GRANTED view kind on that branch. */
  readonly breakGlassSupportAccessAuditStore: FileDurableBreakGlassSupportAccessAuditStore;
  /** D12 (delegated-access half): delegated-access grants, read/written by the mint/revoke routes and the resolve branch of `GET /os/admin`. */
  readonly delegatedAccessGrantStore: FileDurableDelegatedAccessGrantStore;
}

/** Absolute (or caller-relative) directory of one store under `dataDir`. */
export function fileDurableRuntimeStoreDir(dataDir: string, key: FileDurableRuntimeStoreKey): string {
  return join(dataDir, FILE_DURABLE_RUNTIME_STORE_LAYOUT[key]);
}

/**
 * Builds each store exactly once, rooted at `dataDir`. Each store's
 * constructor already creates its own directory (`mkdirSync(..., {
 * recursive: true })`), so a `dataDir` that cannot be created or written
 * makes this throw at boot. The runtime never starts with a store it
 * could not open.
 */
export function createFileDurableRuntimeStores(dataDir: string): FileDurableRuntimeStores {
  const dir = (key: FileDurableRuntimeStoreKey): string => fileDurableRuntimeStoreDir(dataDir, key);
  return {
    dataDir,
    projectStore: new FileDurableProjectStore(dir("projects")),
    outcomeJobStore: new FileDurableOutcomeJobStore(dir("outcomeJobs")),
    auditLog: new FileDurableAuditLog(dir("auditLog")),
    connectorConnectionStore: new FileDurableConnectorConnectionStore(dir("connectorConnections")),
    customerOffboardingRequestStore: new FileDurableCustomerOffboardingRequestStore(dir("customerOffboardingRequests")),
    organizationResourceBindingStore: new FileDurableOrganizationResourceBindingStore(dir("organizationResourceBindings")),
    organizationMembershipStore: new FileDurableOrganizationMembershipStore(dir("organizationMemberships")),
    organizationServicePrincipalStore: new FileDurableOrganizationServicePrincipalStore(dir("organizationServicePrincipals")),
    configurationPolicyDecisionStore: new FileDurableConfigurationPolicyDecisionStore(dir("configurationPolicyDecisions")),
    evidenceReferenceStore: new FileDurableEvidenceReferenceStore(dir("evidenceReferences")),
    controlledOrganizationProvisioningStore: new FileDurableControlledOrganizationProvisioningStore(
      dir("controlledOrganizationProvisioning"),
    ),
    staffAccessGrantStore: new FileDurableStaffAccessGrantStore(dir("staffAccessGrants")),
    protectedDecisionWaitStore: new FileDurableProtectedDecisionWaitStore(dir("protectedDecisionWaits")),
    customerRepository: new FileDurableCustomerRepository(dir("customers")),
    protectedDecisionRecordStore: new FileDurableProtectedDecisionRecordStore(dir("protectedDecisionRecords")),
    breakGlassAccessGrantStore: new FileDurableBreakGlassAccessGrantStore(dir("breakGlassAccessGrants")),
    breakGlassSupportAccessAuditStore: new FileDurableBreakGlassSupportAccessAuditStore(dir("breakGlassSupportAccessAudits")),
    delegatedAccessGrantStore: new FileDurableDelegatedAccessGrantStore(dir("delegatedAccessGrants")),
  };
}

/**
 * C1 store-readability health probe: one CRITICAL probe per composed
 * store. Each probe re-lists that store's own directory every time
 * `/health` is evaluated, so it reflects the directory as it is now, not
 * as it was at boot. A directory that was deleted, replaced by a file, or
 * made unreadable after boot fails its probe, and `evaluateHealth` then
 * reports `UNHEALTHY` (503).
 *
 * This checks that each store's directory can be read. It does not
 * re-validate every tenant file's contents: a corrupted tenant file is a
 * data-integrity problem for that one tenant, and the store's own
 * fail-closed replay validation already reports it on read.
 *
 * `detail` never includes a filesystem path, only the store key and an
 * errno code, because `/health` is unauthenticated.
 */
export function probeFileDurableRuntimeStoreReadability(dataDir: string): ReadonlyArray<HealthProbeResult> {
  return (Object.keys(FILE_DURABLE_RUNTIME_STORE_LAYOUT) as FileDurableRuntimeStoreKey[]).map((key) => {
    const name = `file-store:${FILE_DURABLE_RUNTIME_STORE_LAYOUT[key]}`;
    try {
      readdirSync(fileDurableRuntimeStoreDir(dataDir, key));
      return { name, healthy: true, critical: true, detail: "readable" };
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code ?? "UNKNOWN";
      return { name, healthy: false, critical: true, detail: `unreadable (${code})` };
    }
  });
}
