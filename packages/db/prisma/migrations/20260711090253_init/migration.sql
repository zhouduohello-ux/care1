-- AlterEnum
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'turn_reprompt';

-- AlterTable
ALTER TABLE "check_ins" ADD COLUMN IF NOT EXISTS "pendingQuestion" JSONB;
ALTER TABLE "check_ins" ADD COLUMN IF NOT EXISTS "repromptCount" INTEGER NOT NULL DEFAULT 0;
