// Helper function to format dates
export function formatDate(timestamp: number, period: number): string {
  const date = new Date(timestamp);
  if (period <= 1) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: period >= 1 ? undefined : "numeric",
    });
  }

  if (period < 24 * 30) {
    return date.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
  }

  if (period === 24 * 30) {
    return date.toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    });
  }

  return date.toLocaleDateString("en-US", { year: "numeric" });
}
