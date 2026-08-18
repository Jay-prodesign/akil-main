import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/project-boundary-scan.test.ts, so
// the repo root is one directory up from here (source .ts location, not
// the compiled dist/tests location this runs from - see below).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * T12 / RG-06: previously verified only by an ad-hoc `grep` run manually
 * at the end of each implementation checkpoint - real, but not a
 * repository-enforced regression test. This codifies that check
 * permanently: `npm run test` now fails on its own if a future change
 * introduces a commerce-platform or AI Commerce dependency into src/.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "akilta-commerce", pattern: /akilta-commerce/i },
  { label: "Shopify", pattern: /shopify/i },
  { label: "Ticimax", pattern: /ticimax/i },
  { label: "ikas", pattern: /\bikas\b/i },
  { label: "IdeaSoft", pattern: /ideasoft/i },
  { label: "T-Soft", pattern: /t-soft/i },
  { label: "WooCommerce", pattern: /woocommerce/i },
];

function listTsFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listTsFilesRecursively(fullPath));
    } else if (entry.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

test("T12 / RG-06: src/ contains no commerce-platform or AI Commerce reference", () => {
  const srcDir = join(REPO_ROOT, "src");
  const files = listTsFilesRecursively(srcDir);
  assert.ok(files.length > 0, "expected to find .ts files under src/");

  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${file}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("T12: package.json declares no runtime/production dependencies, only the documented minimum devDependencies", () => {
  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(
    Object.keys(packageJson.devDependencies ?? {}).sort(),
    ["@types/node", "typescript"],
  );
});
