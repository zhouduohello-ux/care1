export interface DiseaseCardModule {
  id: string;
  title: string;
  type: "headline" | "control_status" | "symptom_trend" | "medication" | "adverse_events" | "subjective" | "triggers" | "questions" | "safety";
  content: unknown;
  confidence?: number;
}

export interface GeneratedDiseaseCard {
  disease: string;
  version: number;
  modules: DiseaseCardModule[];
  rawSummary: string;
}
