import crypto from "node:crypto";

export type ExperimentName = "checkin_frequency" | "conversation_style";

export interface ExperimentConfig {
  defaultVariant: string;
  variants: string[];
  split: number[]; // cumulative percentages (0-100), last must be 100
}

const EXPERIMENTS: Record<ExperimentName, ExperimentConfig> = {
  checkin_frequency: {
    defaultVariant: "48h",
    variants: ["48h", "72h"],
    split: [50, 100],
  },
  conversation_style: {
    defaultVariant: "v1",
    variants: ["v1", "v2"],
    split: [80, 100],
  },
};

function isEnabled(name: ExperimentName): boolean {
  return process.env[`EXPERIMENT_${name.toUpperCase()}_ENABLED`] !== "false";
}

function getConfiguredSplit(name: ExperimentName): number[] | undefined {
  const raw = process.env[`EXPERIMENT_${name.toUpperCase()}_SPLIT`];
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
  if (parts.length === 0) return undefined;
  // Convert counts/percentages into cumulative split.
  const total = parts.reduce((a, b) => a + b, 0);
  let acc = 0;
  const split = parts.map((p) => {
    acc += p;
    return total > 0 ? Math.round((acc / total) * 100) : 0;
  });
  if (split[split.length - 1] !== 100 && split.length > 0) {
    split[split.length - 1] = 100;
  }
  return split;
}

export function getBucket(userId: string, name: ExperimentName): { variant: string; experiments: Record<string, string> } {
  const config = EXPERIMENTS[name];
  if (!isEnabled(name)) {
    return { variant: config.defaultVariant, experiments: { [name]: config.defaultVariant } };
  }

  const hash = crypto.createHash("sha256").update(`${name}:${userId}`).digest("hex");
  const bucket = Number.parseInt(hash.slice(0, 8), 16) % 100;
  const split = getConfiguredSplit(name) ?? config.split;

  let variant = config.defaultVariant;
  for (let i = 0; i < config.variants.length; i++) {
    if (bucket < (split[i] ?? 100)) {
      variant = config.variants[i] ?? config.defaultVariant;
      break;
    }
  }

  return { variant, experiments: { [name]: variant } };
}

export function scheduleNextCheckInOffset(userId: string, baseNow: Date): Date {
  const bucket = getBucket(userId, "checkin_frequency");
  const hours = bucket.variant === "72h" ? 72 : 48;
  const next = new Date(baseNow.getTime() + hours * 60 * 60 * 1000);
  next.setHours(10, 0, 0, 0);
  return next;
}
