import type { Observation } from "@carememory/db";
import type { DiseaseCardModule, GeneratedDiseaseCard } from "./types.js";

export function generateDiseaseCard(
  disease: string,
  observations: Observation[],
  patientNickname?: string | null,
  previousVersion?: number
): GeneratedDiseaseCard {
  const modules: DiseaseCardModule[] = [];

  // Group observations by concept
  const byConcept = new Map<string, Observation[]>();
  for (const obs of observations) {
    const list = byConcept.get(obs.concept) ?? [];
    list.push(obs);
    byConcept.set(obs.concept, list);
  }

  // Headline
  const control = assessControl(byConcept);
  modules.push({
    id: "headline",
    title: "Summary",
    type: "headline",
    content: `${patientNickname ?? "You"}’s asthma has been ${control.status.toLowerCase()} over this period.`,
  });

  // Control status
  modules.push({
    id: "control_status",
    title: "Control Status",
    type: "control_status",
    content: {
      status: control.status,
      reason: control.reason,
      confidence: control.confidence,
    },
  });

  // Symptom trend
  const nightObs = byConcept.get("nighttime_symptoms") ?? [];
  if (nightObs.length > 0) {
    modules.push({
      id: "symptom_trend",
      title: "Nighttime Symptoms",
      type: "symptom_trend",
      content: {
        latest: nightObs[nightObs.length - 1]?.value,
        count: nightObs.length,
        values: nightObs.map((o) => o.value),
      },
      confidence: nightObs.length < 3 ? 0.6 : 0.9,
    });
  }

  // Medication / reliever use
  const relieverObs = byConcept.get("reliever_use") ?? [];
  if (relieverObs.length > 0) {
    modules.push({
      id: "medication",
      title: "Reliever Inhaler Use",
      type: "medication",
      content: {
        latest: relieverObs[relieverObs.length - 1]?.value,
        count: relieverObs.length,
        values: relieverObs.map((o) => o.value),
      },
    });
  }

  // Controller adherence
  const adherenceObs = byConcept.get("controller_adherence") ?? [];
  if (adherenceObs.length > 0) {
    modules.push({
      id: "controller_adherence",
      title: "Controller Adherence",
      type: "medication",
      content: {
        latest: adherenceObs[adherenceObs.length - 1]?.value,
        count: adherenceObs.length,
        values: adherenceObs.map((o) => o.value),
      },
    });
  }

  // Activity limitation
  const activityObs = byConcept.get("activity_limitation") ?? [];
  if (activityObs.length > 0) {
    modules.push({
      id: "function",
      title: "Activity Limitation",
      type: "subjective",
      content: {
        latest: activityObs[activityObs.length - 1]?.value,
        count: activityObs.length,
      },
    });
  }

  // Adverse events / concerns raised during exception mode
  const adverseEventObs = observations.filter(
    (o) =>
      o.category === "adverse_event" ||
      ((o.attributes as Record<string, unknown> | null)?.exceptionConcern === true)
  );
  if (adverseEventObs.length > 0) {
    modules.push({
      id: "adverse_events",
      title: "Adverse Events / Concerns",
      type: "adverse_events",
      content: adverseEventObs.map((o) => ({
        concept: o.concept,
        value: o.value,
        timestamp: o.timestamp,
        clarified: ((o.attributes as Record<string, unknown> | null)?.clarified === true),
      })),
    });
  }

  // Triggers
  const triggerObs = observations.filter((o) => o.category === "trigger");
  if (triggerObs.length > 0) {
    modules.push({
      id: "triggers",
      title: "Triggers / Exposures",
      type: "triggers",
      content: triggerObs.map((o) => o.value),
    });
  }

  // Patient questions
  const questionObs = observations.filter((o) => o.category === "question");
  if (questionObs.length > 0) {
    modules.push({
      id: "questions",
      title: "Questions for Your Doctor",
      type: "questions",
      content: questionObs.map((o) => o.value),
    });
  }

  // Safety notice
  modules.push({
    id: "safety",
    title: "Safety Notice",
    type: "safety",
    content: "If you're having severe breathing problems, call 999 or follow your asthma action plan.",
  });

  const rawSummary = modules.map((m) => `${m.title}: ${JSON.stringify(m.content)}`).join("\n");

  return {
    disease,
    version: (previousVersion ?? 0) + 1,
    modules,
    rawSummary,
  };
}

function assessControl(byConcept: Map<string, Observation[]>): {
  status: "Well controlled" | "Needs attention" | "Unstable";
  reason: string;
  confidence: number;
} {
  const reliever = byConcept.get("reliever_use") ?? [];
  const latestReliever = reliever[reliever.length - 1]?.value;
  const nights = byConcept.get("nighttime_symptoms") ?? [];
  const latestNight = nights[nights.length - 1]?.value;
  const activity = byConcept.get("activity_limitation") ?? [];
  const latestActivity = activity[activity.length - 1]?.value;

  if (latestReliever === "3_or_more" || latestNight === "woke_me_up") {
    return {
      status: "Unstable",
      reason: "Recent high reliever use or nighttime waking suggests symptoms are not well controlled.",
      confidence: 0.7,
    };
  }

  if (latestReliever === 0 || latestReliever === 1) {
    if (latestNight === "none" && latestActivity !== "yes") {
      return {
        status: "Well controlled",
        reason: "Low reliever use, no nighttime symptoms, and no activity limitation reported.",
        confidence: 0.8,
      };
    }
  }

  return {
    status: "Needs attention",
    reason: "Some symptoms or reliever use were reported. Monitor and discuss at your next review.",
    confidence: 0.6,
  };
}
