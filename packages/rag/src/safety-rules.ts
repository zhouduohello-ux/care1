import { CORPUS_DOCUMENTS } from "./corpus.js";

export interface SafetyRuleSet {
  /** Exact/normalised phrases that must never appear in outbound messages. */
  prohibitedPhrases: string[];
  /** Addendums that must be appended to medical outbound messages. */
  requiredAddendums: string[];
  /** Inbound escalation keywords (for reference; usually consumed by L1 Perception). */
  escalationTriggers: string[];
}

const ruleCache = new Map<string, SafetyRuleSet>();

function parseBulletList(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const text = trimmed.slice(2).trim();
      if (text) items.push(stripQuotes(text));
    }
  }
  return items;
}

function stripQuotes(text: string): string {
  return text.replace(/^["']+|["']+$/g, "").trim();
}

function extractSectionContent(content: string, heading: string): string {
  const lines = content.split(/\r?\n/);
  let capturing = false;
  const buffer: string[] = [];
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      if (capturing) break;
      if (headingMatch[1].trim().toLowerCase() === heading.toLowerCase()) {
        capturing = true;
      }
      continue;
    }
    if (capturing) buffer.push(line);
  }
  return buffer.join("\n");
}

export function loadSafetyRules(disease: string): SafetyRuleSet {
  const key = disease.toLowerCase();
  if (ruleCache.has(key)) return ruleCache.get(key)!;

  const documents = CORPUS_DOCUMENTS[key] ?? [];
  const safetyDoc = documents.find((d) => d.source.toLowerCase() === "safety-rules.md");

  if (!safetyDoc) {
    const empty: SafetyRuleSet = { prohibitedPhrases: [], requiredAddendums: [], escalationTriggers: [] };
    ruleCache.set(key, empty);
    return empty;
  }

  const rules: SafetyRuleSet = {
    prohibitedPhrases: parseBulletList(extractSectionContent(safetyDoc.content, "Must never say")),
    requiredAddendums: parseBulletList(extractSectionContent(safetyDoc.content, "Must always say")),
    escalationTriggers: parseBulletList(extractSectionContent(safetyDoc.content, "Escalation triggers")),
  };

  ruleCache.set(key, rules);
  return rules;
}
