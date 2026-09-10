function makePdfRecord({ rows = 3, longName = false, allWarnings = false } = {}) {
  const inventory = Array.from({ length: rows }, (_, index) => ({
    sku: `SKU-${String(index + 1).padStart(4, "0")}`,
    item: index === 0 ? "Café winter collection" : `Inventory item ${index + 1}`,
    style: index === 0 ? "Long-sleeve tee - limited edition" : "Classic tee",
    size: ["OS", "M", "L"][index % 3],
    unitCostCents: 500,
    openingQuantity: 100,
    streamSoldQuantity: 1,
    baselineSoldQuantity: 3,
    pendingQuantity: 0,
    replacementQuantity: 97,
    oversoldQuantity: 0,
  }));
  const completedSales = inventory.map((item, index) => ({
    variationNumber: index + 1,
    mapped: true, sku: item.sku, item: item.item, style: item.style, size: item.size,
    soldPriceCents: 1500, unitCostCents: 500, grossProfitCents: 1000, conflicts: [],
  }));
  const itemPerformance = inventory.map((item) => ({
    sku: item.sku, item: item.item, style: item.style, size: item.size,
    soldQuantity: 1, revenueCents: 1500, costOfGoodsCents: 500, grossProfitCents: 1000,
  }));
  return {
    reportId: "stream-report:11111111-1111-4111-8111-111111111111",
    lifecycleStatus: "finalized",
    displayName: longName
      ? "Autumn friends and family collection - September evening stream with special items"
      : "Café September stream",
    report: {
      metadata: {
        streamId: "local-stream:synthetic-pdf-verification-only",
        startedAt: "2026-09-08T01:00:00.000Z", endedAt: "2026-09-08T03:00:00.000Z",
        generatedAt: "2026-09-08T03:00:00.000Z", inventoryBaselineId: "synthetic-baseline",
      },
      totals: {
        completedPaymentCount: rows, totalSalesCount: rows + 1,
        committedSalesCount: rows, completedGmvCents: rows * 1500,
        committedRevenueCents: rows * 1500, costOfGoodsCents: rows * 500,
        grossProfitCents: rows * 1000, unmappedCompletedCount: 0,
        canceledOrderCount: 1, paymentFixingCount: 0, attributedGmvDisplay: `$${(rows * 15).toLocaleString("en-US")}.00`,
      },
      inventory, completedSales, itemPerformance,
      canceledOrders: [{ variationNumber: rows + 1, sku: null }],
      topItems: {
        mostSold: { value: 1, items: inventory.slice(0, 2) },
        mostProfitable: { value: 1000, items: inventory.slice(0, 2) },
      },
      topProducts: {
        mostSold: { value: 2, products: [{ item: "Café winter collection", style: "Classic tee", skus: inventory.slice(0, 2).map((item) => item.sku) }] },
        mostProfitable: null,
      },
      warnings: allWarnings ? [
        { code: "active_bidding_at_end", count: 1 },
        { code: "unresolved_orders", count: 2 },
        { code: "pending_inventory_reservations", count: 2 },
        { code: "payment_fixing_orders", count: 2 },
        { code: "unmapped_completed_sales", count: 1 },
        { code: "reconciliation_conflicts", count: 1 },
        { code: "inventory_recount_required", count: 2, sku: "SKU-0001" },
      ] : [{ code: "unmapped_completed_sales", count: 1 }],
      // Private, non-printed fields must never be copied into generated PDFs.
      oauthToken: "synthetic-secret-not-for-pdf", sourceSheetUrl: "https://private.invalid/sheet",
      buyerName: "synthetic-private-buyer",
    },
  };
}

module.exports = { makePdfRecord };
