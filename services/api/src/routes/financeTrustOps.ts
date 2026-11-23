import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { requireAnyRole, requireAuth } from '../auth.js';
import {
  computeSettlementBreakdown,
  ensureProviderLedgerAccounts,
  postDoubleEntryTransaction,
  round2,
  syncProviderFloatPauseState,
} from '../ledger.js';
import { recalculateProviderRanking } from '../ranking.js';
import { realtimeHub } from '../ws.js';

export const financeTrustOpsRouter = Router();

// 1. Multi-Rail Payment & Escrow Funding + Idempotent Settlement (L5, L6, L10)
financeTrustOpsRouter.post('/payments/initiate', requireAuth, async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key') || crypto.randomUUID();
  const parsed = z
    .object({
      booking_id: z.string().uuid(),
      payment_method: z.enum(['CASH', 'ESEWA', 'KHALTI', 'FONEPAY_QR', 'CONNECT_IPS', 'CARD']),
      is_escrow_hold: z.boolean().default(false),
      tip_npr: z.number().min(0).max(50000).default(0),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;

  const result = await withTransaction(async (client) => {
    // L10: Idempotency check
    const existing = await client.query(
      `SELECT * FROM payment_transactions WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    if (existing.rows[0]) {
      return { payment: existing.rows[0], deduplicated: true };
    }

    const bRes = await client.query(
      `SELECT b.*, t.commission_rate
       FROM bookings b
       LEFT JOIN provider_profiles p ON p.user_id = b.assigned_provider_id
       LEFT JOIN commission_tiers t ON t.code = p.tier_code
       WHERE b.id = $1 FOR UPDATE OF b`,
      [d.booking_id]
    );
    const bk = bRes.rows[0];
    if (!bk) throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
    if (!bk.assigned_provider_id) {
      throw Object.assign(new Error('Booking has no assigned provider yet'), { statusCode: 409 });
    }

    const laborNpr = Number(bk.quoted_labor_npr) + Number(bk.approved_change_order_labor_npr);
    const breakdown = computeSettlementBreakdown({
      laborNpr,
      partsMrpNpr: Number(bk.approved_parts_mrp_npr),
      visitingFeeNpr: Number(bk.visiting_fee_npr),
      tipNpr: d.tip_npr,
      commissionRate: Number(bk.commission_rate ?? 0.22),
      discountNpr: Number(bk.discount_npr),
    });

    await ensureProviderLedgerAccounts(client, bk.assigned_provider_id);
    const clearingCode =
      d.payment_method === 'KHALTI'
        ? 'SYS_GATEWAY_CLEARING_KHALTI'
        : d.payment_method === 'FONEPAY_QR'
        ? 'SYS_GATEWAY_CLEARING_FONEPAY'
        : d.payment_method === 'CONNECT_IPS' || d.payment_method === 'CARD'
        ? 'SYS_GATEWAY_CLEARING_BANK'
        : 'SYS_GATEWAY_CLEARING_ESEWA';

    const pTx = await client.query(
      `INSERT INTO payment_transactions (booking_id, payer_user_id, payment_method, amount_npr, status, idempotency_key, gateway_ref_id, gateway_signature_verified)
       VALUES ($1, $2, $3, $4, 'CAPTURED', $5, $6, TRUE)
       RETURNING *`,
      [
        bk.id,
        bk.customer_id,
        d.payment_method,
        breakdown.customerTotalNpr,
        idempotencyKey,
        `${d.payment_method}-${crypto.randomUUID().slice(0, 10)}`,
      ]
    );

    if (d.is_escrow_hold && d.payment_method !== 'CASH') {
      // Hold funds in Escrow until homeowner OTP confirmation
      await postDoubleEntryTransaction(client, {
        idempotencyKey: `escrow-hold:${idempotencyKey}`,
        bookingId: bk.id,
        referenceType: 'ESCROW_HOLD',
        description: `Escrow hold for ${bk.booking_code}`,
        lines: [
          { accountCode: clearingCode, debitNpr: breakdown.customerTotalNpr },
          { accountCode: 'SYS_ESCROW_LIABILITY', creditNpr: breakdown.customerTotalNpr },
        ],
      });
      await client.query(
        `INSERT INTO escrow_accounts (booking_id, total_held_npr, status)
         VALUES ($1, $2, 'HELD')
         ON CONFLICT (booking_id) DO UPDATE SET total_held_npr = EXCLUDED.total_held_npr, status = 'HELD', updated_at = NOW()`,
        [bk.id, breakdown.customerTotalNpr]
      );
      await client.query(`UPDATE bookings SET tip_npr = $1, payment_method = $2 WHERE id = $3`, [
        d.tip_npr,
        d.payment_method,
        bk.id,
      ]);
      return { payment: pTx.rows[0], breakdown, escrow_status: 'HELD', deduplicated: false };
    }

    if (d.payment_method === 'CASH') {
      // L5 & L6: Cash collected by technician -> deduct labor-only commission from Provider Float Wallet!
      await postDoubleEntryTransaction(client, {
        idempotencyKey: `cash-settle:${idempotencyKey}`,
        bookingId: bk.id,
        referenceType: 'JOB_SETTLEMENT',
        description: `Cash settlement commission deduction for ${bk.booking_code}`,
        lines: [
          { accountCode: `PROV_FLOAT:${bk.assigned_provider_id}`, debitNpr: breakdown.platformCommissionNpr },
          { accountCode: 'SYS_PLATFORM_COMMISSION_REV', creditNpr: breakdown.platformNetRevenueNpr },
          { accountCode: 'SYS_WARRANTY_RESERVE', creditNpr: breakdown.warrantyReserveNpr },
        ],
      });
      const floatState = await syncProviderFloatPauseState(client, bk.assigned_provider_id);
      await finalizeBookingSettlement(client, bk.id, bk.customer_id, bk.assigned_provider_id, d.tip_npr, breakdown.customerTotalNpr, 'CASH');
      return { payment: pTx.rows[0], breakdown, float_state: floatState, deduplicated: false };
    }

    // Immediate Digital Settlement (eSewa / Khalti / Fonepay / ConnectIPS)
    const lines: { accountCode: string; debitNpr?: number; creditNpr?: number }[] = [
      { accountCode: clearingCode, debitNpr: breakdown.customerTotalNpr },
    ];
    if (breakdown.discountNpr > 0) {
      lines.push({ accountCode: 'SYS_PROMO_SUBSIDY_EXP', debitNpr: breakdown.discountNpr });
    }
    lines.push(
      { accountCode: `PROV_PAYABLE:${bk.assigned_provider_id}`, creditNpr: breakdown.expertTotalPayableNpr },
      { accountCode: 'SYS_PLATFORM_COMMISSION_REV', creditNpr: breakdown.platformNetRevenueNpr },
      { accountCode: 'SYS_WARRANTY_RESERVE', creditNpr: breakdown.warrantyReserveNpr }
    );
    await postDoubleEntryTransaction(client, {
      idempotencyKey: `digital-settle:${idempotencyKey}`,
      bookingId: bk.id,
      referenceType: 'JOB_SETTLEMENT',
      description: `Digital settlement (${d.payment_method}) for ${bk.booking_code}`,
      lines,
    });

    await finalizeBookingSettlement(client, bk.id, bk.customer_id, bk.assigned_provider_id, d.tip_npr, breakdown.customerTotalNpr, d.payment_method);
    return { payment: pTx.rows[0], breakdown, deduplicated: false };
  }, 'SERIALIZABLE');

  res.status(201).json(result);
});

async function finalizeBookingSettlement(
  client: import('pg').PoolClient,
  bookingId: string,
  customerId: string,
  providerId: string,
  tipNpr: number,
  totalNpr: number,
  method: string
) {
  await client.query(
    `UPDATE bookings
     SET status = 'SETTLED_CLOSED', tip_npr = $1, final_total_npr = $2,
         payment_method = $3::payment_method,
         warranty_expires_at = COALESCE(warranty_expires_at, NOW() + (warranty_days || ' days')::interval),
         updated_at = NOW()
     WHERE id = $4`,
    [tipNpr, totalNpr, method, bookingId]
  );
  await client.query(
    `UPDATE provider_profiles
     SET lifetime_completed_jobs = lifetime_completed_jobs + 1,
         last_completed_job_at = NOW(),
         availability_state = 'AVAILABLE',
         updated_at = NOW()
     WHERE user_id = $1`,
    [providerId]
  );
  // Earn loyalty points (1 point per NPR 50 spent)
  const earnedPoints = Math.max(5, Math.floor(totalNpr / 50));
  await client.query(
    `INSERT INTO loyalty_point_ledger (user_id, booking_id, points_delta, reason)
     VALUES ($1, $2, $3, 'BOOKING_COMPLETED_REWARD')`,
    [customerId, bookingId, earnedPoints]
  );
  await recalculateProviderRanking(client, providerId);
}

// 2. Escrow Release via Homeowner Confirmation / OTP (Strictly Blocked if Dispute FROZEN — L7!)
financeTrustOpsRouter.post('/bookings/:bookingId/escrow/release', requireAuth, async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key') || `escrow-rel:${req.params.bookingId}`;
  const parsed = z
    .object({
      completion_otp: z.string().min(4),
      tip_npr: z.number().min(0).default(0),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const out = await withTransaction(async (client) => {
    const eRes = await client.query(`SELECT * FROM escrow_accounts WHERE booking_id = $1 FOR UPDATE`, [
      req.params.bookingId,
    ]);
    const escrow = eRes.rows[0];
    if (!escrow) throw Object.assign(new Error('Escrow account not found'), { statusCode: 404 });

    // L7: Never release Escrow while frozen by an active 48h dispute!
    if (escrow.status === 'FROZEN_DISPUTE') {
      throw Object.assign(
        new Error('Escrow is FROZEN due to an active 48-hour dispute. Admin resolution required.'),
        { statusCode: 409 }
      );
    }
    if (escrow.status === 'RELEASED') {
      return { escrow, deduplicated: true };
    }
    if (escrow.status !== 'HELD') {
      throw Object.assign(new Error(`Escrow not releasable from status ${escrow.status}`), {
        statusCode: 409,
      });
    }

    const bRes = await client.query(
      `SELECT b.*, t.commission_rate
       FROM bookings b
       JOIN provider_profiles p ON p.user_id = b.assigned_provider_id
       JOIN commission_tiers t ON t.code = p.tier_code
       WHERE b.id = $1 FOR UPDATE OF b`,
      [req.params.bookingId]
    );
    const bk = bRes.rows[0];
    if (bk.customer_id !== req.user!.id) {
      throw Object.assign(new Error('Only homeowner can confirm OTP release'), { statusCode: 403 });
    }

    const otpHash = crypto.createHash('sha256').update(parsed.data.completion_otp).digest('hex');
    if (bk.completion_otp_hash && bk.completion_otp_hash !== otpHash) {
      throw Object.assign(new Error('Invalid completion OTP'), { statusCode: 400 });
    }

    const laborNpr = Number(bk.quoted_labor_npr) + Number(bk.approved_change_order_labor_npr);
    const breakdown = computeSettlementBreakdown({
      laborNpr,
      partsMrpNpr: Number(bk.approved_parts_mrp_npr),
      visitingFeeNpr: Number(bk.visiting_fee_npr),
      tipNpr: Number(bk.tip_npr),
      commissionRate: Number(bk.commission_rate),
      discountNpr: Number(bk.discount_npr),
    });

    await ensureProviderLedgerAccounts(client, bk.assigned_provider_id);
    const held = Number(escrow.total_held_npr);
    const lines: { accountCode: string; debitNpr?: number; creditNpr?: number }[] = [
      { accountCode: 'SYS_ESCROW_LIABILITY', debitNpr: held },
    ];
    if (breakdown.discountNpr > 0) {
      lines.push({ accountCode: 'SYS_PROMO_SUBSIDY_EXP', debitNpr: breakdown.discountNpr });
    }
    lines.push(
      { accountCode: `PROV_PAYABLE:${bk.assigned_provider_id}`, creditNpr: breakdown.expertTotalPayableNpr },
      { accountCode: 'SYS_PLATFORM_COMMISSION_REV', creditNpr: breakdown.platformNetRevenueNpr },
      { accountCode: 'SYS_WARRANTY_RESERVE', creditNpr: breakdown.warrantyReserveNpr }
    );
    await postDoubleEntryTransaction(client, {
      idempotencyKey,
      bookingId: bk.id,
      referenceType: 'ESCROW_RELEASE',
      description: `Escrow OTP release for ${bk.booking_code}`,
      lines,
    });

    const updEsc = await client.query(
      `UPDATE escrow_accounts SET status = 'RELEASED', released_npr = total_held_npr, released_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [escrow.id]
    );
    await finalizeBookingSettlement(
      client,
      bk.id,
      bk.customer_id,
      bk.assigned_provider_id,
      Number(bk.tip_npr),
      held,
      'ESCROW_WALLET'
    );
    return { escrow: updEsc.rows[0], breakdown, deduplicated: false };
  }, 'SERIALIZABLE');

  res.json(out);
});

// 3. Provider Cash-Job Float Top-Up & Multi-Cadence Payout Requests (Instant 2h / Batch / Weekly — L10)
financeTrustOpsRouter.post('/providers/me/float/topup', requireAuth, async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key') || crypto.randomUUID();
  const parsed = z.object({ amount_npr: z.number().min(100).max(100000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const state = await withTransaction(async (client) => {
    await ensureProviderLedgerAccounts(client, req.user!.id);
    await postDoubleEntryTransaction(client, {
      idempotencyKey: `float-topup:${idempotencyKey}`,
      referenceType: 'FLOAT_TOPUP',
      description: `Provider commission float top-up`,
      lines: [
        { accountCode: 'SYS_GATEWAY_CLEARING_ESEWA', debitNpr: parsed.data.amount_npr },
        { accountCode: `PROV_FLOAT:${req.user!.id}`, creditNpr: parsed.data.amount_npr },
      ],
    });
    return syncProviderFloatPauseState(client, req.user!.id);
  }, 'SERIALIZABLE');
  res.status(201).json(state);
});

financeTrustOpsRouter.post('/providers/me/payouts', requireAuth, async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key') || crypto.randomUUID();
  const parsed = z
    .object({
      cadence: z.enum(['INSTANT_2H', 'SAME_DAY_BATCH', 'WEEKLY_BANK']),
      amount_npr: z.number().min(100),
      destination_rail: z.enum(['ESEWA', 'KHALTI', 'IME_PAY', 'CONNECT_IPS', 'BANK']),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;

  const payout = await withTransaction(async (client) => {
    // L10: Strict Idempotency Key
    const existing = await client.query(`SELECT * FROM payout_requests WHERE idempotency_key = $1`, [
      idempotencyKey,
    ]);
    if (existing.rows[0]) return { payout: existing.rows[0], deduplicated: true };

    const acct = await client.query(
      `SELECT balance_npr FROM ledger_accounts WHERE code = $1 FOR UPDATE`,
      [`PROV_PAYABLE:${req.user!.id}`]
    );
    const available = acct.rows[0] ? Number(acct.rows[0].balance_npr) : 0;
    if (d.amount_npr > available) {
      throw Object.assign(
        new Error(`Insufficient payable balance (available: NPR ${available.toFixed(2)})`),
        { statusCode: 400 }
      );
    }

    const fee = d.cadence === 'INSTANT_2H' ? 25.0 : 0.0;
    const net = round2(d.amount_npr - fee);
    const clearing =
      d.destination_rail === 'KHALTI'
        ? 'SYS_GATEWAY_CLEARING_KHALTI'
        : d.destination_rail === 'BANK' || d.destination_rail === 'CONNECT_IPS'
        ? 'SYS_GATEWAY_CLEARING_BANK'
        : 'SYS_GATEWAY_CLEARING_ESEWA';

    const lines: { accountCode: string; debitNpr?: number; creditNpr?: number }[] = [
      { accountCode: `PROV_PAYABLE:${req.user!.id}`, debitNpr: d.amount_npr },
      { accountCode: clearing, creditNpr: net },
    ];
    if (fee > 0) {
      lines.push({ accountCode: 'SYS_INSTANT_PAYOUT_FEE_REV', creditNpr: fee });
    }

    await postDoubleEntryTransaction(client, {
      idempotencyKey: `payout:${idempotencyKey}`,
      referenceType: 'PAYOUT',
      description: `Provider payout (${d.cadence} via ${d.destination_rail})`,
      lines,
    });

    const ins = await client.query(
      `INSERT INTO payout_requests (provider_user_id, cadence, gross_amount_npr, instant_fee_npr, net_disbursed_npr, destination_rail, destination_account, status, idempotency_key, external_payout_ref, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'SETTLED', $8, $9, NOW())
       RETURNING *`,
      [
        req.user!.id,
        d.cadence,
        d.amount_npr,
        fee,
        net,
        d.destination_rail,
        req.user!.phone_e164,
        idempotencyKey,
        `PAY-${crypto.randomUUID().slice(0, 8)}`,
      ]
    );
    return { payout: ins.rows[0], deduplicated: false };
  }, 'SERIALIZABLE');

  res.status(202).json(payout);
});

financeTrustOpsRouter.get('/providers/me/payouts', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM payout_requests WHERE provider_user_id = $1 ORDER BY requested_at DESC LIMIT 30`,
    [req.user!.id]
  );
  res.json({ payouts: rows });
});

// VAT Invoice & Form 11 Summary
financeTrustOpsRouter.get('/bookings/:bookingId/invoice', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, cu.full_name AS customer_name, pu.full_name AS provider_name,
            pp.pan_number AS provider_pan, t.commission_rate
     FROM bookings b
     JOIN users cu ON cu.id = b.customer_id
     LEFT JOIN users pu ON pu.id = b.assigned_provider_id
     LEFT JOIN provider_profiles pp ON pp.user_id = b.assigned_provider_id
     LEFT JOIN commission_tiers t ON t.code = pp.tier_code
     WHERE b.id = $1`,
    [req.params.bookingId]
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }
  const bk = rows[0];
  res.json({
    invoice_number: `INV-${bk.booking_code}`,
    vat_registration_no: '605935136-SIPALU',
    issued_at: bk.completed_at || bk.updated_at,
    customer_name: bk.customer_name,
    provider_name: bk.provider_name,
    provider_pan: bk.provider_pan,
    line_items: {
      base_labor_npr: Number(bk.quoted_labor_npr),
      change_order_labor_npr: Number(bk.approved_change_order_labor_npr),
      spare_parts_mrp_npr: Number(bk.approved_parts_mrp_npr),
      visiting_fee_npr: Number(bk.visiting_fee_npr),
      discount_npr: Number(bk.discount_npr),
      tip_npr: Number(bk.tip_npr),
      total_paid_npr: Number(bk.final_total_npr),
    },
    warranty_valid_until: bk.warranty_expires_at,
  });
});

// 4. Two-Way Ratings (Triggers Ranking Recalculation Loop)
financeTrustOpsRouter.post('/bookings/:bookingId/ratings', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      overall_stars: z.number().int().min(1).max(5),
      sub_tags: z.array(z.string()).default([]),
      comment: z.string().max(600).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const out = await withTransaction(async (client) => {
    const bRes = await client.query(`SELECT * FROM bookings WHERE id = $1`, [req.params.bookingId]);
    const bk = bRes.rows[0];
    if (!bk || !bk.assigned_provider_id) {
      throw Object.assign(new Error('Booking not rateable'), { statusCode: 400 });
    }
    const isCustomer = bk.customer_id === req.user!.id;
    const isProvider = bk.assigned_provider_id === req.user!.id;
    if (!isCustomer && !isProvider) {
      throw Object.assign(new Error('Not a participant in this booking'), { statusCode: 403 });
    }
    const direction = isCustomer ? 'CUSTOMER_TO_PROVIDER' : 'PROVIDER_TO_CUSTOMER';
    const rateeId = isCustomer ? bk.assigned_provider_id : bk.customer_id;

    const ins = await client.query(
      `INSERT INTO ratings (booking_id, rater_user_id, ratee_user_id, direction, overall_stars, sub_tags, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (booking_id, direction) DO UPDATE SET overall_stars = EXCLUDED.overall_stars, comment = EXCLUDED.comment
       RETURNING *`,
      [bk.id, req.user!.id, rateeId, direction, parsed.data.overall_stars, parsed.data.sub_tags, parsed.data.comment || null]
    );
    const ranking =
      direction === 'CUSTOMER_TO_PROVIDER'
        ? await recalculateProviderRanking(client, bk.assigned_provider_id)
        : null;
    return { rating: ins.rows[0], updated_ranking: ranking };
  });

  res.status(201).json(out);
});

// 5. 48-Hour Dispute Filing (Atomically Freezes Escrow — L7) & Admin Resolution
financeTrustOpsRouter.post('/bookings/:bookingId/disputes', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      category: z.enum(['INCOMPLETE_REPAIR', 'WORKMANSHIP', 'OVERCHARGING', 'NO_SHOW', 'PROPERTY_DAMAGE']),
      description: z.string().min(5).max(1000),
      evidence_blob_paths: z.array(z.string()).default([]),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const dispute = await withTransaction(async (client) => {
    const bRes = await client.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [
      req.params.bookingId,
    ]);
    const bk = bRes.rows[0];
    if (!bk) throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
    if (bk.completed_at && Date.now() - new Date(bk.completed_at).getTime() > 48 * 3600_000) {
      throw Object.assign(
        new Error('48-hour dispute window has expired. Please use the 30-Day Service Warranty claim instead.'),
        { statusCode: 400 }
      );
    }

    const ins = await client.query(
      `INSERT INTO dispute_cases (booking_id, filed_by_user_id, category, description, evidence_blob_paths, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN_ESCROW_FROZEN')
       RETURNING *`,
      [bk.id, req.user!.id, parsed.data.category, parsed.data.description, parsed.data.evidence_blob_paths]
    );
    // Atomically freeze escrow & mark booking
    await client.query(
      `UPDATE escrow_accounts SET status = 'FROZEN_DISPUTE', frozen_at = NOW(), updated_at = NOW()
       WHERE booking_id = $1 AND status IN ('HELD', 'PENDING_FUNDING')`,
      [bk.id]
    );
    await client.query(`UPDATE bookings SET status = 'DISPUTED_ESCROW_FROZEN' WHERE id = $1`, [bk.id]);
    return ins.rows[0];
  });

  realtimeHub.broadcast({ type: 'DISPUTE_OPENED', bookingId: String(req.params.bookingId), payload: dispute });
  res.status(201).json(dispute);
});

