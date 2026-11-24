import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  computeSettlementBreakdown,
  ensureProviderLedgerAccounts,
  postDoubleEntryTransaction,
} from '../ledger.js';
import { recalculateProviderRanking } from '../ranking.js';

export const paymentGatewaysRouter = Router();

// Sandbox Defaults (Official eSewa UAT, Khalti Sandbox, Fonepay UAT)
const ESEWA_PRODUCT_CODE = process.env.ESEWA_PRODUCT_CODE || 'EPAYTEST';
const ESEWA_SECRET_KEY = process.env.ESEWA_SECRET_KEY || '8gBm/:&EnhH.1/q';
const ESEWA_EPAY_URL =
  process.env.ESEWA_EPAY_URL || 'https://rc-epay.esewa.com.np/api/epay/main/v2/form';

const KHALTI_SECRET_KEY =
  process.env.KHALTI_SECRET_KEY && process.env.KHALTI_SECRET_KEY !== 'unset'
    ? process.env.KHALTI_SECRET_KEY
    : '';
const KHALTI_API_BASE = process.env.KHALTI_API_BASE || 'https://a.khalti.com/api/v2';
const KHALTI_SANDBOX_SIM_SECRET = process.env.KHALTI_SANDBOX_SIM_SECRET || 'sipalu-khalti-sandbox-hmac-key';

const FONEPAY_PID = process.env.FONEPAY_PID || 'NBQM';
const FONEPAY_SECRET_KEY =
  process.env.FONEPAY_SECRET_KEY && process.env.FONEPAY_SECRET_KEY !== 'unset'
    ? process.env.FONEPAY_SECRET_KEY
    : 'a7e3512f5032480a83137793cb2021dc';
const FONEPAY_URL =
  process.env.FONEPAY_URL || 'https://dev-clientapi.fonepay.com/api/merchantRequest';

/**
 * Shared idempotent settlement helper triggered ONLY after cryptographic webhook verification passes.
 */
