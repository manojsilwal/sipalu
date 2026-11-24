import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import {
  hashPassword,
  parsePgTextArray,
  requireAnyRole,
  requireAuth,
  signToken,
  verifyPassword,
} from '../auth.js';
import { ensureProviderLedgerAccounts } from '../ledger.js';

export const authAndKycRouter = Router();

// Basic Username + Password Registration (Active default for Pilot / Azure Student launch)
authAndKycRouter.post('/auth/register', async (req, res) => {
  const parsed = z
    .object({
      username: z
        .string()
        .min(3)
        .max(40)
        .regex(/^[a-zA-Z0-9._-]+$/, 'Username may contain letters, numbers, dot, underscore, hyphen'),
      password: z.string().min(6).max(128),
      full_name: z.string().min(2).max(150),
      phone_e164: z
        .string()
        .regex(/^\+977\d{10}$/, 'Must be valid Nepal +977 phone')
        .optional(),
      role: z.enum(['CUSTOMER', 'PROVIDER']).default('CUSTOMER'),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const phone = d.phone_e164 || `+97798${Math.floor(10000000 + Math.random() * 89999999)}`;
  const passwordHash = hashPassword(d.password);

  const user = await withTransaction(async (client) => {
    const dup = await client.query(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR phone_e164 = $2`,
      [d.username, phone]
    );
    if (dup.rows[0]) {
      throw Object.assign(new Error('Username or phone number already registered'), { statusCode: 409 });
    }
    const created = await client.query(
      `INSERT INTO users (username, password_hash, phone_e164, full_name, roles)
       VALUES ($1, $2, $3, $4, ARRAY[$5]::user_role[])
       RETURNING id, username, phone_e164, email, full_name, roles`,
      [d.username.trim(), passwordHash, phone, d.full_name.trim(), d.role]
    );
    const u = created.rows[0];
    if (d.role === 'PROVIDER') {
      await client.query(
        `INSERT INTO provider_profiles (user_id, primary_city, kyc_status, availability_state)
         VALUES ($1, 'BANEPA', 'PENDING_SUBMISSION', 'OFFLINE')
         ON CONFLICT (user_id) DO NOTHING`,
        [u.id]
      );
    } else {
      // Seed a default Banepa address so new customers can book immediately
      await client.query(
        `INSERT INTO user_addresses (user_id, label, city, ward_no, tole_neighborhood, exact_address_line, exact_location, masked_location, is_default)
         VALUES ($1, 'Home (Banepa)', 'Banepa', 7, 'Tindobato Area', 'Banepa Ward 7, Kavre',
           ST_SetSRID(ST_MakePoint(85.5214, 27.6298), 4326)::geography,
           ST_SetSRID(ST_MakePoint(85.5250, 27.6325), 4326)::geography, TRUE)`,
        [u.id]
      );
    }
    return u;
  });

  const roles = parsePgTextArray(user.roles);
  const token = signToken({
    id: user.id,
    phone_e164: user.phone_e164,
    full_name: user.full_name,
    roles,
  });
  res.status(201).json({
    token,
    user: { id: user.id, username: user.username, phone_e164: user.phone_e164, full_name: user.full_name, roles },
  });
});

// Basic Username + Password Login
authAndKycRouter.post('/auth/login', async (req, res) => {
  const parsed = z
    .object({
      username: z.string().min(2).max(120),
      password: z.string().min(1).max(128),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, username, password_hash, phone_e164, email, full_name, roles, is_active, is_anonymized
     FROM users
     WHERE LOWER(username) = LOWER($1) OR LOWER(email::text) = LOWER($1) OR phone_e164 = $1
     LIMIT 1`,
    [parsed.data.username.trim()]
  );
  const user = rows[0];
  if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  if (!user.is_active || user.is_anonymized) {
    res.status(403).json({ error: 'Account inactive or anonymized' });
    return;
  }

  const roles = parsePgTextArray(user.roles);
  const token = signToken({
    id: user.id,
    phone_e164: user.phone_e164,
    full_name: user.full_name,
    roles,
  });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      phone_e164: user.phone_e164,
      email: user.email,
      full_name: user.full_name,
      roles,
    },
  });
});

// In-memory OTP store (kept optional for Phase 2 SMS OTP upgrade)
const otpStore = new Map<string, { code: string; expiresAt: number }>();

authAndKycRouter.post('/auth/otp/request', async (req, res) => {
  const parsed = z
    .object({
      phone_e164: z.string().regex(/^\+977\d{10}$/, 'Must be valid Nepal +977 phone'),
      locale: z.enum(['en', 'ne']).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const code = '123456'; // Deterministic pilot OTP (ACS SMS in prod)
  otpStore.set(parsed.data.phone_e164, { code, expiresAt: Date.now() + 5 * 60_000 });
  res.status(202).json({
    message: 'OTP dispatched',
    phone_e164: parsed.data.phone_e164,
    demo_hint: process.env.NODE_ENV === 'production' ? undefined : '123456',
  });
});

authAndKycRouter.post('/auth/otp/verify', async (req, res) => {
  const parsed = z
    .object({
      phone_e164: z.string().regex(/^\+977\d{10}$/),
      otp_code: z.string().length(6),
      full_name: z.string().min(2).max(150).optional(),
      role: z.enum(['CUSTOMER', 'PROVIDER']).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const record = otpStore.get(parsed.data.phone_e164);
  const validDemo = process.env.NODE_ENV !== 'production' && parsed.data.otp_code === '123456';
  if (!validDemo && (!record || record.code !== parsed.data.otp_code || record.expiresAt < Date.now())) {
    res.status(401).json({ error: 'Invalid or expired OTP' });
    return;
  }
  otpStore.delete(parsed.data.phone_e164);

  const user = await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT id, phone_e164, email, full_name, roles, is_active, is_anonymized
       FROM users WHERE phone_e164 = $1`,
      [parsed.data.phone_e164]
    );
    if (existing.rows[0]) {
      return existing.rows[0];
    }
    const role = parsed.data.role || 'CUSTOMER';
    const created = await client.query(
      `INSERT INTO users (phone_e164, full_name, roles)
       VALUES ($1, $2, ARRAY[$3]::user_role[])
       RETURNING id, phone_e164, email, full_name, roles, is_active, is_anonymized`,
      [parsed.data.phone_e164, parsed.data.full_name || 'Sipalu User', role]
    );
    if (role === 'PROVIDER') {
      await client.query(
        `INSERT INTO provider_profiles (user_id, primary_city, kyc_status, availability_state)
         VALUES ($1, 'BANEPA', 'PENDING_SUBMISSION', 'OFFLINE')
         ON CONFLICT (user_id) DO NOTHING`,
        [created.rows[0].id]
      );
    }
    return created.rows[0];
  });

  if (!user.is_active || user.is_anonymized) {
    res.status(403).json({ error: 'Account inactive or anonymized' });
    return;
  }

  const roles = parsePgTextArray(user.roles);
  const token = signToken({
    id: user.id,
    phone_e164: user.phone_e164,
    full_name: user.full_name,
    roles,
  });

  res.json({
    token,
    user: { id: user.id, phone_e164: user.phone_e164, email: user.email, full_name: user.full_name, roles },
  });
});

// List demo personas in non-production for quick human/QA role switching
authAndKycRouter.get('/auth/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.phone_e164, u.email, u.full_name, u.preferred_locale, u.roles,
            p.tier_code, p.kyc_status, p.availability_state, p.primary_city, p.visibility_score,
            p.lifetime_completed_jobs, p.rolling_avg_rating, p.cash_jobs_enabled,
            p.financial_account_verified, p.linked_bank_name, p.linked_esewa_id,
            p.new_provider_grace_until, p.cooldown_until,
            w.current_float_npr, w.is_cash_paused, w.auto_pause_threshold_npr
     FROM users u
     LEFT JOIN provider_profiles p ON p.user_id = u.id
     LEFT JOIN provider_float_wallets w ON w.provider_user_id = u.id
     WHERE u.id = $1`,
    [req.user!.id]
  );
  const u = rows[0];
  const addresses = await pool.query(
    `SELECT id, label, city, ward_no, tole_neighborhood, exact_address_line,
            ST_Y(exact_location::geometry) AS lat, ST_X(exact_location::geometry) AS lng, is_default
     FROM user_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [req.user!.id]
  );
  const pendingSelfie = await pool.query(
    `SELECT id, trigger_reason, requested_at FROM random_selfie_checks
     WHERE provider_user_id = $1 AND completed_at IS NULL
     ORDER BY requested_at DESC LIMIT 1`,
    [req.user!.id]
  );
  const loyalty = await pool.query(
    `SELECT COALESCE(SUM(points_delta), 0)::int AS points FROM loyalty_point_ledger WHERE user_id = $1`,
    [req.user!.id]
  );
  const payable = await pool.query(
    `SELECT balance_npr FROM ledger_accounts WHERE code = $1`,
    [`PROV_PAYABLE:${req.user!.id}`]
  );

  res.json({
    ...u,
    roles: parsePgTextArray(u.roles),
    addresses: addresses.rows,
    loyalty_points: loyalty.rows[0]?.points ?? 0,
    payable_balance_npr: payable.rows[0] ? Number(payable.rows[0].balance_npr) : 0,
    pending_selfie_check: pendingSelfie.rows[0] || null,
  });
});

// User Address Management (Auto-generates ~500m masked centroid for bidding privacy)
authAndKycRouter.post('/users/me/addresses', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      label: z.string().min(2).max(60),
      city: z.string().min(2).max(80),
      ward_no: z.number().int().min(1).max(35).optional(),
      tole_neighborhood: z.string().min(2).max(120),
      exact_address_line: z.string().min(5).max(300),
      lat: z.number().min(26).max(31),
      lng: z.number().min(80).max(89),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  // Deterministic ~500m jitter for masked_location (never leaks exact pin before acceptance)
  const maskedLat = d.lat + 0.0038;
  const maskedLng = d.lng + 0.0042;
  const { rows } = await pool.query(
    `INSERT INTO user_addresses (user_id, label, city, ward_no, tole_neighborhood, exact_address_line, exact_location, masked_location)
     VALUES ($1, $2, $3, $4, $5, $6,
       ST_SetSRID(ST_MakePoint($8, $7), 4326)::geography,
       ST_SetSRID(ST_MakePoint($10, $9), 4326)::geography
     )
     RETURNING id, label, city, ward_no, tole_neighborhood, exact_address_line`,
    [req.user!.id, d.label, d.city, d.ward_no || null, d.tole_neighborhood, d.exact_address_line, d.lat, d.lng, maskedLat, maskedLng]
  );
  res.status(201).json(rows[0]);
});

// Biometric KYC: Create Azure AI Vision Active Liveness Session
authAndKycRouter.post('/providers/kyc/liveness-session', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      purpose: z.enum(['INITIAL_KYC', 'RANDOM_SELFIE_RECHECK']),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const sessionId = `azface-${crypto.randomUUID()}`;
  res.status(201).json({
    session_id: sessionId,
    auth_token: crypto.randomBytes(16).toString('hex'),
    purpose: parsed.data.purpose,
    upload_urls: {
      doc_front_sas: `https://sipalust.blob.core.windows.net/kyc-biometric-vault/${req.user!.id}/front.jpg?se=5m`,
      doc_back_sas: `https://sipalust.blob.core.windows.net/kyc-biometric-vault/${req.user!.id}/back.jpg?se=5m`,
      selfie_sas: `https://sipalust.blob.core.windows.net/kyc-biometric-vault/${req.user!.id}/selfie.jpg?se=5m`,
    },
  });
});

// Biometric KYC Submission (Citizenship/National ID + Liveness + Mandatory Financial Linking)
authAndKycRouter.post('/providers/kyc/submit', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      document_type: z.enum(['CITIZENSHIP_NAGARIKTA', 'NATIONAL_ID_RASTRIYA']),
      document_number: z.string().min(4).max(64),
      doc_front_blob_path: z.string().min(5),
      doc_back_blob_path: z.string().min(5),
      selfie_blob_path: z.string().min(5),
      azure_liveness_session_id: z.string().min(5),
      liveness_passed: z.boolean().default(true),
      simulated_face_score: z.number().min(0).max(1).optional(),
      primary_city: z.string().min(2).max(80),
      service_radius_km: z.number().min(2).max(50).default(8),
      specialties: z.array(z.string()).min(1),
      linked_bank_name: z.string().optional(),
      linked_bank_account_no: z.string().optional(),
      linked_esewa_id: z.string().optional(),
      pan_number: z.string().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const hasFinancialLink = Boolean(
    (d.linked_bank_name && d.linked_bank_account_no) || d.linked_esewa_id
  );
  if (!hasFinancialLink) {
    res.status(400).json({
      error: 'Mandatory bank account or eSewa wallet linking is required during KYC onboarding',
    });
    return;
  }

  // Evaluate Face match score thresholds per SOP-01 (>=0.85 fast-track, 0.70-0.84 manual, <0.70 auto-reject)
  const faceScore = d.simulated_face_score ?? 0.92;
  const autoRejected = !d.liveness_passed || faceScore < 0.7;
  const status = autoRejected ? 'REJECTED_RESUBMIT' : 'UNDER_ADMIN_REVIEW';

  const result = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO provider_profiles (
         user_id, primary_city, service_radius_km, specialties,
         linked_bank_name, linked_bank_account_no, linked_esewa_id,
         financial_account_verified, pan_number, kyc_status,
         home_base_location, last_known_location, last_location_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::kyc_status,
         ST_SetSRID(ST_MakePoint(85.5220, 27.6305), 4326)::geography,
         ST_SetSRID(ST_MakePoint(85.5220, 27.6305), 4326)::geography, NOW()
       )
       ON CONFLICT (user_id) DO UPDATE SET
         primary_city = EXCLUDED.primary_city,
         service_radius_km = EXCLUDED.service_radius_km,
         specialties = EXCLUDED.specialties,
         linked_bank_name = EXCLUDED.linked_bank_name,
         linked_bank_account_no = EXCLUDED.linked_bank_account_no,
         linked_esewa_id = EXCLUDED.linked_esewa_id,
         financial_account_verified = EXCLUDED.financial_account_verified,
         pan_number = EXCLUDED.pan_number,
         kyc_status = EXCLUDED.kyc_status,
         updated_at = NOW()`,
      [
        req.user!.id,
        d.primary_city.toUpperCase(),
        d.service_radius_km,
        d.specialties,
        d.linked_bank_name || null,
        d.linked_bank_account_no || null,
        d.linked_esewa_id || null,
        hasFinancialLink,
        d.pan_number || null,
        status,
      ]
    );

    const kyc = await client.query(
      `INSERT INTO kyc_verifications (
         provider_user_id, document_type, document_number,
         doc_front_blob_path, doc_back_blob_path, selfie_blob_path,
         azure_liveness_session_id, liveness_passed, face_match_confidence,
         status, rejection_reason
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::kyc_status, $11)
       RETURNING *`,
      [
        req.user!.id,
        d.document_type,
        d.document_number,
        d.doc_front_blob_path,
        d.doc_back_blob_path,
        d.selfie_blob_path,
        d.azure_liveness_session_id,
        d.liveness_passed,
        faceScore,
        status,
        autoRejected ? 'Biometric liveness failed or face match confidence < 0.70. Please retry in good lighting.' : null,
      ]
    );
    return kyc.rows[0];
  });

  res.status(201).json(result);
});

// Complete a Pending Periodic Random Selfie Re-Check (SOP-01 / L12)
authAndKycRouter.post('/providers/kyc/random-selfie/complete', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      check_id: z.string().uuid(),
      azure_liveness_session_id: z.string().min(5),
      selfie_blob_path: z.string().min(5),
      simulated_face_score: z.number().min(0).max(1).default(0.93),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const passed = parsed.data.simulated_face_score >= 0.85;
  const updated = await withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE random_selfie_checks
       SET azure_liveness_session_id = $1, selfie_blob_path = $2,
           face_match_confidence = $3, passed = $4, completed_at = NOW()
       WHERE id = $5 AND provider_user_id = $6 AND completed_at IS NULL
       RETURNING *`,
      [
        parsed.data.azure_liveness_session_id,
        parsed.data.selfie_blob_path,
        parsed.data.simulated_face_score,
        passed,
        parsed.data.check_id,
        req.user!.id,
      ]
    );
    if (!r.rows[0]) return null;
    if (!passed) {
      await client.query(
        `UPDATE provider_profiles SET kyc_status = 'SUSPENDED', availability_state = 'OFFLINE' WHERE user_id = $1`,
        [req.user!.id]
      );
      await client.query(
        `INSERT INTO anti_leakage_flags (provider_user_id, flag_type, evidence_summary)
         VALUES ($1, 'FAILED_RANDOM_SELFIE', $2::jsonb)`,
        [req.user!.id, JSON.stringify({ check_id: parsed.data.check_id, score: parsed.data.simulated_face_score })]
      );
    }
    return r.rows[0];
  });
  if (!updated) {
    res.status(404).json({ error: 'Pending random selfie check not found' });
    return;
  }
  res.json(updated);
});

