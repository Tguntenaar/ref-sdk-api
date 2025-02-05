-- CreateTable
CREATE TABLE "RpcRequest" (
    "id" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestBody" JSONB NOT NULL,
    "responseBody" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RpcRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RpcRequest_requestHash_key" ON "RpcRequest"("requestHash");

-- CreateIndex
CREATE INDEX "RpcRequest_timestamp_idx" ON "RpcRequest"("timestamp");