async function settleVerifiedGatewayPayment(params: {
  bookingId: string;
  gatewayMethod: 'ESEWA' | 'KHALTI' | 'FONEPAY_QR';
  gatewayRefId: string;
  idempotencyKey: string;
  rawPayload: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT * FROM payment_transactions WHERE idempotency_key = $1 AND status = 'CAPTURED'`,
      [params.idempotencyKey]
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
      [params.bookingId]
    );
    const bk = bRes.rows[0];
    if (!bk) throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
    if (!bk.assigned_provider_id) {
      throw Object.assign(new Error('Booking has no assigned provider'), { statusCode: 409 });
    }

    const laborNpr = Number(bk.quoted_labor_npr) + Number(bk.approved_change_order_labor_npr);
    const breakdown = computeSettlementBreakdown({
      laborNpr,
      partsMrpNpr: Number(bk.approved_parts_mrp_npr),
      visitingFeeNpr: Number(bk.visiting_fee_npr),
      tipNpr: Number(bk.tip_npr || 0),
      commissionRate: Number(bk.commission_rate ?? 0.22),
      discountNpr: Number(bk.discount_npr || 0),
    });

    await ensureProviderLedgerAccounts(client, bk.assigned_provider_id);
    const clearingCode =
      params.gatewayMethod === 'KHALTI'
        ? 'SYS_GATEWAY_CLEARING_KHALTI'
        : params.gatewayMethod === 'FONEPAY_QR'
        ? 'SYS_GATEWAY_CLEARING_FONEPAY'
        : 'SYS_GATEWAY_CLEARING_ESEWA';

    const pTx = await client.query(
      `INSERT INTO payment_transactions (
         booking_id, payer_user_id, payment_method, amount_npr, status,
         idempotency_key, gateway_ref_id, gateway_signature_verified, gateway_raw_payload, reconciled_at
       )
       VALUES ($1, $2, $3::payment_method, $4, 'CAPTURED', $5, $6, TRUE, $7::jsonb, NOW())
       ON CONFLICT (idempotency_key) DO UPDATE
         SET status = 'CAPTURED', gateway_signature_verified = TRUE, gateway_raw_payload = EXCLUDED.gateway_raw_payload, reconciled_at = NOW(), updated_at = NOW()
       RETURNING *`,
      [
        bk.id,
        bk.customer_id,
        params.gatewayMethod,
        breakdown.customerTotalNpr,
        params.idempotencyKey,
        params.gatewayRefId,
        JSON.stringify(params.rawPayload),
      ]
    );

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
      idempotencyKey: `gw-settle:${params.idempotencyKey}`,
      bookingId: bk.id,
      referenceType: 'JOB_SETTLEMENT',
      description: `Verified ${params.gatewayMethod} Sandbox/Gateway settlement for ${bk.booking_code}`,
      lines,
    });

    await client.query(
      `UPDATE bookings
       SET status = 'SETTLED_CLOSED', final_total_npr = $1, payment_method = $2::payment_method,
           warranty_expires_at = COALESCE(warranty_expires_at, NOW() + (warranty_days || ' days')::interval),
           updated_at = NOW()
       WHERE id = $3`,
      [breakdown.customerTotalNpr, params.gatewayMethod, bk.id]
    );
    await client.query(
      `UPDATE provider_profiles
       SET lifetime_completed_jobs = lifetime_completed_jobs + 1,
           last_completed_job_at = NOW(),
           availability_state = 'AVAILABLE',
           updated_at = NOW()
       WHERE user_id = $1`,
      [bk.assigned_provider_id]
    );
    const earnedPoints = Math.max(5, Math.floor(breakdown.customerTotalNpr / 50));
    await client.query(
      `INSERT INTO loyalty_point_ledger (user_id, booking_id, points_delta, reason)
       VALUES ($1, $2, $3, 'SANDBOX_GATEWAY_REWARD')`,
      [bk.customer_id, bk.id, earnedPoints]
    );
    await recalculateProviderRanking(client, bk.assigned_provider_id);

    return { payment: pTx.rows[0], breakdown, deduplicated: false };
  }, 'SERIALIZABLE');
}

// =========================================================================
// 1. eSewa ePay v2 Sandbox (HMAC-SHA256)
// =========================================================================
paymentGatewaysRouter.post('/payments/gateways/esewa/sign', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      booking_id: z.string().uuid(),
      amount_npr: z.number().min(10),
      success_url: z.string().url(),
      failure_url: z.string().url(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const totalAmount = parsed.data.amount_npr.toFixed(2);
  const transactionUuid = `${parsed.data.booking_id}__${Date.now()}`;
  const signedFieldNames = 'total_amount,transaction_uuid,product_code';
  const message = `total_amount=${totalAmount},transaction_uuid=${transactionUuid},product_code=${ESEWA_PRODUCT_CODE}`;
  const signature = crypto.createHmac('sha256', ESEWA_SECRET_KEY).update(message).digest('base64');

  // Pre-build a genuine signed sandbox callback payload so user can test 1-click callback OR real eSewa UAT redirect
  const simPayloadObj = {
    transaction_code: `ESW${Date.now().toString().slice(-6)}`,
    status: 'COMPLETE',
    total_amount: totalAmount,
    transaction_uuid: transactionUuid,
    product_code: ESEWA_PRODUCT_CODE,
    signed_field_names: 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names',
  };
  const simMsg = `transaction_code=${simPayloadObj.transaction_code},status=${simPayloadObj.status},total_amount=${simPayloadObj.total_amount},transaction_uuid=${simPayloadObj.transaction_uuid},product_code=${simPayloadObj.product_code},signed_field_names=${simPayloadObj.signed_field_names}`;
  const simSig = crypto.createHmac('sha256', ESEWA_SECRET_KEY).update(simMsg).digest('base64');
  const simulatedCallbackBase64 = Buffer.from(
    JSON.stringify({ ...simPayloadObj, signature: simSig }),
    'utf-8'
  ).toString('base64');

  res.json({
    gateway: 'ESEWA_V2',
    mode: ESEWA_PRODUCT_CODE === 'EPAYTEST' ? 'SANDBOX' : 'PRODUCTION',
    action_url: ESEWA_EPAY_URL,
    sandbox_test_wallet: { id: '9806800001', password: 'Nepal@123', mpin: '1122', otp: '987654' },
    form_fields: {
      amount: totalAmount,
      tax_amount: '0',
      total_amount: totalAmount,
      transaction_uuid: transactionUuid,
      product_code: ESEWA_PRODUCT_CODE,
      product_service_charge: '0',
      product_delivery_charge: '0',
      success_url: parsed.data.success_url,
      failure_url: parsed.data.failure_url,
      signed_field_names: signedFieldNames,
      signature,
    },
    simulated_callback_base64: simulatedCallbackBase64,
  });
});

paymentGatewaysRouter.post('/payments/webhooks/esewa', async (req, res) => {
  const encoded = String(req.body?.data || '');
  if (!encoded) {
    res.status(400).json({ error: 'Missing base64 data payload' });
    return;
  }
  let decoded: Record<string, string>;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8')) as Record<string, string>;
  } catch {
    res.status(400).json({ error: 'Invalid base64 JSON payload' });
    return;
  }

  const fields = (decoded.signed_field_names || '').split(',').filter(Boolean);
  const message = fields.map((f) => `${f}=${decoded[f] ?? ''}`).join(',');
  const expectedSig = crypto.createHmac('sha256', ESEWA_SECRET_KEY).update(message).digest('base64');

  if (!decoded.signature || expectedSig !== decoded.signature) {
    res.status(401).json({ error: 'Invalid eSewa HMAC-SHA256 signature' });
    return;
  }
  if (decoded.status !== 'COMPLETE') {
    res.status(400).json({ error: `eSewa payment not COMPLETE (status: ${decoded.status})` });
    return;
  }

  const bookingId = req.body?.booking_id || decoded.transaction_uuid?.split('__')[0];
  const settlement = await settleVerifiedGatewayPayment({
    bookingId,
    gatewayMethod: 'ESEWA',
    gatewayRefId: decoded.transaction_code || decoded.transaction_uuid,
    idempotencyKey: `esewa:${decoded.transaction_uuid}`,
    rawPayload: decoded,
  });

  res.json({ verified: true, gateway: 'ESEWA_V2', ...settlement });
});

// =========================================================================
// 2. Khalti ePayment v2 Sandbox (Real Sandbox API if key set + Built-in Sandbox Simulator)
// =========================================================================
paymentGatewaysRouter.post('/payments/gateways/khalti/initiate', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      booking_id: z.string().uuid(),
      amount_npr: z.number().min(10),
      return_url: z.string().url(),
      website_url: z.string().url(),
      purchase_order_name: z.string().min(2),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  // If user configured a real test_secret_key from test-admin.khalti.com, call live Khalti Sandbox!
  if (KHALTI_SECRET_KEY) {
    const resp = await fetch(`${KHALTI_API_BASE}/epayment/initiate/`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${KHALTI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        return_url: parsed.data.return_url,
        website_url: parsed.data.website_url,
        amount: Math.round(parsed.data.amount_npr * 100),
        purchase_order_id: parsed.data.booking_id,
        purchase_order_name: parsed.data.purchase_order_name,
        customer_info: {
          name: req.user!.full_name,
          phone: req.user!.phone_e164.replace('+977', ''),
        },
      }),
    });
    const data = (await resp.json()) as Record<string, unknown>;
    res.status(resp.status).json({
      gateway: 'KHALTI_V2',
      mode: KHALTI_API_BASE.includes('a.khalti.com') ? 'KHALTI_SANDBOX_LIVE' : 'PRODUCTION',
      sandbox_test_wallet: { id: '9800000000', mpin: '1111', otp: '987654' },
      ...data,
    });
    return;
  }

  // Built-in Sipalu Khalti v2 Sandbox Simulator (zero external key required to test full lookup + ledger flow!)
  const pidx = `khalti_sbx_${crypto.randomBytes(8).toString('hex')}`;
  const amountPaisa = Math.round(parsed.data.amount_npr * 100);
  const simSig = crypto
    .createHmac('sha256', KHALTI_SANDBOX_SIM_SECRET)
    .update(`${pidx}:${parsed.data.booking_id}:${amountPaisa}:Completed`)
    .digest('hex');

  res.json({
    gateway: 'KHALTI_V2',
    mode: 'SANDBOX_SIMULATOR',
    pidx,
    amount_paisa: amountPaisa,
    payment_url: `https://test-pay.khalti.com/?pidx=${pidx}`,
    sandbox_test_wallet: { id: '9800000000', mpin: '1111', otp: '987654' },
    simulated_callback: {
      pidx,
      booking_id: parsed.data.booking_id,
      amount_paisa: amountPaisa,
      status: 'Completed',
      sandbox_signature: simSig,
    },
  });
});

