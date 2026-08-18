import { createDec138Provenance, type Dec138Provenance } from "../../src/domain/dec-138-provenance.js";
import {
  createEngineeringEventEnvelope,
  type EngineeringEventEnvelope,
} from "../../src/domain/engineering-event-envelope.js";

let counter = 0;

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function testProvenance(): Dec138Provenance {
  return createDec138Provenance({
    taskId: "ENG-ORCH-001",
    repository: "Jay-prodesign/akil-main",
    branch: "claude/ENG-ORCH-001-task-packet",
    generatedAt: "2026-08-18T00:00:00.000Z",
    generatedByRole: "Claude / Primary Engineer",
    executionSurface: "test",
    sourceSurface: "test",
    transportedByPrincipal: "test",
    transportMethod: "test",
    sourceEvidenceReferences: ["internal://tests"],
    attributionBasisConfidence: "UNVERIFIED",
  });
}

type EventOverrides = Partial<Parameters<typeof createEngineeringEventEnvelope>[0]>;

export function makeEvent(overrides: EventOverrides = {}): EngineeringEventEnvelope {
  return createEngineeringEventEnvelope({
    eventId: nextId("evt"),
    projectRef: "AKILTA",
    taskId: "ENG-ORCH-001",
    runId: "run-1",
    correlationId: "corr-1",
    fromRole: "WORKER",
    targetRole: "BRAIN",
    eventType: "CHECKPOINT",
    idempotencyKey: nextId("idem"),
    attempt: 1,
    fencingToken: 1,
    timestamp: "2026-08-18T00:00:00.000Z",
    provenance: testProvenance(),
    ...overrides,
  });
}