financeTrustOpsRouter.post(
  '/admin/disputes/:disputeId/resolve',
  requireAuth,
  requireAnyRole('OPS_DISPATCHER', 'GRIEVANCE_OFFICER', 'FINANCE_ADMIN', 'SUPER_ADMIN'),
  async (req, res) => {
    const parsed = z
      .object({
        outcome: z.enum([
          'RESOLVED_FULL_REFUND',
          'RESOLVED_PARTIAL_ADJUSTMENT',
          'RESOLVED_PAYOUT_RELEASED',
          'RESOLVED_REWORK_DISPATCHED',
        ]),
        refund_amount_npr: z.number().min(0).default(0),
        resolution_notes: z.string().min(3),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const out = await withTransaction(async (client) => {
      const dRes = await client.query(
        `UPDATE dispute_cases
         SET status = $1::dispute_status, refund_amount_npr = $2, resolution_notes = $3,
             assigned_admin_id = $4, resolved_at = NOW()
         WHERE id = $5 RETURNING *`,
        [parsed.data.outcome, parsed.data.refund_amount_npr, parsed.data.resolution_notes, req.user!.id, req.params.disputeId]
      );
      if (!dRes.rows[0]) throw Object.assign(new Error('Dispute not found'), { statusCode: 404 });
      const disp = dRes.rows[0];
      const nextEsc = parsed.data.outcome === 'RESOLVED_FULL_REFUND' ? 'REFUNDED' : 'RELEASED';
      const escRes = await client.query(
        `SELECT * FROM escrow_accounts WHERE booking_id = $1 FOR UPDATE`,
        [disp.booking_id]
      );
      const bkRes = await client.query(`SELECT * FROM bookings WHERE id = $1`, [disp.booking_id]);
      const bk = bkRes.rows[0];

      if (escRes.rows[0] && Number(escRes.rows[0].total_held_npr) > 0 && escRes.rows[0].status === 'FROZEN_DISPUTE') {
        const held = Number(escRes.rows[0].total_held_npr);
        const refundAmt =
          parsed.data.outcome === 'RESOLVED_FULL_REFUND'
            ? held
            : Math.min(held, Number(parsed.data.refund_amount_npr || 0));
        const providerRelease = round2(held - refundAmt);
        const lines: { accountCode: string; debitNpr?: number; creditNpr?: number }[] = [
          { accountCode: 'SYS_ESCROW_LIABILITY', debitNpr: held },
        ];
        if (refundAmt > 0) {
          lines.push({ accountCode: 'SYS_GATEWAY_CLEARING_ESEWA', creditNpr: refundAmt });
        }
        if (providerRelease > 0 && bk?.assigned_provider_id) {
          await ensureProviderLedgerAccounts(client, bk.assigned_provider_id);
          lines.push({ accountCode: `PROV_PAYABLE:${bk.assigned_provider_id}`, creditNpr: providerRelease });
        }
        await postDoubleEntryTransaction(client, {
          idempotencyKey: `dispute-resolve:${disp.id}`,
          bookingId: disp.booking_id,
          referenceType: 'REFUND',
          description: `Admin dispute resolution (${parsed.data.outcome}) for ${bk?.booking_code || disp.booking_id}`,
          lines,
        });
        await client.query(
          `UPDATE escrow_accounts
           SET status = $1::escrow_status, refunded_npr = $2, released_npr = $3, updated_at = NOW()
           WHERE id = $4`,
          [nextEsc, refundAmt, providerRelease, escRes.rows[0].id]
        );
      }

      await client.query(`UPDATE bookings SET status = 'SETTLED_CLOSED', updated_at = NOW() WHERE id = $1`, [disp.booking_id]);
      if (bk?.assigned_provider_id) {
        await client.query(
          `UPDATE provider_profiles SET availability_state = 'AVAILABLE', updated_at = NOW() WHERE user_id = $1 AND availability_state = 'ON_JOB'`,
          [bk.assigned_provider_id]
        );
      }
      return disp;
    });
    res.json(out);
  }
);

// 6. 30-Day Service & 6-Month Project Warranty Claims (L9 Eligibility Enforcement)
financeTrustOpsRouter.post('/bookings/:bookingId/warranty-claims', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      issue_description: z.string().min(5).max(1000),
      evidence_blob_paths: z.array(z.string()).default([]),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const claim = await withTransaction(async (client) => {
    const bRes = await client.query(`SELECT * FROM bookings WHERE id = $1`, [req.params.bookingId]);
    const bk = bRes.rows[0];
    if (!bk || bk.customer_id !== req.user!.id) {
      throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
    }
    // L9: Only settled in-app bookings within active warranty window qualify!
    if (bk.status !== 'SETTLED_CLOSED') {
      throw Object.assign(
        new Error('Warranty claims are valid only for completed & in-app settled bookings'),
        { statusCode: 400 }
      );
    }
    if (!bk.warranty_expires_at || new Date(bk.warranty_expires_at) < new Date()) {
      throw Object.assign(new Error('30-day workmanship warranty period has expired'), { statusCode: 400 });
    }

    const ins = await client.query(
      `INSERT INTO warranty_claims (original_booking_id, customer_id, issue_description, evidence_blob_paths, status)
       VALUES ($1, $2, $3, $4, 'SUBMITTED') RETURNING *`,
      [bk.id, req.user!.id, parsed.data.issue_description, parsed.data.evidence_blob_paths]
    );
    await client.query(`UPDATE bookings SET status = 'WARRANTY_CLAIMED' WHERE id = $1`, [bk.id]);
    return ins.rows[0];
  });

  res.status(201).json(claim);
});

financeTrustOpsRouter.post(
  '/admin/warranty-claims/:claimId/dispatch-refix',
  requireAuth,
  requireAnyRole('OPS_DISPATCHER', 'GRIEVANCE_OFFICER', 'SUPER_ADMIN'),
  async (req, res) => {
    const hourlyPayout = Number(req.body?.refix_hourly_payout_npr ?? 450);
    const { rows } = await pool.query(
      `UPDATE warranty_claims
       SET status = 'REFIX_DISPATCHED', qa_reviewer_id = $1, refix_hourly_payout_npr = $2
       WHERE id = $3 RETURNING *`,
      [req.user!.id, hourlyPayout, req.params.claimId]
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'Warranty claim not found' });
      return;
    }
    res.json(rows[0]);
  }
);

