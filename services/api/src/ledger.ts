import type pg from 'pg';

export interface LedgerLine {
  accountCode: string;
  debitNpr?: number;
  creditNpr?: number;
}

export async function ensureProviderLedgerAccounts(
  client: pg.PoolClient,
  providerUserId: string
): Promise<{ floatAccountId: string; payableAccountId: string }> {
  const floatCode = `PROV_FLOAT:${providerUserId}`;
  const payableCode = `PROV_PAYABLE:${providerUserId}`;

  const fRes = await client.query(
    `INSERT INTO ledger_accounts (code, account_type, owner_user_id)
     VALUES ($1, 'LIABILITY', $2)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [floatCode, providerUserId]
  );
  const pRes = await client.query(
    `INSERT INTO ledger_accounts (code, account_type, owner_user_id)
     VALUES ($1, 'LIABILITY', $2)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [payableCode, providerUserId]
  );

  await client.query(
    `INSERT INTO provider_float_wallets (provider_user_id, ledger_account_id)
     VALUES ($1, $2)
     ON CONFLICT (provider_user_id) DO NOTHING`,
    [providerUserId, fRes.rows[0].id]
  );

  return {
    floatAccountId: fRes.rows[0].id,
    payableAccountId: pRes.rows[0].id,
  };
}

/**
 * Posts an immutable, strictly balanced double-entry ledger transaction.
 * Enforces idempotency_key uniqueness and SUM(debit) === SUM(credit).
 */
export async function postDoubleEntryTransaction(
  client: pg.PoolClient,
  params: {
    idempotencyKey: string;
    bookingId?: string | null;
    referenceType: string;
    description: string;
    lines: LedgerLine[];
  }
): Promise<{ transactionId: string; deduplicated: boolean }> {
  // Check idempotency first
  const existing = await client.query(
    `SELECT id FROM ledger_transactions WHERE idempotency_key = $1`,
    [params.idempotencyKey]
  );
  if (existing.rows[0]) {
    return { transactionId: existing.rows[0].id, deduplicated: true };
  }

  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of params.lines) {
    const d = round2(line.debitNpr || 0);
    const c = round2(line.creditNpr || 0);
    if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
      throw new Error(`Invalid ledger line for ${line.accountCode}: must be single-sided non-zero`);
    }
    totalDebit = round2(totalDebit + d);
    totalCredit = round2(totalCredit + c);
  }

  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    throw new Error(
      `Double-entry imbalance rejected: debit=${totalDebit} != credit=${totalCredit}`
    );
  }

  const txRes = await client.query(
    `INSERT INTO ledger_transactions (idempotency_key, booking_id, reference_type, description)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [params.idempotencyKey, params.bookingId || null, params.referenceType, params.description]
  );
  const txId = txRes.rows[0].id;

  for (const line of params.lines) {
    const d = round2(line.debitNpr || 0);
    const c = round2(line.creditNpr || 0);
    const acctRes = await client.query(`SELECT id, account_type FROM ledger_accounts WHERE code = $1`, [
      line.accountCode,
    ]);
    if (!acctRes.rows[0]) {
      throw new Error(`Ledger account not found: ${line.accountCode}`);
    }
    const { id: accountId, account_type: acctType } = acctRes.rows[0];
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, debit_npr, credit_npr)
       VALUES ($1, $2, $3, $4)`,
      [txId, accountId, d, c]
    );
    // Normal balance: ASSET/EXPENSE increase on debit; LIABILITY/REVENUE/EQUITY increase on credit
    const delta =
      acctType === 'ASSET' || acctType === 'EXPENSE' ? round2(d - c) : round2(c - d);
    await client.query(
      `UPDATE ledger_accounts SET balance_npr = balance_npr + $1 WHERE id = $2`,
      [delta, accountId]
    );
  }

  return { transactionId: txId, deduplicated: false };
}

/**
 * Calculates Sipalu commission breakdown strictly honoring PRD & SOP-04:
 * - Commission applies ONLY to labor (quoted_labor + approved_change_order_labor).
 * - Visiting fee (NPR 100), MRP spare parts, and 100% customer tips pass through with 0% commission.
 */
export function computeSettlementBreakdown(params: {
  laborNpr: number;
  partsMrpNpr: number;
  visitingFeeNpr: number;
  tipNpr: number;
  commissionRate: number; // 0.22 | 0.18 | 0.15 | 0.12
  discountNpr?: number;
}) {
  const labor = round2(params.laborNpr);
  const parts = round2(params.partsMrpNpr);
  const visit = round2(params.visitingFeeNpr);
  const tip = round2(params.tipNpr);
  const discount = round2(params.discountNpr || 0);

  const platformCommissionNpr = round2(labor * params.commissionRate);
  const warrantyReserveNpr = round2(platformCommissionNpr * 0.1); // 10% of platform cut -> warranty pool
  const platformNetRevenueNpr = round2(platformCommissionNpr - warrantyReserveNpr);

  const expertLaborNetNpr = round2(labor - platformCommissionNpr);
  const expertTotalPayableNpr = round2(expertLaborNetNpr + visit + parts + tip);
  const customerTotalNpr = round2(Math.max(0, labor + visit + parts - discount) + tip);

  return {
    laborNpr: labor,
    partsMrpNpr: parts,
    visitingFeeNpr: visit,
    tipNpr: tip,
    discountNpr: discount,
    commissionRate: params.commissionRate,
    platformCommissionNpr,
    warrantyReserveNpr,
    platformNetRevenueNpr,
    expertLaborNetNpr,
    expertTotalPayableNpr,
    customerTotalNpr,
  };
}

export async function syncProviderFloatPauseState(
  client: pg.PoolClient,
  providerUserId: string
): Promise<{ currentFloatNpr: number; isCashPaused: boolean }> {
  const { rows } = await client.query(
    `SELECT w.auto_pause_threshold_npr, a.balance_npr
     FROM provider_float_wallets w
     JOIN ledger_accounts a ON a.id = w.ledger_account_id
     WHERE w.provider_user_id = $1`,
    [providerUserId]
  );
  if (!rows[0]) {
    return { currentFloatNpr: 0, isCashPaused: true };
  }
  const balance = Number(rows[0].balance_npr);
  const threshold = Number(rows[0].auto_pause_threshold_npr);
  const isPaused = balance < threshold;

  await client.query(
    `UPDATE provider_float_wallets
     SET current_float_npr = $1, is_cash_paused = $2, updated_at = NOW()
     WHERE provider_user_id = $3`,
    [balance, isPaused, providerUserId]
  );
  await client.query(
    `UPDATE provider_profiles
     SET cash_jobs_enabled = $1, updated_at = NOW()
     WHERE user_id = $2`,
    [!isPaused, providerUserId]
  );

  return { currentFloatNpr: balance, isCashPaused: isPaused };
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
