/**
 * Telemetry and Health Scoring Utility for Project DNA
 * Computes decay, reliability ratios, and quality scores for tools and skills.
 */

export class TelemetryCalculator {
  /**
   * Computes a dynamic health score between 0.0 and 1.0
   * Takes into account overall success rate and penalizes recent failures.
   */
  public static computeHealthScore(
    successCount: number,
    failureCount: number,
    recentFailuresInLast5 = 0
  ): number {
    const total = successCount + failureCount
    if (total === 0) return 1.0

    const rawSuccessRate = successCount / total
    const recentPenalty = Math.min(recentFailuresInLast5 / 5, 1.0) * 0.4
    const finalScore = Math.max(0, rawSuccessRate - recentPenalty)

    return Math.round(finalScore * 100) / 100
  }

  /**
   * Computes exponential decay for confidence score over time if unused
   */
  public static applyTimeDecay(
    currentScore: number,
    lastAccessedTimestamp: string,
    halfLifeDays = 30
  ): number {
    const lastDate = new Date(lastAccessedTimestamp).getTime()
    const now = Date.now()
    const elapsedDays = Math.max(0, (now - lastDate) / (1000 * 60 * 60 * 24))

    const decayFactor = Math.pow(0.5, elapsedDays / halfLifeDays)
    const decayedScore = currentScore * decayFactor

    return Math.round(decayedScore * 100) / 100
  }
}
