import type { PrismaClient, User, Cycle } from "@carememory/db";
import type { OutboundMessage } from "@carememory/im-core";

export type OnboardingField = "nickname" | "age" | "nextVisitAt" | "medications" | null;

type OnboardingUser = Pick<User, "consentGiven" | "nickname" | "age" | "nextVisitAt" | "medications" | "timezone">;

export function getPendingOnboardingField(user: OnboardingUser): OnboardingField {
  if (!user.consentGiven) return null;
  if (!user.nickname) return "nickname";
  if (user.age == null) return "age";
  if (!user.nextVisitAt) return "nextVisitAt";
  if (!user.medications) return "medications";
  return null;
}

function isSkip(text: string): boolean {
  return text.trim().toUpperCase() === "SKIP";
}

function parseAge(text: string): number | null {
  const match = text.match(/\b(\d{1,3})\b/);
  if (!match) return null;
  const age = parseInt(match[1], 10);
  return age > 0 && age < 150 ? age : null;
}

function parseNextVisit(text: string, now: Date): Date | null {
  const t = text.trim().toLowerCase();
  if (t === "skip" || t === "") return null;

  // Try ISO date
  const iso = Date.parse(t);
  if (!Number.isNaN(iso)) {
    const d = new Date(iso);
    if (d.getTime() > now.getTime()) return d;
  }

  // Try "in X weeks"
  const weeksMatch = t.match(/in\s+(\d+)\s*weeks?/);
  if (weeksMatch) {
    const d = new Date(now.getTime() + parseInt(weeksMatch[1], 10) * 7 * 24 * 60 * 60 * 1000);
    return d;
  }

  return null;
}

export function classifyMedicationType(name: string): "controller" | "reliever" | "unspecified" {
  const lower = name.toLowerCase();
  const controllerKeywords = [
    "controller",
    "preventer",
    "seretide",
    "symbicort",
    "flixotide",
    "fluticasone",
    "budesonide",
    "beclometasone",
    "beclomethasone",
    "mometasone",
    "ciclesonide",
    "qvar",
    "clenil",
    "fostair",
    "pulmicort",
  ];
  const relieverKeywords = [
    "reliever",
    "ventolin",
    "salbutamol",
    "albuterol",
    "bricanyl",
    "terbutaline",
  ];
  const isController = controllerKeywords.some((k) => lower.includes(k));
  const isReliever = relieverKeywords.some((k) => lower.includes(k));
  if (isController && !isReliever) return "controller";
  if (isReliever && !isController) return "reliever";
  return "unspecified";
}

export function parseMedications(text: string): { baseline: Array<{ name: string; type: "controller" | "reliever" | "unspecified" }> } | null {
  if (isSkip(text)) return { baseline: [] };
  const parts = text.split(/[,;/]\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return {
    baseline: parts.map((part) => {
      // Accept "Name (type)" or "Name - type"
      const explicitTypeMatch = part.match(/^(.+?)\s*[\(\-:]\s*(controller|reliever|preventer)\s*\)?$/i);
      if (explicitTypeMatch) {
        const name = explicitTypeMatch[1].trim();
        const rawType = explicitTypeMatch[2].toLowerCase();
        const type = rawType === "preventer" ? "controller" : (rawType as "controller" | "reliever");
        return { name, type };
      }
      return { name: part, type: classifyMedicationType(part) };
    }),
  };
}

export interface OnboardingResult {
  messages: OutboundMessage[];
  finalised: boolean;
}

export async function handleOnboardingInput(
  prisma: PrismaClient,
  user: User,
  cycle: Cycle,
  text: string,
  now: Date
): Promise<OnboardingResult> {
  const userId = user.phoneNumber;
  const field = getPendingOnboardingField(user);

  if (field === "nickname") {
    const nickname = isSkip(text) ? "there" : text.trim().slice(0, 40) || "there";
    await prisma.user.update({ where: { id: user.id }, data: { nickname } });
    return askNext(userId, { ...user, nickname });
  }

  if (field === "age") {
    if (isSkip(text)) {
      await prisma.user.update({ where: { id: user.id }, data: { age: null } });
      return askNext(userId, { ...user, age: null });
    }
    const age = parseAge(text);
    if (age == null) {
      return {
        messages: [buildMessage(userId, "I didn't catch your age. Please reply with a number (e.g. 34).")],
        finalised: false,
      };
    }
    await prisma.user.update({ where: { id: user.id }, data: { age } });
    if (age < 18) {
      await prisma.cycle.update({ where: { id: cycle.id }, data: { status: "CANCELLED", endedAt: now } });
      return {
        messages: [buildMessage(userId, "CareMemory is currently only available for adults aged 18 and over. Your account has not been activated.")],
        finalised: true,
      };
    }
    return askNext(userId, { ...user, age });
  }

  if (field === "nextVisitAt") {
    const nextVisitAt = parseNextVisit(text, now);
    await prisma.user.update({ where: { id: user.id }, data: { nextVisitAt } });
    return askNext(userId, { ...user, nextVisitAt });
  }

  if (field === "medications") {
    const medications = parseMedications(text);
    if (!medications) {
      return {
        messages: [buildMessage(userId, "Please tell me the names of your asthma medications (controller and reliever inhalers), separated by commas, or reply SKIP.")],
        finalised: false,
      };
    }
    await prisma.user.update({ where: { id: user.id }, data: { medications: medications as any } });

    // Finalise onboarding
    const nextCheckinAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    nextCheckinAt.setHours(10, 0, 0, 0);
    await prisma.cycle.update({
      where: { id: cycle.id },
      data: { status: "ACTIVE", nextCheckinAt },
    });

    const nickname = user.nickname && user.nickname !== "there" ? user.nickname : "there";
    return {
      messages: [
        buildMessage(
          userId,
          `Thanks ${nickname}, you're all set. I'll send your first check-in tomorrow around 10:00 ${user.timezone}. You can reply HELP at any time.`
        ),
      ],
      finalised: true,
    };
  }

  return { messages: [], finalised: true };
}

export function askNext(userId: string, user: OnboardingUser): OnboardingResult {
  const field = getPendingOnboardingField(user);

  if (field === "nickname") {
    return {
      messages: [buildMessage(userId, "What would you like me to call you? (Reply with your nickname or SKIP)")],
      finalised: false,
    };
  }

  if (field === "age") {
    return {
      messages: [buildMessage(userId, "How old are you? CareMemory is currently for adults 18+.")],
      finalised: false,
    };
  }

  if (field === "nextVisitAt") {
    return {
      messages: [
        buildMessage(
          userId,
          `When is your next asthma review? Reply with a date (e.g. 2025-07-15) or "in 3 weeks", or SKIP.`
        ),
      ],
      finalised: false,
    };
  }

  if (field === "medications") {
    return {
      messages: [
        buildMessage(
          userId,
          "What asthma medications do you use regularly? E.g. Seretide (controller), Ventolin (reliever). You can also write 'Name - controller/reliever'. Reply with names separated by commas, or SKIP."
        ),
      ],
      finalised: false,
    };
  }

  return { messages: [], finalised: true };
}

function buildMessage(userId: string, text: string): OutboundMessage {
  return {
    userId,
    conversationContext: { requiresSession: true, priority: "normal" },
    content: { type: "text", text },
  };
}