// 7. Priority-0 SOS Safety Trigger (<60s Admin Alert — L13)
financeTrustOpsRouter.post('/bookings/:bookingId/sos', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      lat: z.number().min(26).max(31),
      lng: z.number().min(80).max(89),
      note: z.string().max(400).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { rows } = await pool.query(
    `INSERT INTO sos_events (booking_id, triggered_by_user_id, trigger_location, status, acs_bridge_call_id, resolution_notes)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, 'ACTIVE_P0', $5, $6)
     RETURNING id, booking_id, triggered_by_user_id, status, acs_bridge_call_id, created_at`,
    [
      req.params.bookingId,
      req.user!.id,
      parsed.data.lat,
      parsed.data.lng,
      `acs-sos-${crypto.randomUUID().slice(0, 8)}`,
      parsed.data.note || null,
    ]
  );

  realtimeHub.broadcast({
    type: 'SOS_P0_ALERT',
    bookingId: String(req.params.bookingId),
    payload: { ...rows[0], lat: parsed.data.lat, lng: parsed.data.lng, triggered_by: req.user!.full_name },
  });

  res.status(201).json(rows[0]);
});

financeTrustOpsRouter.post(
  '/admin/sos/:sosId/acknowledge',
  requireAuth,
  requireAnyRole('OPS_DISPATCHER', 'GRIEVANCE_OFFICER', 'SUPER_ADMIN'),
  async (req, res) => {
    const status = req.body?.status === 'RESOLVED' ? 'RESOLVED' : 'ACKNOWLEDGED';
    const { rows } = await pool.query(
      `UPDATE sos_events
       SET status = $1::sos_status, acknowledged_by = $2,
           acknowledged_at = COALESCE(acknowledged_at, NOW()),
           resolved_at = CASE WHEN $1 = 'RESOLVED' THEN NOW() ELSE resolved_at END,
           resolution_notes = COALESCE($3, resolution_notes)
       WHERE id = $4 RETURNING *`,
      [status, req.user!.id, req.body?.resolution_notes || null, req.params.sosId]
    );
    res.json(rows[0] || { error: 'Not found' });
  }
);

