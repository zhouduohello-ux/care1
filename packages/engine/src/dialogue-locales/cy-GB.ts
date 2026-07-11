import type { DialogueLocale } from "./index.js";

export const cyGB: DialogueLocale = {
  code: "cy-GB",
  optionLabels: {
    nighttime_symptoms: ["Dim", "Ysgafn", "Cwsg wedi'i darfu", "Deffroais i"],
    reliever_use: ["0 gwaith", "1 gwaith", "2 waith", "3+ gwaith"],
    activity_limitation: ["Dim cyfyngiad", "Ydy, cyfyngedig"],
  },
  multiSelectFooter: "Atebwch gyda'r hyn sy'n berthnasol.",
  briefReadyTemplate:
    "Mae eich Crynodeb Ymweliad Asthma yn barod. Gallwch ei weld yma: {url}. Dewch ag ef i'ch apwyntiad neu rannwch ef â'ch tîm gofal.",
  closingMessages: {
    plan4WeekComplete:
      "Rydych chi wedi cyrraedd diwedd eich cynllun CareMemory 4 wythnos. Atebwch CONTINUE i ddechrau eich cylch 4 wythnos nesaf, neu STOP i'w oedi.",
    trial7DayComplete:
      "Rydych chi wedi cwblhau eich treial 7 diwrnod. Atebwch CONTINUE i ddechrau cynllun 4 wythnos, neu STOP i'w oedi.",
    trial7DayCompleteWithBrief:
      "Rydych chi wedi cwblhau eich treial 7 diwrnod. Mae'ch Cerdyn Clefyd a'ch Crynodeb yn barod. Atebwch CONTINUE i ddechrau cynllun 4 wythnos, neu STOP i'w oedi.",
  },
  safetyEmpathy: {
    struggling: "Mae'n ddrwg gen i eich bod chi'n cael trafferth.",
    adverseEvent: "Diolch am nodi hyn.",
  },
};
