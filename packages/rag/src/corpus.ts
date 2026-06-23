export interface CorpusDocument {
  source: string;
  content: string;
}

const ASTHMA_CORPUS: CorpusDocument[] = [
  {
    "source": "care-strategy.md",
    "content": "# Asthma Care Strategy\n\nThe goal between visits is to detect worsening control early and prompt review, without over-burdening the patient.\n\nFollow-up dimensions (priority order):\n1. **Nighttime symptoms** — earliest signal of loss of control.\n2. **Reliever use** — increasing use suggests inadequate preventer control.\n3. **Activity limitation** — impact on daily life and exercise.\n4. **Triggers** — pollen, dust, cold air, exercise, infections.\n5. **Adherence** — controller inhaler use as prescribed.\n\nSession budget: 3 short questions per check-in. If the patient reports severe symptoms or a possible adverse event, escalate immediately with safety addendums and do not consume the whole budget.\n\nWhen all dimensions are covered and stable, close the check-in and update the Disease Card.\n"
  },
  {
    "source": "conversation-patterns.md",
    "content": "# Asthma Conversation Patterns\n\n## Onboarding\n\"Hi, I'm CareMemory. I help you keep a light record of your asthma between appointments. This is not a diagnosis tool. Reply AGREE to continue.\"\n\n## Check-in questions\n- \"Track nighttime cough or wheeze over the past 2 days.\"\n- \"How often have you used your reliever inhaler?\"\n- \"Has asthma limited your daily activities or exercise?\"\n\n## Closing\n\"Thank you for your updates. Your Disease Card will be updated shortly.\"\n\n## Safety addendum (always append to medical outbound)\n\"If you're having severe breathing problems, call 999 or follow your asthma action plan.\"\n"
  },
  {
    "source": "medical-overview.md",
    "content": "# Asthma Medical Overview\n\nAsthma is a chronic inflammatory disease of the airways. It causes variable symptoms such as wheeze, cough, chest tightness, and shortness of breath. Symptom control can change from day to day and week to week.\n\nKey markers of poor control include:\n- Nighttime waking due to cough or wheeze.\n- Need for a reliever inhaler more than 2 days per week.\n- Activity limitation due to asthma.\n- Frequent exacerbations or oral-steroid courses.\n\nSevere symptoms (unable to speak, blue lips, no relief from reliever, peak flow <50% best) require emergency care — call 999 in the UK.\n\nCareMemory records are patient-reported and do not replace clinical assessment.\n"
  },
  {
    "source": "safety-rules.md",
    "content": "# Asthma Safety Rules\n\n## Must never say\n- \"You are having an asthma attack.\"\n- \"You should increase your inhaler dose.\"\n- \"You do not need to see a doctor.\"\n- Any diagnosis or treatment advice based on patient-reported data.\n\n## Must always say\n- \"If you're having severe breathing problems, call 999 or follow your asthma action plan.\"\n- \"This is based on patient-reported information only and is not medical advice.\"\n\n## Escalation triggers\nUser message contains any of: severe, can't breathe, cannot breathe, difficulty breathing, worst, 999, emergency, ambulance, blue lips, peak flow low, no relief from inhaler.\n\nAction: send urgent safety response directing to emergency services.\n"
  }
];

export const CORPUS_DOCUMENTS: Record<string, CorpusDocument[]> = {
  asthma: ASTHMA_CORPUS,
};
