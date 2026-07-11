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
  const lowerText = text.toLowerCase();
  return synonyms.some((phrase) => lowerText.includes(phrase.toLowerCase()));
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