paymentGatewaysRouter.post('/payments/webhooks/khalti', async (req, res) => {
  const parsed = z
    .object({
      pidx: z.string().min(6),
      booking_id: z.string().uuid(),
      amount_paisa: z.number().int().min(1000).optional(),
      status: z.string().default('Completed'),
      sandbox_signature: z.string().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;

  // Live Khalti server-to-server /epayment/lookup/ verification if real key configured
  if (KHALTI_SECRET_KEY && !d.pidx.startsWith('khalti_sbx_')) {
    const resp = await fetch(`${KHALTI_API_BASE}/epayment/lookup/`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${KHALTI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pidx: d.pidx }),
    });
    const lookup = (await resp.json()) as { status?: string; transaction_id?: string };
    if (!resp.ok || lookup.status !== 'Completed') {
      res.status(401).json({ error: 'Khalti server-to-server lookup verification failed', lookup });
      return;
    }
    const settlement = await settleVerifiedGatewayPayment({
      bookingId: d.booking_id,
      gatewayMethod: 'KHALTI',
      gatewayRefId: lookup.transaction_id || d.pidx,
      idempotencyKey: `khalti:${d.pidx}`,
      rawPayload: lookup as Record<string, unknown>,
    });
    res.json({ verified: true, gateway: 'KHALTI_V2', ...settlement });
    return;
  }

  // Verify Sandbox Simulator HMAC-SHA256 signature strictly (blocks forged callbacks!)
  const expectedSig = crypto
    .createHmac('sha256', KHALTI_SANDBOX_SIM_SECRET)
    .update(`${d.pidx}:${d.booking_id}:${d.amount_paisa ?? 0}:${d.status}`)
    .digest('hex');
  if (!d.sandbox_signature || d.sandbox_signature !== expectedSig) {
    res.status(401).json({ error: 'Invalid Khalti Sandbox HMAC signature' });
    return;
  }

  const settlement = await settleVerifiedGatewayPayment({
    bookingId: d.booking_id,
    gatewayMethod: 'KHALTI',
    gatewayRefId: d.pidx,
    idempotencyKey: `khalti:${d.pidx}`,
    rawPayload: d,
  });
  res.json({ verified: true, gateway: 'KHALTI_V2_SANDBOX', ...settlement });
});

