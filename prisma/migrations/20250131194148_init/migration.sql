-- CreateTable
CREATE TABLE "TokenBalanceHistory" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "balance_history" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenBalanceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FTToken" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "totalCumulativeAmt" DOUBLE PRECISION NOT NULL,
    "fts" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FTToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NearPrice" (
    "id" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NearPrice_pkey" PRIMARY KEY ("id")
);
