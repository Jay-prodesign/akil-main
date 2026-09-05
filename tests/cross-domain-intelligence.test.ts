import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  buildCrossDomainIntelligenceSnapshot,
  InvalidCrossDomainIntelligenceRequestError,
  type IntelligenceInsight,
} from "../src/domain/cross-domain-intelligence.js";

const tenantScope = createTenantScope("akilta-tenant-1");
const projectRef = "project-alpha";
const asOf = "2026-09-05T12:00:00.000Z";

function insight(overrides: Partial<IntelligenceInsight> = {}): IntelligenceInsight {
  return {
    tenantScope,
    projectRef,
    domain: "DELIVERY",
    subjectRef: "project-alpha-on-track",
    kind: "OBSERVED",
    value: "ON_TRACK",
    capturedAt: "2026-09-05T11:55:00.000Z",
    sourceRef: "delivery-status:project-alpha",
    ...overrides,
  };
}

test("F1: a single fresh insight resolves CURRENT with its value as the agreed value", () => {
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [insight()],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 1);
  assert.equal(snapshot.reconciled[0]?.status, "CURRENT");
  assert.equal(snapshot.reconciled[0]?.agreedValue, "ON_TRACK");
  assert.equal(snapshot.rejectedInsights.length, 0);
});

test("F2: two fresh insights from different domains agreeing on value resolve CURRENT", () => {
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [
      insight({ domain: "DELIVERY", value: "ON_TRACK" }),
      insight({ domain: "OPERATIONS", value: "ON_TRACK", sourceRef: "ops-attention:project-alpha" }),
    ],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 1);
  assert.equal(snapshot.reconciled[0]?.status, "CURRENT");
  assert.equal(snapshot.reconciled[0]?.agreedValue, "ON_TRACK");
  assert.equal(snapshot.reconciled[0]?.insights.length, 2);
});

test("F3: two fresh insights disagreeing on value resolve CONFLICTING with no agreedValue", () => {
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [
      insight({ domain: "DELIVERY", value: "ON_TRACK" }),
      insight({ domain: "OPERATIONS", value: "AT_RISK", sourceRef: "ops-attention:project-alpha" }),
    ],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 1);
  assert.equal(snapshot.reconciled[0]?.status, "CONFLICTING");
  assert.equal(snapshot.reconciled[0]?.agreedValue, undefined);
  assert.equal(snapshot.reconciled[0]?.insights.length, 2);
});

test("F4: an insight older than the freshness threshold resolves STALE with no agreedValue, never masquerading as current", () => {
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [insight({ capturedAt: "2026-09-05T09:00:00.000Z" })],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 1);
  assert.equal(snapshot.reconciled[0]?.status, "STALE");
  assert.equal(snapshot.reconciled[0]?.agreedValue, undefined);
});

test("F5: a stale insight plus a fresh agreeing insight still resolves CURRENT (only freshness of the agreeing set matters)", () => {
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [
      insight({ domain: "DELIVERY", capturedAt: "2026-09-05T09:00:00.000Z" }),
      insight({ domain: "OPERATIONS", capturedAt: "2026-09-05T11:58:00.000Z", sourceRef: "ops-attention:project-alpha" }),
    ],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled[0]?.status, "CURRENT");
  assert.equal(snapshot.reconciled[0]?.insights.length, 2);
});

test("F6: an insight from a mismatched tenantScope is rejected, not silently included (no cross-client data leakage)", () => {
  const otherTenant = createTenantScope("akilta-tenant-2");
  const leaking = insight({ tenantScope: otherTenant });
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [leaking],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 0);
  assert.equal(snapshot.rejectedInsights.length, 1);
  assert.equal(snapshot.rejectedInsights[0]?.insight, leaking);
  assert.match(snapshot.rejectedInsights[0]?.reason ?? "", /tenantScope\/projectRef does not match/);
});

test("F7: an insight from a mismatched projectRef is rejected, not silently included", () => {
  const leaking = insight({ projectRef: "project-beta" });
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [leaking],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 0);
  assert.equal(snapshot.rejectedInsights.length, 1);
  assert.match(snapshot.rejectedInsights[0]?.reason ?? "", /tenantScope\/projectRef does not match/);
});

test("F8: an insight with an unrecognized domain is rejected, not silently included", () => {
  const bogus = insight({ domain: "MARKETING" as IntelligenceInsight["domain"] });
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [bogus],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 0);
  assert.equal(snapshot.rejectedInsights.length, 1);
  assert.match(snapshot.rejectedInsights[0]?.reason ?? "", /not a recognized source domain/);
});

test("F9: an insight with an invalid capturedAt timestamp is rejected, not silently included", () => {
  const malformed = insight({ capturedAt: "not-a-date" });
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [malformed],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 0);
  assert.equal(snapshot.rejectedInsights.length, 1);
  assert.match(snapshot.rejectedInsights[0]?.reason ?? "", /capturedAt is not a valid ISO timestamp/);
});

test("F10: distinct subjectRefs are reconciled independently of one another", () => {
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [
      insight({ subjectRef: "subject-a", value: "X" }),
      insight({ subjectRef: "subject-b", value: "Y", sourceRef: "other" }),
    ],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 2);
  const bySubject = new Map(snapshot.reconciled.map((r) => [r.subjectRef, r]));
  assert.equal(bySubject.get("subject-a")?.agreedValue, "X");
  assert.equal(bySubject.get("subject-b")?.agreedValue, "Y");
});

test("F11: OBSERVED and DERIVED kinds are preserved verbatim on every retained insight, never blurred together", () => {
  const observed = insight({ kind: "OBSERVED", value: "ON_TRACK" });
  const derived = insight({ kind: "DERIVED", value: "ON_TRACK", domain: "ENGINEERING", sourceRef: "forecast" });
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [observed, derived],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  const kinds = snapshot.reconciled[0]?.insights.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["DERIVED", "OBSERVED"]);
});

test("F12: an empty insights list resolves an empty snapshot rather than throwing", () => {
  const snapshot = buildCrossDomainIntelligenceSnapshot({
    tenantScope,
    projectRef,
    insights: [],
    freshnessThresholdMs: 30 * 60 * 1000,
    asOf,
  });
  assert.equal(snapshot.reconciled.length, 0);
  assert.equal(snapshot.rejectedInsights.length, 0);
});

test("F13: an invalid asOf timestamp fails closed", () => {
  assert.throws(
    () =>
      buildCrossDomainIntelligenceSnapshot({
        tenantScope,
        projectRef,
        insights: [insight()],
        freshnessThresholdMs: 1000,
        asOf: "not-a-date",
      }),
    InvalidCrossDomainIntelligenceRequestError,
  );
});

test("F14: a negative freshnessThresholdMs fails closed", () => {
  assert.throws(
    () =>
      buildCrossDomainIntelligenceSnapshot({
        tenantScope,
        projectRef,
        insights: [insight()],
        freshnessThresholdMs: -1,
        asOf,
      }),
    InvalidCrossDomainIntelligenceRequestError,
  );
});

test("F15: an empty/whitespace-only projectRef fails closed", () => {
  assert.throws(
    () =>
      buildCrossDomainIntelligenceSnapshot({
        tenantScope,
        projectRef: "   ",
        insights: [],
        freshnessThresholdMs: 1000,
        asOf,
      }),
    InvalidCrossDomainIntelligenceRequestError,
  );
});
