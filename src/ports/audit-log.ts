import type { AuditEvent } from "../domain/audit-event.js";
import type { TenantScope } from "../domain/tenant-scope.js";

/**
 * AUDIT-DURABLE-001 (Brain continuation, PR #145 comment `6205619559`):
 * `InMemoryAuditLog` (AKI-BE-001) has carried this exact two-method
 * contract since the first checkpoint, with its own doc comment
 * explicitly disclosing "production durable audit storage is deferred" -
 * this port names that existing, already-accepted contract so a durable
 * implementation can exist alongside the in-memory test adapter, mirroring
 * `CustomerRepository`'s own port/application split (`AKI-BE-001`/
 * `CUSTOMER-REPO-DURABLE-001`) exactly. Append-only by contract: there is
 * deliberately no update/remove method here, matching `InMemoryAuditLog`'s
 * own "exposes no update or remove method at all" discipline - a
 * conforming implementation must reject a duplicate `eventId` rather than
 * silently overwriting it, never add a wider mutation surface.
 */
export interface AuditLog {
  append(event: AuditEvent): void;
  findByTenant(tenantScope: TenantScope): ReadonlyArray<AuditEvent>;
}