// 8. B2B AMC Contracts (<2h Emergency SLA) & Turnkey Renovation Projects (48h Survey + 6m Warranty)
financeTrustOpsRouter.get('/amc/contracts', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT c.*, (SELECT COUNT(*)::int FROM amc_visits v WHERE v.contract_id = c.id) AS visits_count
    FROM amc_contracts c ORDER BY c.created_at DESC LIMIT 30
  `);
  res.json({ contracts: rows });
});

financeTrustOpsRouter.post('/amc/contracts', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      client_org_name: z.string().min(2).max(180),
      covered_pillars: z.array(z.enum(['PLUMBING', 'ELECTRICAL', 'COMPUTER', 'AC', 'CLEANING'])).min(1),
      annual_fee_npr: z.number().min(10000),
      asset_registry: z.array(z.record(z.unknown())).default([]),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const code = `AMC-${Date.now().toString().slice(-5)}`;
  const { rows } = await pool.query(
    `INSERT INTO amc_contracts (contract_code, client_org_name, client_contact_user_id, covered_pillars, asset_registry, annual_fee_npr, starts_on, ends_on)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, CURRENT_DATE, CURRENT_DATE + INTERVAL '365 days')
     RETURNING *`,
    [code, parsed.data.client_org_name, req.user!.id, parsed.data.covered_pillars, JSON.stringify(parsed.data.asset_registry), parsed.data.annual_fee_npr]
  );
  res.status(201).json(rows[0]);
});

financeTrustOpsRouter.post('/amc/contracts/:contractId/emergency', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `INSERT INTO amc_visits (contract_id, visit_type, scheduled_for, checklist_report)
     VALUES ($1, 'EMERGENCY', NOW() + INTERVAL '2 hours', $2::jsonb)
     RETURNING *`,
    [req.params.contractId, JSON.stringify({ issue: req.body?.issue || 'Emergency facility call-out', sla_minutes: 120 })]
  );
  realtimeHub.broadcast({
    type: 'AMC_EMERGENCY_ALERT',
    payload: { contract_id: req.params.contractId, visit_id: rows[0].id, sla_deadline: rows[0].scheduled_for },
  });
  res.status(201).json(rows[0]);
});

financeTrustOpsRouter.get('/projects', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM renovation_projects ORDER BY created_at DESC LIMIT 30`);
  res.json({ projects: rows });
});

