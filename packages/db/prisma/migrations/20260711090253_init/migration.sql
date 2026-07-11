-- AlterEnum
ALTER TYPE "EventType" ADD VALUE 'turn_reprompt';

-- AlterTable
ALTER TABLE "check_ins" ADD COLUMN     "pendingQuestion" JSONB,
ADD COLUMN     "repromptCount" INTEGER NOT NULL DEFAULT 0;
