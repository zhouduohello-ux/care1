#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  user?: { phoneNumber?: string };
  script: Array<{
    action: "reset" | "load_persona" | "advance" | "send" | "reply" | "generate_brief" | "fetch_brief" | "fetch_pdf";
    personaId?: string;
    to?: string;
    text?: string;
    buttonId?: string;
    briefId?: string;
    token?: string;
  }>;
  expectations?: Array<{
    afterStep: number;
    type: "message" | "message_type" | "planner" | "safety" | "observation" | "diseaseCard" | "brief" | "pdf";
    path?: string;
    op: "eq" | "contains" | "not_contains" | "matches" | "in" | "exists";
    value?: unknown;
    filter?: Record<string, unknown>;
    caseInsensitive?: boolean;
    description?: string;
  }>;
}

export interface StepResult {
  step: number;
  action: string;
  outboundMessages: Array<{
    content: {
      type: string;
      text: string;
      buttons?: unknown[];
      list?: unknown[];
    };
  }>;
  trace?: {
    perception?: unknown;
    planner?: Record<string, unknown>;
    safety?: Record<string, unknown>;
  };
  newTime?: string;
  brief?: {
    briefId: string;
    webUrl: string;
    html: string;
  };
  fetchedBrief?: {
    html: string;
  };
  fetchedPdf?: {
    contentType: string;
    size: number;
  };
}

export interface RunOptions {
  apiBaseUrl?: string;
  verbose?: boolean;
}

export interface RunResult {
  scenarioId: string;
  scenarioName: string;
  userId: string;
  passed: boolean;
  failures: string[];
}

export const DEFAULT_API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3055";

export const TEST_TOOL_API_KEY = process.env.TEST_TOOL_API_KEY;

export class ScenarioRunner {
  private apiBaseUrl: string;
  private verbose: boolean;

  constructor(opts: RunOptions = {}) {
    this.apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.verbose = opts.verbose ?? false;
  }

