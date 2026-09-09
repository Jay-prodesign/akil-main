import { FileDurableEngineeringStore } from "../../src/domain/durable-engineering-store.js";
import { makeEvent } from "./engineering-event-helpers.js";

/**
 * AUD-DURABILITY-GAP: standalone worker process (not a test itself) spawned
 * by durable-engineering-store-concurrency.test.ts as a real, separate OS
 * process. Node's own synchronous single-threaded execution cannot
 * reproduce a true concurrent-writer race in-process - two Promises
 * resolved with sync fs calls never actually interleave at the OS level -
 * so proving `appendFileSync`'s atomicity claim requires genuinely
 * concurrent processes racing to append to the exact same file.
 *
 * usage: node concurrent-append-worker.js <storeDir> <workerIndex> <count>
 */
const [, , storeDir, workerIndexArg, countArg] = process.argv;
if (storeDir === undefined || workerIndexArg === undefined || countArg === undefined) {
  throw new Error("usage: concurrent-append-worker.js <storeDir> <workerIndex> <count>");
}
const workerIndex = Number(workerIndexArg);
const count = Number(countArg);

const store = new FileDurableEngineeringStore(storeDir);
for (let i = 0; i < count; i += 1) {
  store.appendEvent(
    makeEvent({
      eventId: `concurrency-worker-${workerIndex}-event-${i}`,
      checkpointSha: `concurrency-worker-${workerIndex}-checkpoint-${i}`,
      fencingToken: i + 1,
    }),
  );
}
