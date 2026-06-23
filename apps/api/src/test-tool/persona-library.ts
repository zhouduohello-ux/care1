import type { Clock } from "../plugins/clock.js";
import type { PrismaClient } from "@carememory/db";

export interface Persona {
  id: string;
  name: string;
  description: string;
  user: {
    nickname?: string;
    timezone: string;
    locale: string;
    nextVisitDays?: number;
  };
  cycle: {
    status: "ONBOARDING" | "ACTIVE";
    nextCheckinOffset?: "tomorrow_10am" | "now";
    startedAtOffsetDays?: number;
  };
}

const personas: Persona[] = [
  {
    id: "controlled_asthma",
    name: "Controlled asthma",
    description: "Control is good, regular preventer, no night symptoms.",
    user: { nickname: "Sarah", timezone: "Europe/London", locale: "en-GB", nextVisitDays: 30 },
    cycle: { status: "ACTIVE", nextCheckinOffset: "tomorrow_10am" },
  },
  {
    id: "worsening_asthma",
    name: "Worsening asthma",
    description: "Night symptoms increasing, reliever use rising.",
    user: { nickname: "Mike", timezone: "Europe/London", locale: "en-GB", nextVisitDays: 14 },
    cycle: { status: "ACTIVE", nextCheckinOffset: "tomorrow_10am", startedAtOffsetDays: 2 },
  },
  {
    id: "exercise_trigger",
    name: "Exercise triggered",
    description: "Symptoms mainly after sport or running.",
    user: { nickname: "Emma", timezone: "Europe/London", locale: "en-GB", nextVisitDays: 21 },
    cycle: { status: "ACTIVE", nextCheckinOffset: "tomorrow_10am" },
  },
  {
    id: "adverse_event",
    name: "Adverse event",
    description: "Reports a reaction or side-effect to a medication.",
    user: { nickname: "Priya", timezone: "Europe/London", locale: "en-GB", nextVisitDays: 10 },
    cycle: { status: "ACTIVE", nextCheckinOffset: "tomorrow_10am" },
  },
  {
    id: "non_responder",
    name: "Non responder",
    description: "Does not reply to check-ins; useful for reminder flow testing.",
    user: { nickname: "NoReply", timezone: "Europe/London", locale: "en-GB" },
    cycle: { status: "ACTIVE", nextCheckinOffset: "tomorrow_10am" },
  },
  {
    id: "early_quit",
    name: "Early quit",
    description: "Onboarding started but patient has not yet consented.",
    user: { nickname: "Alex", timezone: "Europe/London", locale: "en-GB" },
    cycle: { status: "ONBOARDING" },
  },
];

export function listPersonas(): Persona[] {
  return personas.map((p) => ({ id: p.id, name: p.name, description: p.description, user: p.user, cycle: p.cycle }));
}

export function getPersona(id: string): Persona | undefined {
  return personas.find((p) => p.id === id);
}

export async function loadPersona(
  prisma: PrismaClient,
  clock: Clock,
  phoneNumber: string,
  personaId: string
): Promise<{ userId: string; persona: Persona }> {
  const persona = getPersona(personaId);
  if (!persona) {
    throw new Error(`Unknown persona: ${personaId}`);
  }

  // Hard-delete any existing test user with the same phone number to ensure a clean state.
  const existing = await prisma.user.findUnique({ where: { phoneNumber } });
  if (existing) {
    const cycles = await prisma.cycle.findMany({ where: { userId: existing.id }, select: { id: true } });
    const cycleIds = cycles.map((c) => c.id);
    await prisma.brief.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.diseaseCard.deleteMany({ where: { userId: existing.id } });
    await prisma.narrativeSummary.deleteMany({ where: { userId: existing.id } });
    await prisma.observation.deleteMany({ where: { userId: existing.id } });
    await prisma.event.deleteMany({ where: { userId: existing.id } });
    await prisma.checkIn.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.cycle.deleteMany({ where: { userId: existing.id } });
    await prisma.user.delete({ where: { id: existing.id } });
  }

  const now = clock.now();
  const nextVisitAt = persona.user.nextVisitDays
    ? new Date(now.getTime() + persona.user.nextVisitDays * 24 * 60 * 60 * 1000)
    : undefined;

  const user = await prisma.user.create({
    data: {
      phoneNumber,
      nickname: persona.user.nickname,
      timezone: persona.user.timezone,
      locale: persona.user.locale,
      nextVisitAt,
    },
  });

  const cycleData: Parameters<PrismaClient["cycle"]["create"]>[0]["data"] = {
    userId: user.id,
    disease: "asthma",
    status: persona.cycle.status,
    startedAt: persona.cycle.startedAtOffsetDays
      ? new Date(now.getTime() - persona.cycle.startedAtOffsetDays * 24 * 60 * 60 * 1000)
      : now,
  };

  if (persona.cycle.status === "ACTIVE") {
    if (persona.cycle.nextCheckinOffset === "now") {
      cycleData.nextCheckinAt = now;
    } else {
      const next = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      next.setHours(10, 0, 0, 0);
      cycleData.nextCheckinAt = next;
    }
  }

  await prisma.cycle.create({ data: cycleData });

  return { userId: user.id, persona };
}