  private async rawApi(route: string, opts: RequestInit = {}) {
    const url = `${this.apiBaseUrl}${route}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (TEST_TOOL_API_KEY && route.startsWith("/dev/test-tool")) {
      headers["X-Test-Tool-Api-Key"] = TEST_TOOL_API_KEY;
    }
    const response = await fetch(url, {
      ...opts,
      headers: {
        ...headers,
        ...opts.headers,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} from ${route}: ${text}`);
    }
    return response;
  }

  private async api(route: string, opts: RequestInit = {}) {
    const response = await this.rawApi(route, opts);
    return response.json() as Promise<unknown>;
  }

  private reset(userId: string) {
    return this.api("/dev/test-tool/api/reset-user", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }

  private loadPersona(userId: string, personaId: string) {
    return this.api("/dev/test-tool/api/load-persona", {
      method: "POST",
      body: JSON.stringify({ userId, personaId }),
    });
  }

  private advance(userId: string, to: string) {
    return this.api("/dev/test-tool/api/advance-time", {
      method: "POST",
      body: JSON.stringify({ userId, to }),
    }) as Promise<{ newTime: string; outboundMessages: StepResult["outboundMessages"] }>;
  }

  private simulate(userId: string, text?: string, buttonId?: string) {
    return this.api("/dev/test-tool/api/simulate-message", {
      method: "POST",
      body: JSON.stringify({ userId, text, buttonId }),
    }) as Promise<{ outboundMessages: StepResult["outboundMessages"]; trace?: StepResult["trace"] }>;
  }

  private async getSessionState(userId: string) {
    return this.api(`/dev/test-tool/api/session-state?userId=${encodeURIComponent(userId)}`) as Promise<{
      user?: { id: string } | null;
      cycle?: { id: string } | null;
      diseaseCard?: { id: string } | null;
      recentObservations?: Array<Record<string, unknown>>;
    }>;
  }

  private async generateBrief(userId: string) {
    const state = await this.getSessionState(userId);
    const cycleId = state.cycle?.id;
    if (!cycleId) {
      throw new Error("No active or recent cycle found; cannot generate brief");
    }
    return this.api("/api/briefs", {
      method: "POST",
      body: JSON.stringify({ cycleId }),
    }) as Promise<{ briefId: string; webUrl: string; html: string }>;
  }

  private async fetchBrief(briefId: string, token: string) {
    const response = await this.rawApi(`/api/briefs/${briefId}?t=${encodeURIComponent(token)}`, {
      headers: { Accept: "text/html" },
    });
    const html = await response.text();
    return { html };
  }

  private async fetchPdf(briefId: string, token: string) {
    const response = await this.rawApi(`/api/briefs/${briefId}/pdf?t=${encodeURIComponent(token)}`, {
      headers: { Accept: "application/pdf" },
    });
    const blob = await response.blob();
    return {
      contentType: response.headers.get("content-type") ?? "",
      size: blob.size,
    };
  }

  async run(scenario: Scenario): Promise<RunResult> {
    const userId = scenario.user?.phoneNumber ?? `test_${scenario.id}_${Date.now()}`;
    const results: StepResult[] = [];
    const failures: string[] = [];

    console.log(`▶ Scenario: ${scenario.name} (${scenario.id})`);
    console.log(`  User: ${userId}`);
    console.log(`  API:  ${this.apiBaseUrl}\n`);

    let stepNumber = 0;
    let lastBrief: { briefId: string; webUrl: string; html: string } | undefined;

    for (const step of scenario.script) {
      stepNumber += 1;
      const label = `${step.action}${step.personaId ? ` ${step.personaId}` : ""}${step.buttonId ? ` [${step.buttonId}]` : ""}${step.text ? ` "${step.text}"` : ""}${step.to ? ` -> ${step.to}` : ""}${step.briefId ? ` ${step.briefId}` : ""}`;
      process.stdout.write(`  Step ${stepNumber}: ${label} `);

      let result: StepResult | undefined;
      try {
        if (step.action === "reset") {
          await this.reset(userId);
        } else if (step.action === "load_persona") {
          await this.loadPersona(userId, step.personaId ?? "controlled_asthma");
        } else if (step.action === "advance") {
          const data = await this.advance(userId, step.to ?? "next_checkin");
          result = { step: stepNumber, action: step.action, outboundMessages: data.outboundMessages, newTime: data.newTime };
        } else if (step.action === "send") {
          const data = await this.simulate(userId, step.text);
          result = { step: stepNumber, action: step.action, outboundMessages: data.outboundMessages, trace: data.trace };
        } else if (step.action === "reply") {
          const data = await this.simulate(userId, undefined, step.buttonId);
          result = { step: stepNumber, action: step.action, outboundMessages: data.outboundMessages, trace: data.trace };
        } else if (step.action === "generate_brief") {
          const data = await this.generateBrief(userId);
          lastBrief = data;
          result = { step: stepNumber, action: step.action, outboundMessages: [], brief: data };
        } else if (step.action === "fetch_brief") {
          if (!lastBrief) throw new Error("No brief generated yet");
          const { briefId, token } = parseBriefUrl(lastBrief.webUrl);
          const data = await this.fetchBrief(step.briefId ?? briefId, step.token ?? token);
          result = { step: stepNumber, action: step.action, outboundMessages: [], fetchedBrief: data };
        } else if (step.action === "fetch_pdf") {
          if (!lastBrief) throw new Error("No brief generated yet");
          const { briefId, token } = parseBriefUrl(lastBrief.webUrl);
          const data = await this.fetchPdf(step.briefId ?? briefId, step.token ?? token);
          result = { step: stepNumber, action: step.action, outboundMessages: [], fetchedPdf: data };
        }
        console.log("✓");
        if (result) results.push(result);
      } catch (err) {
        console.log("✗");
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`Step ${stepNumber}: ${message}`);
        continue;
      }

      const expectations = (scenario.expectations ?? []).filter((e) => e.afterStep === stepNumber);
      for (const assertion of expectations) {
        const desc = assertion.description ?? `${assertion.type}.${assertion.path} ${assertion.op} ${JSON.stringify(assertion.value)}`;
        const evalResult = await this.evaluate(assertion, result, userId);
        if (evalResult.pass) {
          console.log(`    ✓ ${desc}`);
        } else {
          console.log(`    ✗ ${desc}`);
          console.log(`      actual: ${JSON.stringify(evalResult.actual)}${evalResult.reason ? `, reason: ${evalResult.reason}` : ""}`);
          failures.push(`Assertion at step ${stepNumber}: ${desc}`);
        }
      }
    }

    console.log("");
    const passed = failures.length === 0;
    if (passed) {
      console.log(`✓ Scenario passed: ${scenario.id}`);
    } else {
      console.log(`✗ Scenario failed: ${scenario.id}`);
      for (const f of failures) console.log(`  - ${f}`);
    }

    return { scenarioId: scenario.id, scenarioName: scenario.name, userId, passed, failures };
  }

  private async evaluate(
    assertion: NonNullable<Scenario["expectations"]>[number],
    stepResult: StepResult | undefined,
    userId: string
  ): Promise<{ pass: boolean; actual: unknown; reason?: string }> {
    if (assertion.type === "diseaseCard") {
      const state = await this.getSessionState(userId);
      const actual = !!state.diseaseCard;
      const pass = assertion.op === "exists" ? actual : !actual;
      return { pass, actual };
    }

    if (assertion.type === "observation") {
      const state = await this.getSessionState(userId);
      const observations = state.recentObservations ?? [];
      const filter = assertion.filter ?? {};
      const actual = observations.some((obs) =>
        Object.entries(filter).every(([key, value]) => obs[key] === value)
      );
      return { pass: assertion.op === "exists" ? actual : !actual, actual };
    }

    if (!stepResult) {
      return { pass: false, actual: undefined, reason: "no step result available" };
    }

    if (assertion.type === "message_type") {
      const types = stepResult.outboundMessages.map((m) => m.content.type);
      const actual = types.length === 1 ? types[0] : types;
      const pass = matches(actual, assertion.op, assertion.value);
      return { pass, actual };
    }

    if (assertion.type === "message") {
      const text = stepResult.outboundMessages.map((m) => m.content.text).join("\n");
      const pass = matches(text, assertion.op, assertion.value, assertion.caseInsensitive);
      return { pass, actual: text };
    }

    if (assertion.type === "planner") {
      if (!assertion.path) return { pass: false, actual: undefined, reason: "missing path" };
      const actual = getPath(stepResult.trace?.planner, assertion.path);
      const pass = matches(actual, assertion.op, assertion.value);
      return { pass, actual };
    }

    if (assertion.type === "safety") {
      if (!assertion.path) return { pass: false, actual: undefined, reason: "missing path" };
      const actual = getPath(stepResult.trace?.safety, assertion.path);
      const pass = matches(actual, assertion.op, assertion.value);
      return { pass, actual };
    }

    if (assertion.type === "brief") {
      const html = stepResult.fetchedBrief?.html ?? stepResult.brief?.html ?? "";
      const pass = matches(html, assertion.op, assertion.value, assertion.caseInsensitive);
      return { pass, actual: html };
    }

    if (assertion.type === "pdf") {
      if (!assertion.path) return { pass: false, actual: undefined, reason: "missing path" };
      const actual = getPath(stepResult.fetchedPdf, assertion.path);
      const pass = matches(actual, assertion.op, assertion.value);
      return { pass, actual };
    }

    return { pass: false, actual: undefined, reason: `unknown assertion type: ${assertion.type}` };
  }
}