financeTrustOpsRouter.post('/projects', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      scope_type: z.enum(['BATHROOM', 'KITCHEN', 'WATERPROOFING', 'PAINTING', 'FALSE_CEILING', 'FLAT_RENOVATION']),
      estimated_budget_npr: z.number().min(20000).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const code = `PRJ-${Date.now().toString().slice(-5)}`;
  const { rows } = await pool.query(
    `INSERT INTO renovation_projects (project_code, customer_id, scope_type, site_survey_due_at, contract_value_npr, warranty_months)
     VALUES ($1, $2, $3, NOW() + INTERVAL '48 hours', $4, 6)
     RETURNING *`,
    [code, req.user!.id, parsed.data.scope_type, parsed.data.estimated_budget_npr || null]
  );
  res.status(201).json(rows[0]);
});

// 9. 7-Working-Day Privacy PII Deletion (Scrubs PII while Preserving Statutory Financial Ledgers — L11)
financeTrustOpsRouter.post('/users/me/privacy-deletion', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `INSERT INTO privacy_deletion_requests (user_id, request_channel, status, sla_due_at)
     VALUES ($1, 'IN_APP', 'REQUESTED', NOW() + INTERVAL '10 days')
     RETURNING *`,
    [req.user!.id]
  );
  res.status(202).json(rows[0]);
});