// Admin: List & Review Biometric KYC Queue + Trigger Random Selfie Re-Check
authAndKycRouter.get(
  '/admin/kyc/queue',
  requireAuth,
  requireAnyRole('KYC_REVIEWER', 'SUPER_ADMIN'),
  async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT k.*, u.full_name, u.phone_e164, p.primary_city, p.linked_bank_name,
             p.linked_bank_account_no, p.linked_esewa_id, p.financial_account_verified
      FROM kyc_verifications k
      JOIN users u ON u.id = k.provider_user_id
      JOIN provider_profiles p ON p.user_id = k.provider_user_id
      ORDER BY k.submitted_at DESC
      LIMIT 50
    `);
    res.json({ items: rows });
  }
);

authAndKycRouter.post(
  '/admin/kyc/:kycId/review',
  requireAuth,
  requireAnyRole('KYC_REVIEWER', 'SUPER_ADMIN'),
  async (req, res) => {
    const parsed = z
      .object({
        decision: z.enum(['VERIFIED_ACTIVE', 'REJECTED_RESUBMIT', 'SUSPENDED']),
        academy_skill_score: z.number().int().min(0).max(100).optional(),
        reason: z.string().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const updated = await withTransaction(async (client) => {
      const kRes = await client.query(`SELECT * FROM kyc_verifications WHERE id = $1`, [req.params.kycId]);
      if (!kRes.rows[0]) return null;
      const kyc = kRes.rows[0];

      // Enforce mandatory financial account verification before activation (L1)
      if (parsed.data.decision === 'VERIFIED_ACTIVE') {
        const pCheck = await client.query(
          `SELECT financial_account_verified FROM provider_profiles WHERE user_id = $1`,
          [kyc.provider_user_id]
        );
        if (!pCheck.rows[0]?.financial_account_verified) {
          throw Object.assign(
            new Error('Cannot activate provider without verified bank/eSewa account linking'),
            { statusCode: 400 }
          );
        }
      }

      const out = await client.query(
        `UPDATE kyc_verifications
         SET status = $1::kyc_status, academy_skill_score = $2, rejection_reason = $3,
             reviewed_by = $4, reviewed_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [
          parsed.data.decision,
          parsed.data.academy_skill_score ?? null,
          parsed.data.reason ?? null,
          req.user!.id,
          req.params.kycId,
        ]
      );

      if (parsed.data.decision === 'VERIFIED_ACTIVE') {
        // Activate 14-day New Verified grace period & initialize ledger accounts
        await ensureProviderLedgerAccounts(client, kyc.provider_user_id);
        await client.query(
          `UPDATE provider_profiles
           SET kyc_status = 'VERIFIED_ACTIVE',
               new_provider_grace_until = NOW() + INTERVAL '14 days',
               cash_jobs_enabled = TRUE,
               updated_at = NOW()
           WHERE user_id = $1`,
          [kyc.provider_user_id]
        );
      } else {
        await client.query(
          `UPDATE provider_profiles
           SET kyc_status = $1::kyc_status, availability_state = 'OFFLINE', cash_jobs_enabled = FALSE, updated_at = NOW()
           WHERE user_id = $2`,
          [parsed.data.decision, kyc.provider_user_id]
        );
      }
      return out.rows[0];
    });

    if (!updated) {
      res.status(404).json({ error: 'KYC submission not found' });
      return;
    }
    res.json(updated);
  }
);

authAndKycRouter.post(
  '/admin/providers/:providerId/trigger-random-selfie',
  requireAuth,
  requireAnyRole('KYC_REVIEWER', 'OPS_DISPATCHER', 'SUPER_ADMIN'),
  async (req, res) => {
    const reason = typeof req.body?.trigger_reason === 'string' ? req.body.trigger_reason : 'PERIODIC_14D';
    const { rows } = await pool.query(
      `INSERT INTO random_selfie_checks (provider_user_id, trigger_reason)
       VALUES ($1, $2) RETURNING *`,
      [req.params.providerId, reason]
    );
    await pool.query(
      `UPDATE provider_profiles SET availability_state = 'OFFLINE' WHERE user_id = $1`,
      [req.params.providerId]
    );
    res.status(201).json(rows[0]);
  }
);