function parseBriefUrl(webUrl: string): { briefId: string; token: string } {
  const url = new URL(webUrl);
  const parts = url.pathname.split("/");
  const briefId = parts[parts.length - 1];
  const token = url.searchParams.get("t") ?? "";
  return { briefId, token };
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function matches(actual: unknown, op: string, expected: unknown, caseInsensitive?: boolean): boolean {
  if (op === "exists") {
    return actual !== undefined && actual !== null;
  }

  const normalize = (v: unknown) =>
    caseInsensitive && typeof v === "string" ? v.toLowerCase() : v;

  if (op === "eq") {
    return normalize(actual) === normalize(expected);
  }

  if (op === "in") {
    return Array.isArray(expected) && expected.map(normalize).includes(normalize(actual));
  }

  if (op === "contains") {
    const haystack = typeof actual === "string" ? normalize(actual) : "";
    const needle = typeof expected === "string" ? normalize(expected) : "";
    return haystack.includes(needle);
  }

  if (op === "not_contains") {
    const haystack = typeof actual === "string" ? normalize(actual) : "";
    const needle = typeof expected === "string" ? normalize(expected) : "";
    return !haystack.includes(needle);
  }

  if (op === "matches") {
    const haystack = typeof actual === "string" ? actual : String(actual);
    const pattern = typeof expected === "string" ? new RegExp(expected, caseInsensitive ? "i" : undefined) : expected;
    return pattern instanceof RegExp && pattern.test(haystack);
  }

  return false;
}

export async function loadScenario(scenarioPath: string): Promise<Scenario> {
  const fullPath = path.resolve(scenarioPath);
  const raw = await fs.readFile(fullPath, "utf-8");
  return JSON.parse(raw) as Scenario;
}

async function main() {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error("Usage: tsx tests/scenarios/run-scenario.ts <path-to-scenario.json>");
    process.exit(1);
  }

  const scenario = await loadScenario(scenarioPath);
  const runner = new ScenarioRunner();
  const result = await runner.run(scenario);
  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