financeTrustOpsRouter.post(
  '/admin/privacy-deletions/:requestId/execute',
  requireAuth,
  requireAnyRole('GRIEVANCE_OFFICER', 'SUPER_ADMIN'),
  async (req, res) => {
    const out = await withTransaction(async (client) => {
      const rRes = await client.query(`SELECT * FROM privacy_deletion_requests WHERE id = $1 FOR UPDATE`, [
        req.params.requestId,
      ]);
      if (!rRes.rows[0]) throw Object.assign(new Error('Deletion request not found'), { statusCode: 404 });
      const userId = rRes.rows[0].user_id;

      // Scrub PII from users & addresses while preserving statutory bookings & double-entry ledger rows!
      await client.query(
        `UPDATE users
         SET full_name = 'Anonymized User',
             phone_e164 = '+977000' || SUBSTRING(REPLACE(id::text, '-', ''), 1, 9),
             email = NULL,
             avatar_blob_path = NULL,
             is_active = FALSE,
             is_anonymized = TRUE,
             updated_at = NOW()
         WHERE id = $1`,
        [userId]
      );
      await client.query(
        `UPDATE user_addresses
         SET exact_address_line = '[REDACTED_PII]', tole_neighborhood = '[REDACTED]'
         WHERE user_id = $1`,
        [userId]
      );
      const upd = await client.query(
        `UPDATE privacy_deletion_requests
         SET status = 'COMPLETED_ANONYMIZED', processed_by = $1, completed_at = NOW()
         WHERE id = $2 RETURNING *`,
        [req.user!.id, req.params.requestId]
      );
      return upd.rows[0];
    });
    res.json(out);
  }
);

