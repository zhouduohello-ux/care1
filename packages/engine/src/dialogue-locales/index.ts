export interface DialogueLocale {
  /** ISO locale code, e.g. "en-GB". */
  code: string;
  /** Localised labels for known single/multi-select topics. */
  optionLabels: Record<string, string[]>;
  /** Optional synonyms / phrase variants for option IDs, used by TurnManager for fuzzy answer matching. */
  optionSynonyms?: Record<string, string[]>;
  /** Optional word-to-number map for scale answers (e.g. "mild" → 1). */
  scaleWordMap?: Record<number, string[]>;
  /** Localised footer appended to multi-select questions. */
  multiSelectFooter: string;
  /** Localised brief-ready message template. `{url}` is replaced with the actual link. */
  briefReadyTemplate: string;
  /** Localised cycle-end closing messages. */
  closingMessages: {
    plan4WeekComplete: string;
    trial7DayComplete: string;
    trial7DayCompleteWithBrief: string;
  };
  /** Localised empathy prefixes for safety responses. */
  safetyEmpathy: {
    struggling: string;
    adverseEvent: string;
  };
}

import { enGB } from "./en-GB.js";
import { cyGB } from "./cy-GB.js";

export const DEFAULT_LOCALE_CODE = "en-GB";

export const SUPPORTED_LOCALES: Record<string, DialogueLocale> = {};

export function registerLocale(locale: DialogueLocale): void {
  SUPPORTED_LOCALES[locale.code] = locale;
}

export function getLocale(code?: string): DialogueLocale {
  return SUPPORTED_LOCALES[code ?? DEFAULT_LOCALE_CODE] ?? SUPPORTED_LOCALES[DEFAULT_LOCALE_CODE];
}

export function translateOptionLabels(locale: DialogueLocale, topic: string, options: string[]): string[] {
  return locale.optionLabels[topic] ?? options;
}

export function formatBriefReadyMessage(locale: DialogueLocale, url: string): string {
  return locale.briefReadyTemplate.replace(/\{url\}/g, url);
}

export function matchOptionSynonym(locale: DialogueLocale, optionId: string, text: string): boolean {
  const synonyms = locale.optionSynonyms?.[optionId] ?? [];
  const normalizedText = normalizeAnswerText(text);
  return synonyms.some((phrase) => normalizedText.includes(normalizeAnswerText(phrase)));
}

export function normalizeAnswerText(text: string): string {
  let normalized = text.trim().toLowerCase();
  if (!normalized) return "";

  // Collapse whitespace.
  normalized = normalized.replace(/\s+/g, " ");

  // Expand common contractions so "didn't use" matches "did not use" synonyms.
  const contractions: Record<string, string> = {
    "don't": "do not",
    "doesn't": "does not",
    "didn't": "did not",
    "can't": "cannot",
    "won't": "will not",
    "wouldn't": "would not",
    "couldn't": "could not",
    "shouldn't": "should not",
    "i'm": "i am",
    "it's": "it is",
    "isn't": "is not",
    "aren't": "are not",
    "wasn't": "was not",
    "weren't": "were not",
    "haven't": "have not",
    "hasn't": "has not",
    "hadn't": "had not",
    "i've": "i have",
    "you've": "you have",
  };
  // Use word boundaries to avoid replacing substrings inside other words.
  for (const [contraction, expansion] of Object.entries(contractions)) {
    const escaped = contraction.replace(/([.*+?^${}()|[\]\\])/g, "\\$1");
    normalized = normalized.replace(new RegExp(`\\b${escaped}\\b`, "g"), expansion);
  }

  // Strip surrounding punctuation, but keep internal apostrophes that are part of words.
  normalized = normalized
    .replace(/^[^a-z0-9]+/g, "")
    .replace(/[^a-z0-9]+$/g, "");

  return normalized;
}

export function matchScaleWord(locale: DialogueLocale, text: string): number | undefined {
  const lowerText = text.toLowerCase();
  const map = locale.scaleWordMap ?? {};
  for (const [score, words] of Object.entries(map)) {
    if (words.some((word) => lowerText.includes(word.toLowerCase()))) {
      return Number(score);
    }
  }
  return undefined;
}

registerLocale(enGB);
registerLocale(cyGB);
