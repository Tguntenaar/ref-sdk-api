-- CreateTable
CREATE TABLE "AccountBlockExistence" (
    "id" SERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "blockHeight" INTEGER NOT NULL,
    "exists" BOOLEAN NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountBlockExistence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountBlockExistence_accountId_blockHeight_idx" ON "AccountBlockExistence"("accountId", "blockHeight");

-- CreateIndex
CREATE UNIQUE INDEX "AccountBlockExistence_accountId_blockHeight_key" ON "AccountBlockExistence"("accountId", "blockHeight");
