import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { requireAuth } from '../auth.js';

export const paymentGatewaysRouter = Router();

const ESEWA_PRODUCT_CODE = process.env.ESEWA_PRODUCT_CODE || 'EPAYTEST';
const ESEWA_SECRET_KEY = process.env.ESEWA_SECRET_KEY || '8gBm/:&EnhH.1/q';
const ESEWA_EPAY_URL =
  process.env.ESEWA_EPAY_URL || 'https://rc-epay.esewa.com.np/api/epay/main/v2/form';

const KHALTI_SECRET_KEY = process.env.KHALTI_SECRET_KEY || '';
const KHALTI_API_BASE = process.env.KHALTI_API_BASE || 'https://a.khalti.com/api/v2';

const FONEPAY_PID = process.env.FONEPAY_PID || 'NBQM';
const FONEPAY_SECRET_KEY = process.env.FONEPAY_SECRET_KEY || 'a7e3512f5032480a83137793cb2021dc';
const FONEPAY_URL =
  process.env.FONEPAY_URL || 'https://dev-clientapi.fonepay.com/api/merchantRequest';

/**
 * 1. eSewa ePay v2 — Generates HMAC-SHA256 signed form fields ready for browser POST
 */
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
  const transactionUuid = `${parsed.data.booking_id.slice(0, 8)}-${Date.now()}`;
  const signedFieldNames = 'total_amount,transaction_uuid,product_code';
  const message = `total_amount=${totalAmount},transaction_uuid=${transactionUuid},product_code=${ESEWA_PRODUCT_CODE}`;
  const signature = crypto.createHmac('sha256', ESEWA_SECRET_KEY).update(message).digest('base64');

  res.json({
    gateway: 'ESEWA_V2',
    mode: ESEWA_PRODUCT_CODE === 'EPAYTEST' ? 'SANDBOX' : 'PRODUCTION',
    action_url: ESEWA_EPAY_URL,
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
  });
});

/**
 * eSewa ePay v2 — Verify base64 callback payload HMAC-SHA256 signature
 */
paymentGatewaysRouter.post('/payments/webhooks/esewa', async (req, res) => {
  const encoded = String(req.body?.data || '');
  if (!encoded) {
    res.status(400).json({ error: 'Missing base64 data payload' });
    return;
  }
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8')) as Record<string, string>;
  const fields = (decoded.signed_field_names || '').split(',').filter(Boolean);
  const message = fields.map((f) => `${f}=${decoded[f] ?? ''}`).join(',');
  const expectedSig = crypto.createHmac('sha256', ESEWA_SECRET_KEY).update(message).digest('base64');

  if (expectedSig !== decoded.signature) {
    res.status(401).json({ error: 'Invalid eSewa HMAC-SHA256 signature' });
    return;
  }
  res.json({ verified: true, status: decoded.status, transaction_uuid: decoded.transaction_uuid });
});

/**
 * 2. Khalti ePayment v2 — Initiate Checkout URL (server-to-server)
 */
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

  if (!KHALTI_SECRET_KEY) {
    res.status(503).json({
      error: 'KHALTI_SECRET_KEY is not configured yet. Add it in Azure Container Apps Secrets per docs/07-nepal-payment-gateways-guide.md',
    });
    return;
  }

  const resp = await fetch(`${KHALTI_API_BASE}/epayment/initiate/`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${KHALTI_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      return_url: parsed.data.return_url,
      website_url: parsed.data.website_url,
      amount: Math.round(parsed.data.amount_npr * 100), // Khalti expects paisa
      purchase_order_id: parsed.data.booking_id,
      purchase_order_name: parsed.data.purchase_order_name,
      customer_info: {
        name: req.user!.full_name,
        phone: req.user!.phone_e164.replace('+977', ''),
      },
    }),
  });
  const data = await resp.json();
  res.status(resp.status).json(data);
});

/**
 * 3. Fonepay PRN / Dynamic QR — Generates HMAC-SHA512 signed redirect payload
 */
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
  const dt = new Date().toLocaleDateString('en-US'); // MM/DD/YYYY
  const r1 = `Sipalu-${parsed.data.booking_id.slice(0, 8)}`;
  const r2 = 'N/A';
  const md = 'P';
  const crn = 'NPR';
  const msg = `${FONEPAY_PID},${md},${prn},${amt},${crn},${dt},${r1},${r2},${parsed.data.return_url}`;
  const dv = crypto.createHmac('sha512', FONEPAY_SECRET_KEY).update(msg).digest('hex');

  res.json({
    gateway: 'FONEPAY_PRN',
    action_url: FONEPAY_URL,
    params: { PID: FONEPAY_PID, MD: md, PRN: prn, AMT: amt, CRN: crn, DT: dt, R1: r1, R2: r2, RU: parsed.data.return_url, DV: dv },
  });
});

/**
 * Gateway Configuration Status Endpoint (Shows which live/sandbox Nepal gateways are wired)
 */
paymentGatewaysRouter.get('/payments/gateways/status', (_req, res) => {
  res.json({
    esewa: {
      configured: Boolean(process.env.ESEWA_SECRET_KEY),
      mode: ESEWA_PRODUCT_CODE === 'EPAYTEST' ? 'SANDBOX_DEFAULT' : 'LIVE',
    },
    khalti: {
      configured: Boolean(KHALTI_SECRET_KEY),
      mode: KHALTI_API_BASE.includes('a.khalti.com') ? 'SANDBOX' : 'LIVE',
    },
    fonepay: {
      configured: Boolean(process.env.FONEPAY_SECRET_KEY),
      mode: FONEPAY_PID === 'NBQM' ? 'SANDBOX_DEFAULT' : 'LIVE',
    },
  });
});
