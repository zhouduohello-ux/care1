import type { DialogueLocale } from "./index.js";

export const enGB: DialogueLocale = {
  code: "en-GB",
  optionLabels: {
    nighttime_symptoms: ["None", "Mild", "Disturbed sleep", "Woke me up"],
    reliever_use: ["0 times", "1 time", "2 times", "3+ times"],
    activity_limitation: ["No limitation", "Yes, limited"],
  },
  multiSelectFooter: "Reply with all that apply.",
  briefReadyTemplate:
    "Your Asthma Visit Brief is ready. You can view it here: {url}. Please bring it to your appointment or share it with your care team.",
  closingMessages: {
    plan4WeekComplete:
      "You've reached the end of your 4-week CareMemory plan. Reply CONTINUE to start your next 4-week cycle, or STOP to pause.",
    trial7DayComplete:
      "You've completed your 7-day trial. Reply CONTINUE to start a 4-week plan, or STOP to pause.",
    trial7DayCompleteWithBrief:
      "You've completed your 7-day trial. Your Disease Card and Brief are ready. Reply CONTINUE to start a 4-week plan, or STOP to pause.",
  },
  safetyEmpathy: {
    struggling: "I'm sorry you're struggling.",
    adverseEvent: "Thanks for flagging this.",
  },
};
