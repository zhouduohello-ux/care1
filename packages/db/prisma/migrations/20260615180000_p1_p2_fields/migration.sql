-- AlterTable
ALTER TABLE "check_ins" ADD COLUMN     "exceptionQuestionsAsked" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "disease_cards" ADD COLUMN     "accessToken" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "llmInput" JSONB,
ADD COLUMN     "llmModel" TEXT,
ADD COLUMN     "llmOutput" JSONB,
ADD COLUMN     "tokenUsage" JSONB;

-- AlterTable
ALTER TABLE "observations" ADD COLUMN     "superseded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supersededById" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "age" INTEGER,
ADD COLUMN     "lastInboundAt" TIMESTAMP(3),
ADD COLUMN     "medications" JSONB,
ADD COLUMN     "sessionWindowExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "disease_cards_accessToken_key" ON "disease_cards"("accessToken");

-- CreateIndex
CREATE INDEX "disease_cards_accessToken_idx" ON "disease_cards"("accessToken");

-- CreateIndex
CREATE UNIQUE INDEX "events_idempotencyKey_key" ON "events"("idempotencyKey");

-- CreateIndex
CREATE INDEX "observations_supersededById_idx" ON "observations"("supersededById");

