import { readFile } from "node:fs/promises";

const baseline = JSON.parse(await readFile(new URL("./scenario-skill-sources.json", import.meta.url), "utf8"));
const headers = { Accept: "application/vnd.github+json", "User-Agent": "CodexBlenderPlugin-upstream-check" };

async function latestCommit(source) {
  const url = new URL(`https://api.github.com/repos/${baseline.repository}/commits`);
  url.searchParams.set("path", source.path);
  url.searchParams.set("per_page", "1");
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${source.name}: GitHub returned HTTP ${response.status}`);
  const commits = await response.json();
  if (!Array.isArray(commits) || typeof commits[0]?.sha !== "string") {
    throw new Error(`${source.name}: no commit found for ${source.path}`);
  }
  return commits[0].sha;
}

try {
  const results = await Promise.all(baseline.sources.map(async (source) => ({
    ...source,
    latestCommit: await latestCommit(source),
  })));
  let changed = false;
  for (const source of results) {
    const isNew = source.latestCommit !== source.lastReviewedCommit;
    changed ||= isNew;
    console.log(`${isNew ? "UPDATE" : "CURRENT"} ${source.name} ${source.latestCommit}`);
    if (isNew) console.log(`  reviewed: ${source.lastReviewedCommit}`);
  }
  if (changed) {
    console.log("Review upstream changes before updating scene guidance or the recorded commits.");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
