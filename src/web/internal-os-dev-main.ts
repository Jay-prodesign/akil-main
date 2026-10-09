import { createInternalOsHttpServer } from "./internal-os-http-server.js";
import {
  REVIEW_ORGANIZATION,
  buildReviewStaffSessionFixtureMap,
  buildReviewStaffAccessGrants,
  buildReviewWorkProjectSource,
  buildReviewWorkJobSource,
  ALL_STAFF_REVIEW_FIXTURES,
} from "./internal-os-review-fixtures.js";
import { STAFF_SESSION_TOKEN_HEADER } from "./internal-os-request-handler.js";

/**
 * Rev168 "LOCAL DOGFOOD BOOTSTRAP": one repository-native command
 * (`npm run start:os-dev`) that builds and starts a real `node:http`
 * internal OS server with deterministic dev staff fixtures already wired
 * in, and prints the localhost URL plus each fixture's session token - the
 * Founder never assembles a test token by hand. Refuses to run at all if
 * `NODE_ENV=production` (defense in depth: `createInternalOsHttpServer`
 * with `isProduction: true` would already ignore these fixtures entirely
 * and always report unauthenticated, but this script never even attempts
 * that combination).
 */
function main(): void {
  if (process.env.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.error("internal-os-dev-main must never run with NODE_ENV=production - refusing to start.");
    process.exitCode = 1;
    return;
  }

  const port = Number.parseInt(process.env.PORT ?? "4008", 10);
  const server = createInternalOsHttpServer({
    isProduction: false,
    devStaffFixtures: buildReviewStaffSessionFixtureMap(),
    organization: REVIEW_ORGANIZATION,
    grants: buildReviewStaffAccessGrants(),
    projectSource: buildReviewWorkProjectSource(),
    jobSource: buildReviewWorkJobSource(),
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`AKILTA internal OS (dev) listening at http://localhost:${port}/os`);
    // eslint-disable-next-line no-console
    console.log(`Send header "${STAFF_SESSION_TOKEN_HEADER}: <token>" with one of these dev fixture tokens:`);
    for (const fixture of ALL_STAFF_REVIEW_FIXTURES) {
      // eslint-disable-next-line no-console
      console.log(`  ${fixture.sessionToken}  —  ${fixture.description}`);
    }
    // eslint-disable-next-line no-console
    console.log(`Example: curl -H "${STAFF_SESSION_TOKEN_HEADER}: ${ALL_STAFF_REVIEW_FIXTURES[0]?.sessionToken}" http://localhost:${port}/os/home`);
  });
}

main();
