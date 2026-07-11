import type { DialogueLocale } from "./index.js";

export const enGB: DialogueLocale = {
  code: "en-GB",
  optionLabels: {
    nighttime_symptoms: ["None", "Mild", "Disturbed sleep", "Woke me up"],
    reliever_use: ["0 times", "1 time", "2 times", "3+ times"],
    activity_limitation: ["No limitation", "Yes, limited"],
  },
  optionSynonyms: {
    night_none: ["none", "no symptoms", "didn't wake", "slept fine"],
    night_mild: ["mild", "slight", "a little"],
    night_disturbed: ["disturbed sleep", "woke briefly", "kept waking"],
    night_woke_up: ["woke me up", "woken up", "woke up", "kept me awake", "cough woke"],
    reliever_0: ["0", "none", "didn't use", "not at all"],
    reliever_1: ["1", "once"],
    reliever_2: ["2", "twice"],
    reliever_3_plus: ["3", "3+", "three or more", "several times", "a lot"],
    activity_no: ["no", "not limited", "no limitation", "fine"],
    activity_yes: ["yes", "limited", "couldn't exercise", "struggled"],
  },
  scaleWordMap: {
    1: ["none", "mild", "good"],
    2: ["slight", "a little", "mild"],
    3: ["moderate", "okay", "average"],
    4: ["bad", "quite bad", "worse"],
    5: ["severe", "very bad", "worst", "terrible"],
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