// =========================================================================
// 3. Fonepay PRN / Dynamic QR Sandbox (HMAC-SHA512)
// =========================================================================
paymentGatewaysRouter.post('/payments/gateways/fonepay/sign', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      booking_id: z.string().uuid(),
      amount_npr: z.number().min(10),
      return_url: z.string().url(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const prn = `SPL${Date.now()}`;
  const amt = parsed.data.amount_npr.toFixed(2);
  const dt = new Date().toLocaleDateString('en-US');
  const r1 = `Sipalu-${parsed.data.booking_id.slice(0, 8)}`;
  const r2 = 'BanepaPilot';
  const md = 'P';
  const crn = 'NPR';
  const msg = `${FONEPAY_PID},${md},${prn},${amt},${crn},${dt},${r1},${r2},${parsed.data.return_url}`;
  const dv = crypto.createHmac('sha512', FONEPAY_SECRET_KEY).update(msg).digest('hex');

  // Genuine HMAC-SHA512 signed callback payload for sandbox verification
  const uid = `FP${Date.now().toString().slice(-7)}`;
  const cbMsg = `${prn},${FONEPAY_PID},true,0,${uid},${amt},00,successful`;
  const cbDv = crypto.createHmac('sha512', FONEPAY_SECRET_KEY).update(cbMsg).digest('hex');

  res.json({
    gateway: 'FONEPAY_PRN_QR',
    mode: FONEPAY_PID === 'NBQM' ? 'SANDBOX' : 'PRODUCTION',
    action_url: FONEPAY_URL,
    qr_string: `fonepay://pay?pid=${FONEPAY_PID}&prn=${prn}&amt=${amt}&crn=NPR&merchant=Sipalu`,
    params: { PID: FONEPAY_PID, MD: md, PRN: prn, AMT: amt, CRN: crn, DT: dt, R1: r1, R2: r2, RU: parsed.data.return_url, DV: dv },
    simulated_callback: {
      booking_id: parsed.data.booking_id,
      PRN: prn,
      PID: FONEPAY_PID,
      PS: 'true',
      RC: '0',
      UID: uid,
      BC: amt,
      INI: '00',
      P_AMT: 'successful',
      DV: cbDv,
    },
  });
});

