-- CreateEnum
CREATE TYPE "CycleType" AS ENUM ('TRIAL_7_DAY', 'PLAN_4_WEEK');

-- CreateEnum
CREATE TYPE "CycleStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CheckInStatus" AS ENUM ('SCHEDULED', 'SENT', 'COMPLETED', 'MISSED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('inbound_message', 'outbound_message', 'observation_extracted', 'state_updated', 'llm_call', 'safety_check', 'checkin_scheduled', 'checkin_sent', 'checkin_completed', 'user_action');

-- CreateEnum
CREATE TYPE "ObservationCategory" AS ENUM ('symptom', 'medication', 'trigger', 'function', 'adverse_event', 'subjective', 'question', 'system_intent', 'profile');

-- CreateEnum
CREATE TYPE "NarrativeScope" AS ENUM ('session', 'cycle', 'longitudinal');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "waId" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en-GB',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "nickname" TEXT,
    "nextVisitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "consentGiven" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "consentVersion" TEXT NOT NULL DEFAULT 'v1',
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "disease" TEXT NOT NULL DEFAULT 'asthma',
    "type" "CycleType" NOT NULL DEFAULT 'TRIAL_7_DAY',
    "status" "CycleStatus" NOT NULL DEFAULT 'ONBOARDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "nextCheckinAt" TIMESTAMP(3),

    CONSTRAINT "cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_ins" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" "CheckInStatus" NOT NULL DEFAULT 'SCHEDULED',
    "sessionObjective" TEXT,
    "questionsAsked" INTEGER NOT NULL DEFAULT 0,
    "budgetRemaining" INTEGER NOT NULL DEFAULT 3,
    "inExceptionMode" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cycleId" TEXT,
    "checkInId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "EventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "platformMessageId" TEXT,
    "traceId" TEXT,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" "ObservationCategory" NOT NULL,
    "concept" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "attributes" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "extractedBy" TEXT NOT NULL DEFAULT 'rule',

    CONSTRAINT "observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_summaries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cycleId" TEXT,
    "scope" "NarrativeScope" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" TEXT NOT NULL,
    "keyObservationIds" TEXT[],
    "model" TEXT,

    CONSTRAINT "narrative_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disease_cards" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cycleId" TEXT,
    "disease" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modules" JSONB NOT NULL,
    "rawSummary" TEXT NOT NULL,
    "model" TEXT,

    CONSTRAINT "disease_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "briefs" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "diseaseCardId" TEXT,
    "webUrl" TEXT NOT NULL,
    "pdfUrl" TEXT,
    "accessToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "briefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "users"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "users_waId_key" ON "users"("waId");

-- CreateIndex
CREATE INDEX "users_phoneNumber_idx" ON "users"("phoneNumber");

-- CreateIndex
CREATE INDEX "cycles_userId_idx" ON "cycles"("userId");

-- CreateIndex
CREATE INDEX "cycles_status_nextCheckinAt_idx" ON "cycles"("status", "nextCheckinAt");

-- CreateIndex
CREATE INDEX "check_ins_cycleId_idx" ON "check_ins"("cycleId");

-- CreateIndex
CREATE INDEX "check_ins_status_scheduledAt_idx" ON "check_ins"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "events_userId_timestamp_idx" ON "events"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "events_cycleId_timestamp_idx" ON "events"("cycleId", "timestamp");

-- CreateIndex
CREATE INDEX "events_type_timestamp_idx" ON "events"("type", "timestamp");

-- CreateIndex
CREATE INDEX "events_platformMessageId_idx" ON "events"("platformMessageId");

-- CreateIndex
CREATE INDEX "observations_userId_cycleId_idx" ON "observations"("userId", "cycleId");

-- CreateIndex
CREATE INDEX "observations_category_concept_idx" ON "observations"("category", "concept");

-- CreateIndex
CREATE INDEX "observations_timestamp_idx" ON "observations"("timestamp");

-- CreateIndex
CREATE INDEX "narrative_summaries_userId_cycleId_idx" ON "narrative_summaries"("userId", "cycleId");

-- CreateIndex
CREATE INDEX "narrative_summaries_scope_generatedAt_idx" ON "narrative_summaries"("scope", "generatedAt");

-- CreateIndex
CREATE INDEX "disease_cards_userId_idx" ON "disease_cards"("userId");

-- CreateIndex
CREATE INDEX "disease_cards_cycleId_idx" ON "disease_cards"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "briefs_cycleId_key" ON "briefs"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "briefs_accessToken_key" ON "briefs"("accessToken");

-- CreateIndex
CREATE INDEX "briefs_accessToken_idx" ON "briefs"("accessToken");

-- AddForeignKey
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "check_ins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_summaries" ADD CONSTRAINT "narrative_summaries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_summaries" ADD CONSTRAINT "narrative_summaries_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disease_cards" ADD CONSTRAINT "disease_cards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
