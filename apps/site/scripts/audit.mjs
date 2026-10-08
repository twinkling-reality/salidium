import { spawnSync } from "node:child_process";

/*
 * `npm audit --audit-level=high`, with named exceptions. npm cannot ignore one advisory, so a high
 * advisory that has no patched version anywhere would otherwise hold the audit red with nothing to
 * update, and every advisory that arrived after it would go unseen behind it.
 *
 * An exception names one advisory and a date to look at it again. It stops counting on that date,
 * and the audit fails when an excepted advisory is no longer reported, so the list cannot outlive
 * its reasons.
 */
const exceptions = [
  {
    id: "GHSA-vfj7-8cjw-p6xm",
    revisitBy: "2026-11-08",
    reason:
      "braces <=3.0.3 has no patched release. It reaches only lint and build tooling " +
      "(the Next lint plugin and vinext, through fast-glob), which expands patterns this " +
      "repository writes and never ships to a visitor.",
  },
];

const result = spawnSync("npm", ["audit", "--json"], { encoding: "utf8" });
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error(result.stderr || "npm audit printed no JSON");
  process.exit(1);
}
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via) {
    if (typeof via === "object") advisories.set(via.url.split("/").pop(), via);
  }
}

const today = new Date().toISOString().slice(0, 10);
const problems = [];
for (const exception of exceptions) {
  if (!advisories.has(exception.id))
    problems.push(`${exception.id} is no longer reported: remove its exception`);
  else if (today > exception.revisitBy)
    problems.push(`${exception.id} was due for review by ${exception.revisitBy}: ${exception.reason}`);
}
for (const [id, advisory] of advisories) {
  if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
  const exception = exceptions.find((candidate) => candidate.id === id);
  if (exception && today <= exception.revisitBy) {
    console.log(`excepted until ${exception.revisitBy}: ${id} ${advisory.name} ${advisory.range}`);
    continue;
  }
  if (!exception)
    problems.push(`${advisory.severity}: ${advisory.name} ${advisory.range} ${advisory.title} ${advisory.url}`);
}

for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log("no high or critical advisories outside the named exceptions");
