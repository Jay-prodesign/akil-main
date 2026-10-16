import type { AuditEvent } from "../domain/audit-event.js";
import type { TenantScope } from "../domain/tenant-scope.js";
import type { AuditLog } from "../ports/audit-log.js";

export class DuplicateAuditEventError extends Error {
  constructor(eventId: string) {
    super(
      `AuditEvent ${eventId} has already been recorded and cannot be overwritten`,
    );
    this.name = "DuplicateAuditEventError";
  }
}

/**
 * In-memory test adapter only (AKI-BE-001 Runtime/Persistence Boundary).
 * Production durable audit storage is deferred.
 *
 * Append-only by construction, not by convention: this class exposes no
 * update or remove method at all, and `append` rejects a duplicate
 * `eventId` rather than silently overwriting it - there is no code path
 * anywhere in this class that mutates a previously stored AuditEvent.
 *
 * Every read requires a TenantScope - no bare, unscoped accessor exists
 * (same structural pattern as `CustomerRepository`, EI-4 / RG-02).
 *
 * AUDIT-DURABLE-001: now formally implements the `AuditLog` port
 * (`src/ports/audit-log.ts`), named directly from this class's own
 * pre-existing contract - no behavior change.
 */
export class InMemoryAuditLog implements AuditLog {
  #events: AuditEvent[] = [];
  #seenEventIds = new Set<string>();

  append(event: AuditEvent): void {
    if (this.#seenEventIds.has(event.eventId)) {
      throw new DuplicateAuditEventError(event.eventId);
    }
    this.#seenEventIds.add(event.eventId);
    this.#events.push(event);
  }

  findByTenant(tenantScope: TenantScope): ReadonlyArray<AuditEvent> {
    return this.#events.filter(
      (event) => event.tenantId === tenantScope.tenantId,
    );
  }
}