paymentGatewaysRouter.post('/payments/webhooks/fonepay', async (req, res) => {
  const b = req.body || {};
  if (!b.PRN || !b.PID || !b.DV || !b.booking_id) {
    res.status(400).json({ error: 'Missing required Fonepay callback fields (PRN, PID, DV, booking_id)' });
    return;
  }
  const cbMsg = `${b.PRN},${b.PID},${b.PS},${b.RC},${b.UID},${b.BC},${b.INI},${b.P_AMT}`;
  const expectedDv = crypto.createHmac('sha512', FONEPAY_SECRET_KEY).update(cbMsg).digest('hex');
  if (expectedDv !== b.DV) {
    res.status(401).json({ error: 'Invalid Fonepay HMAC-SHA512 DV signature' });
    return;
  }
  if (String(b.PS) !== 'true') {
    res.status(400).json({ error: 'Fonepay transaction unsuccessful' });
    return;
  }

  const settlement = await settleVerifiedGatewayPayment({
    bookingId: b.booking_id,
    gatewayMethod: 'FONEPAY_QR',
    gatewayRefId: String(b.UID || b.PRN),
    idempotencyKey: `fonepay:${b.PRN}`,
    rawPayload: b,
  });
  res.json({ verified: true, gateway: 'FONEPAY_PRN_QR', ...settlement });
});

// =========================================================================
// 4. Gateway Sandbox Status Endpoint
// =========================================================================
paymentGatewaysRouter.get('/payments/gateways/status', (_req, res) => {
  res.json({
    app_brand: 'Sipalu',
    esewa: {
      configured: true,
      mode: ESEWA_PRODUCT_CODE === 'EPAYTEST' ? 'SANDBOX_READY' : 'LIVE',
      product_code: ESEWA_PRODUCT_CODE,
      endpoint: ESEWA_EPAY_URL,
    },
    khalti: {
      configured: true,
      mode: KHALTI_SECRET_KEY ? 'KHALTI_SANDBOX_LIVE' : 'SANDBOX_SIMULATOR_READY',
      endpoint: KHALTI_API_BASE,
    },
    fonepay: {
      configured: true,
      mode: FONEPAY_PID === 'NBQM' ? 'SANDBOX_READY' : 'LIVE',
      pid: FONEPAY_PID,
      endpoint: FONEPAY_URL,
    },
  });
});
