export interface DialogueLocale {
  /** ISO locale code, e.g. "en-GB". */
  code: string;
  /** Localised labels for known single/multi-select topics. */
  optionLabels: Record<string, string[]>;
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

registerLocale(enGB);
registerLocale(cyGB);
