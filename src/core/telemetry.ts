/**
 * Telemetry and Health Scoring Utility for Project DNA
 * Computes decay, reliability ratios, and quality scores for tools and skills.
 */

export class TelemetryCalculator {
  /**
   * Computes a dynamic health score between 0.0 and 1.0
   * Multiplicative formula: (Successes / Total) * (1 - FailuresInLast5 / 5)
   */
  public static computeHealthScore(
    successCount: number,
    failureCount: number,
    recentFailuresInLast5 = 0
  ): number {
    const safeSuccess = Math.max(0, successCount)
    const safeFailure = Math.max(0, failureCount)
    const total = safeSuccess + safeFailure
    if (total === 0) return 1.0

    const rawSuccessRate = safeSuccess / total
    const clampedFailures = Math.max(0, Math.min(recentFailuresInLast5, 5))
    const recentMultiplier = 1 - clampedFailures / 5
    const finalScore = rawSuccessRate * recentMultiplier

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
