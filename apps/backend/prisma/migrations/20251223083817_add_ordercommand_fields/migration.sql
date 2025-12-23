/*
  Warnings:

  - Added the required column `updatedAt` to the `OrderCommand` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OrderCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "binanceOrderId" INTEGER,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "price" REAL,
    "stopPrice" REAL,
    "timeInForce" TEXT,
    "status" TEXT NOT NULL,
    "rawStatus" TEXT,
    "executedQty" REAL NOT NULL DEFAULT 0,
    "cummulativeQuoteQty" REAL DEFAULT 0,
    "avgFillPrice" REAL,
    "lastTradeQty" REAL,
    "lastTradePrice" REAL,
    "errorCode" TEXT,
    "errorMsg" TEXT,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastExchangeUpdateAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_OrderCommand" ("createdAt", "id", "orderId", "quantity", "side", "status", "symbol", "type", "userId") SELECT "createdAt", "id", "orderId", "quantity", "side", "status", "symbol", "type", "userId" FROM "OrderCommand";
DROP TABLE "OrderCommand";
ALTER TABLE "new_OrderCommand" RENAME TO "OrderCommand";
CREATE UNIQUE INDEX "OrderCommand_orderId_key" ON "OrderCommand"("orderId");
CREATE INDEX "OrderCommand_userId_createdAt_idx" ON "OrderCommand"("userId", "createdAt");
CREATE INDEX "OrderCommand_symbol_idx" ON "OrderCommand"("symbol");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
