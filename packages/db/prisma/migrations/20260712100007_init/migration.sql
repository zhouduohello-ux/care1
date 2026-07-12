-- Adds session-level turn budget tracking to check-ins.
-- Migration name defaulted to 'init' by Prisma tooling; content is add_turn_count_budget.
ALTER TABLE "check_ins" ADD COLUMN     "turnBudget" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "turnCount" INTEGER NOT NULL DEFAULT 0;
