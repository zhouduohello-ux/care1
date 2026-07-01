-- DropIndex
DROP INDEX "events_platformMessageId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "events_platformMessageId_key" ON "events"("platformMessageId");
