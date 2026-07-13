#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioRunner, type RunResult, type Scenario, loadScenario, DEFAULT_API_BASE_URL } from "./run-scenario.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function discoverScenarios(): Promise<string[]> {
  const entries = await fs.readdir(__dirname);
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(__dirname, name))
    .sort();
}

async function waitForHealthy(apiBaseUrl: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBaseUrl}/health`);
      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === "ok") return true;
      }
    } catch {
      // ignore
    }
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const apiBaseUrl = process.env.API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const waitForHealth = !args.includes("--no-wait");
  const verbose = args.includes("--verbose");

  console.log(`\nCareMemory E2E smoke runner`);
  console.log(`API base URL: ${apiBaseUrl}\n`);

  if (waitForHealth) {
    process.stdout.write("Waiting for API /health to report ok");
    const healthy = await waitForHealthy(apiBaseUrl);
    console.log("");
    if (!healthy) {
      console.error(`API at ${apiBaseUrl} did not become healthy within timeout`);
      process.exit(1);
    }
  }

  const scenarioPaths = args.filter((a) => !a.startsWith("--"));
  const paths = scenarioPaths.length > 0 ? scenarioPaths : await discoverScenarios();

  if (paths.length === 0) {
    console.error("No scenario files found");
    process.exit(1);
  }

  const runner = new ScenarioRunner({ apiBaseUrl, verbose });

  process.stdout.write("Resetting all test users from previous runs... ");
  try {
    const { deleted } = await runner.resetAllTestUsers();
    console.log(`✓ (${deleted} deleted)`);
  } catch (err) {
    console.log("✗");
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to reset test users: ${message}`);
    process.exit(1);
  }

  const results: RunResult[] = [];

  for (let i = 0; i < paths.length; i++) {
    const scenarioPath = paths[i];
    const scenario = await loadScenario(scenarioPath);
    const result = await runner.run(scenario);
    results.push(result);
    console.log("");
    if (i < paths.length - 1) {
      await runner.sleepBetweenScenarios();
    }
  }

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log("=============================");
  console.log(`Total:  ${results.length}`);
  console.log(`Passed: ${passed.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log("=============================");

  if (failed.length > 0) {
    console.log("\nFailed scenarios:");
    for (const r of failed) {
      console.log(`  - ${r.scenarioId}: ${r.scenarioName}`);
      for (const f of r.failures) console.log(`      ${f}`);
    }
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
