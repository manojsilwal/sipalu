import type pg from 'pg';

const TIER_WEIGHTS: Record<string, number> = {
  TRAINEE: 0.4,
  VERIFIED: 0.65,
  PRO: 0.85,
  ELITE: 1.0,
};

/**
 * Recalculates Composite Visibility Score (0..100) with:
 * - Bayesian smoothed rating, completion rate, bid speed, low cancellation rate, tier weight
 * - 14-day Inactivity & Zero-Job Decay
 * - 14-day New-Provider Onboarding Grace Period (protects cold start from decay)
 * Also evaluates automatic Tier promotion (Trainee -> Verified -> Pro -> Elite when rating >= 4.4)
 */
export async function recalculateProviderRanking(
  client: pg.PoolClient,
  providerUserId: string
): Promise<{
  visibilityScore: number;
  inactivityDecay: number;
  tierCode: string;
}> {
  const { rows } = await client.query(
    `SELECT user_id, tier_code, lifetime_completed_jobs, rolling_avg_rating,
            rolling_completion_rate, rolling_cancellation_rate, median_bid_response_sec,
            new_provider_grace_until, last_completed_job_at, created_at
     FROM provider_profiles
     WHERE user_id = $1`,
    [providerUserId]
  );
  if (!rows[0]) throw new Error('Provider not found');
  const p = rows[0];

  // Refresh rating average from ratings table if any customer-to-provider ratings exist
  const rStats = await client.query(
    `SELECT COUNT(*)::int AS cnt, COALESCE(AVG(overall_stars), 5.0)::numeric(3,2) AS avg_rating
     FROM ratings
     WHERE ratee_user_id = $1 AND direction = 'CUSTOMER_TO_PROVIDER'`,
    [providerUserId]
  );
  const ratingCount = Number(rStats.rows[0].cnt);
  const rawAvg = ratingCount > 0 ? Number(rStats.rows[0].avg_rating) : Number(p.rolling_avg_rating);
  // Bayesian smoothing with prior 4.5 (weight 3)
  const smoothedRating = (rawAvg * ratingCount + 4.5 * 3) / (ratingCount + 3);
  const rNorm = smoothedRating / 5.0;

  const cRate = Math.min(1, Math.max(0, Number(p.rolling_completion_rate)));
  const xCancel = Math.min(1, Math.max(0, Number(p.rolling_cancellation_rate)));
  const bSpeed = Math.max(0, Math.min(1, 1 - Number(p.median_bid_response_sec) / 600));
  const tWeight = TIER_WEIGHTS[p.tier_code] ?? 0.5;

  // Check New-Provider Grace Period vs Inactivity Decay (>14 days since last job)
  const now = Date.now();
  const inGrace =
    p.new_provider_grace_until && new Date(p.new_provider_grace_until).getTime() > now;
  const referenceDate = p.last_completed_job_at
    ? new Date(p.last_completed_job_at).getTime()
    : new Date(p.created_at).getTime();
  const daysInactive = Math.floor((now - referenceDate) / (1000 * 60 * 60 * 24));

  let decay = 0;
  if (!inGrace && daysInactive > 14) {
    decay = Math.min(25, (daysInactive - 14) * 1.5);
  }
  const graceBoost = inGrace ? 5.0 : 0.0;

  const score = Math.max(
    0,
    Math.min(
      100,
      Number(
        (
          (0.35 * rNorm + 0.25 * cRate + 0.15 * bSpeed + 0.15 * (1 - xCancel) + 0.1 * tWeight) *
            100 +
          graceBoost -
          decay
        ).toFixed(2)
      )
    )
  );

  // Automatic Tier Promotion evaluation (rating >= 4.4 required)
  let nextTier = p.tier_code as string;
  const jobs = Number(p.lifetime_completed_jobs);
  if (rawAvg >= 4.4) {
    if (jobs >= 401) nextTier = 'ELITE';
    else if (jobs >= 101) nextTier = 'PRO';
    else if (jobs >= 26) nextTier = 'VERIFIED';
  }

  await client.query(
    `UPDATE provider_profiles
     SET rolling_avg_rating = $1,
         visibility_score = $2,
         tier_code = $3,
         updated_at = NOW()
     WHERE user_id = $4`,
    [rawAvg.toFixed(2), score, nextTier, providerUserId]
  );

  await client.query(
    `INSERT INTO provider_ranking_snapshots (provider_user_id, visibility_score, inactivity_decay_penalty, tier_code)
     VALUES ($1, $2, $3, $4)`,
    [providerUserId, score, decay, nextTier]
  );

  return { visibilityScore: score, inactivityDecay: decay, tierCode: nextTier };
}
