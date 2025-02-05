-- AlterTable
ALTER TABLE "TokenBalanceHistory" ADD COLUMN     "period" TEXT NOT NULL DEFAULT '1Y';

-- CreateIndex
CREATE INDEX "TokenBalanceHistory_account_id_token_id_period_timestamp_idx" ON "TokenBalanceHistory"("account_id", "token_id", "period", "timestamp");