// 10. Admin Command Center Snapshot (SOS, Anti-Leakage, Disputes, Warranties, Ledger Integrity Check)
financeTrustOpsRouter.get(
  '/admin/command-center',
  requireAuth,
  requireAnyRole('OPS_DISPATCHER', 'KYC_REVIEWER', 'FINANCE_ADMIN', 'GRIEVANCE_OFFICER', 'SUPER_ADMIN'),
  async (_req, res) => {
    const [sos, flags, disputes, warranties, ledgerCheck, accounts, privacyReqs] = await Promise.all([
      pool.query(
        `SELECT s.id, s.booking_id, s.status, s.acs_bridge_call_id, s.created_at, s.resolution_notes,
                ST_Y(s.trigger_location::geometry) AS lat, ST_X(s.trigger_location::geometry) AS lng,
                u.full_name AS triggered_by_name, b.booking_code
         FROM sos_events s
         JOIN users u ON u.id = s.triggered_by_user_id
         JOIN bookings b ON b.id = s.booking_id
         ORDER BY s.created_at DESC LIMIT 20`
      ),
      pool.query(
        `SELECT f.*, u.full_name AS provider_name, b.booking_code
         FROM anti_leakage_flags f
         JOIN users u ON u.id = f.provider_user_id
         LEFT JOIN bookings b ON b.id = f.booking_id
         ORDER BY f.created_at DESC LIMIT 20`
      ),
      pool.query(
        `SELECT d.*, b.booking_code, e.status AS escrow_status, e.total_held_npr
         FROM dispute_cases d
         JOIN bookings b ON b.id = d.booking_id
         LEFT JOIN escrow_accounts e ON e.booking_id = d.booking_id
         ORDER BY d.filed_at DESC LIMIT 20`
      ),
      pool.query(
        `SELECT w.*, b.booking_code, u.full_name AS customer_name
         FROM warranty_claims w
         JOIN bookings b ON b.id = w.original_booking_id
         JOIN users u ON u.id = w.customer_id
         ORDER BY w.created_at DESC LIMIT 20`
      ),
      pool.query(
        `SELECT COALESCE(SUM(debit_npr), 0)::numeric(14,2) AS total_debits,
                COALESCE(SUM(credit_npr), 0)::numeric(14,2) AS total_credits,
                COUNT(*)::int AS entry_count
         FROM ledger_entries`
      ),
      pool.query(`SELECT code, account_type, balance_npr FROM ledger_accounts ORDER BY code`),
      pool.query(
        `SELECT p.*, u.full_name, u.is_anonymized
         FROM privacy_deletion_requests p JOIN users u ON u.id = p.user_id
         ORDER BY p.requested_at DESC LIMIT 20`
      ),
    ]);

    const lc = ledgerCheck.rows[0];
    res.json({
      sos_events: sos.rows,
      anti_leakage_flags: flags.rows,
      disputes: disputes.rows,
      warranty_claims: warranties.rows,
      privacy_deletions: privacyReqs.rows,
      ledger_integrity: {
        total_debits_npr: Number(lc.total_debits),
        total_credits_npr: Number(lc.total_credits),
        is_balanced: Number(lc.total_debits) === Number(lc.total_credits),
        entry_count: lc.entry_count,
      },
      ledger_accounts: accounts.rows,
    });
  }
);
