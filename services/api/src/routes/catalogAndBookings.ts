import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { requireAuth } from '../auth.js';
import { realtimeHub } from '../ws.js';

export const catalogAndBookingsRouter = Router();

// 1. Bilingual Symptom Search & Service Catalog (Mirrors Azure AI Search)
catalogAndBookingsRouter.get('/catalog/zones', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, code, name_en, name_ne, is_pilot_active, is_active FROM service_zones ORDER BY is_pilot_active DESC, name_en ASC`
  );
  res.json({ zones: rows });
});

catalogAndBookingsRouter.get('/catalog/search', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const zoneCode = String(req.query.zone_code || 'BANEPA').toUpperCase();
  const categorySlug = req.query.category_slug ? String(req.query.category_slug) : null;

  const { rows } = await pool.query(
    `SELECT s.id, s.slug, s.title_en, s.title_ne, s.pricing_mode,
            COALESCE(cp.labor_price_npr, s.base_labor_npr) AS labor_price_npr,
            COALESCE(cp.visiting_fee_npr, 100.00) AS visiting_fee_npr,
            s.unit_label, s.estimated_duration_min, s.warranty_days,
            s.min_bid_sanity_npr, s.max_bid_sanity_npr, s.symptom_keywords,
            c.slug AS category_slug, c.name_en AS category_name_en, c.name_ne AS category_name_ne,
            sub.name_en AS subcategory_name_en
     FROM service_skus s
     JOIN subcategories sub ON sub.id = s.subcategory_id
     JOIN categories c ON c.id = sub.category_id
     LEFT JOIN service_zones z ON z.code = $1
     LEFT JOIN city_sku_pricing cp ON cp.sku_id = s.id AND cp.zone_id = z.id
     WHERE s.is_active = TRUE
       AND ($2::text IS NULL OR c.slug = $2)
       AND (
         $3 = ''
         OR LOWER(s.title_en) LIKE '%' || $3 || '%'
         OR LOWER(s.title_ne) LIKE '%' || $3 || '%'
         OR LOWER(c.name_en) LIKE '%' || $3 || '%'
         OR EXISTS (SELECT 1 FROM unnest(s.symptom_keywords) kw WHERE LOWER(kw) LIKE '%' || $3 || '%' OR $3 LIKE '%' || LOWER(kw) || '%')
       )
     ORDER BY c.sort_order, s.base_labor_npr ASC`,
    [zoneCode, categorySlug, q]
  );

  res.json({ zone_code: zoneCode, query: q, count: rows.length, services: rows });
});

// 2. Hybrid Booking Creation (Instant Fixed-Price <60s OR Live Competitive Bidding 10-15m)
catalogAndBookingsRouter.post('/bookings', requireAuth, async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key') || crypto.randomUUID();
  const parsed = z
    .object({
      zone_code: z.string().default('BANEPA'),
      category_slug: z.string().default('plumbing'),
      sku_id: z.string().uuid().optional(),
      booking_mode: z.enum(['INSTANT_FIXED', 'LIVE_BIDDING']),
      urgency: z.enum(['URGENT_ASAP', 'SAME_DAY', 'SCHEDULED']).default('URGENT_ASAP'),
      address_id: z.string().uuid(),
      quantity: z.number().int().min(1).max(20).default(1),
      issue_description: z.string().min(3).max(1000),
      requested_slot_start: z.string().datetime(),
      requested_slot_end: z.string().datetime(),
      promo_code: z.string().optional(),
      payment_method: z
        .enum(['CASH', 'ESEWA', 'KHALTI', 'FONEPAY_QR', 'CONNECT_IPS', 'CARD', 'ESCROW_WALLET'])
        .optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  if (new Date(d.requested_slot_end) <= new Date(d.requested_slot_start)) {
    res.status(400).json({ error: 'requested_slot_end must be after requested_slot_start' });
    return;
  }

  const booking = await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT * FROM bookings WHERE client_idempotency_key = $1`,
      [idempotencyKey]
    );
    if (existing.rows[0]) return existing.rows[0];

    const zRes = await client.query(`SELECT id FROM service_zones WHERE code = $1`, [
      d.zone_code.toUpperCase(),
    ]);
    const cRes = await client.query(`SELECT id FROM categories WHERE slug = $1`, [d.category_slug]);
    const aRes = await client.query(
      `SELECT id FROM user_addresses WHERE id = $1 AND user_id = $2`,
      [d.address_id, req.user!.id]
    );
    if (!zRes.rows[0] || !cRes.rows[0] || !aRes.rows[0]) {
      throw Object.assign(new Error('Invalid zone, category, or address'), { statusCode: 400 });
    }

    let quotedLabor = 0;
    let durationMin = 60;
    let warrantyDays = 30;
    if (d.sku_id) {
      const sRes = await client.query(
        `SELECT base_labor_npr, estimated_duration_min, warranty_days FROM service_skus WHERE id = $1`,
        [d.sku_id]
      );
      if (sRes.rows[0]) {
        quotedLabor = Number(sRes.rows[0].base_labor_npr) * d.quantity;
        durationMin = Number(sRes.rows[0].estimated_duration_min);
        warrantyDays = Number(sRes.rows[0].warranty_days);
      }
    }

    // Apply promo code if valid
    let discountNpr = 0;
    if (d.promo_code) {
      const pRes = await client.query(
        `SELECT * FROM promo_codes WHERE UPPER(code) = UPPER($1) AND is_active = TRUE AND NOW() BETWEEN valid_from AND valid_until`,
        [d.promo_code]
      );
      if (pRes.rows[0] && quotedLabor >= Number(pRes.rows[0].min_order_npr)) {
        const promo = pRes.rows[0];
        discountNpr =
          promo.discount_type === 'PERCENT'
            ? Math.min(Number(promo.max_discount_npr || 99999), (quotedLabor * Number(promo.discount_value)) / 100)
            : Number(promo.discount_value);
      }
    }

    const code = `SPL-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const initialStatus = d.booking_mode === 'LIVE_BIDDING' ? 'LIVE_BIDDING' : 'AUTO_DISPATCHING';
    const bidWindowMins = d.urgency === 'URGENT_ASAP' ? 15 : 60;
    const biddingClosesAt =
      d.booking_mode === 'LIVE_BIDDING'
        ? new Date(Date.now() + bidWindowMins * 60_000).toISOString()
        : null;

    const visitingFee = 100;
    const finalEst = Math.max(0, quotedLabor + visitingFee - discountNpr);

    // For INSTANT_FIXED: attempt 60s auto-dispatch to highest-ranked available conflict-free provider
    let assignedProviderId: string | null = null;
    let resolvedStatus = initialStatus;
    let exactAddressUnlocked = false;

    const inserted = await client.query(
      `INSERT INTO bookings (
         booking_code, customer_id, zone_id, category_id, sku_id, booking_mode, urgency, status,
         address_id, exact_address_unlocked, issue_description, quantity,
         requested_slot_start, requested_slot_end, bidding_closes_at, estimated_duration_min,
         quoted_labor_npr, visiting_fee_npr, discount_npr, final_total_npr,
         payment_method, warranty_days, client_idempotency_key
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [
        code,
        req.user!.id,
        zRes.rows[0].id,
        cRes.rows[0].id,
        d.sku_id || null,
        d.booking_mode,
        d.urgency,
        initialStatus,
        d.address_id,
        false,
        d.issue_description,
        d.quantity,
        d.requested_slot_start,
        d.requested_slot_end,
        biddingClosesAt,
        durationMin,
        quotedLabor,
        visitingFee,
        discountNpr,
        finalEst,
        d.payment_method || 'ESEWA',
        warrantyDays,
        idempotencyKey,
      ]
    );
    const bk = inserted.rows[0];

    if (d.booking_mode === 'INSTANT_FIXED') {
      // Find top available verified provider without calendar overlap & cash-float eligible if CASH
      const cand = await client.query(
        `SELECT p.user_id
         FROM provider_profiles p
         WHERE p.kyc_status = 'VERIFIED_ACTIVE'
           AND p.availability_state = 'AVAILABLE'
           AND (p.cooldown_until IS NULL OR p.cooldown_until < NOW())
           AND ($1::text <> 'CASH' OR p.cash_jobs_enabled = TRUE)
           AND NOT EXISTS (
             SELECT 1 FROM provider_calendar_slots s
             WHERE s.provider_user_id = p.user_id
               AND s.status = 'LOCKED'
               AND s.slot_range && tstzrange($2::timestamptz - INTERVAL '15 minutes', $3::timestamptz + INTERVAL '15 minutes')
           )
         ORDER BY p.visibility_score DESC
         LIMIT 1`,
        [d.payment_method || 'ESEWA', d.requested_slot_start, d.requested_slot_end]
      );
      if (cand.rows[0]) {
        assignedProviderId = cand.rows[0].user_id;
        resolvedStatus = 'SCHEDULED_LOCKED';
        exactAddressUnlocked = true;
        await client.query(
          `INSERT INTO provider_calendar_slots (provider_user_id, booking_id, slot_range, status)
           VALUES ($1, $2, tstzrange($3::timestamptz - INTERVAL '15 minutes', $4::timestamptz + INTERVAL '15 minutes'), 'LOCKED')`,
          [assignedProviderId, bk.id, d.requested_slot_start, d.requested_slot_end]
        );
        await client.query(
          `UPDATE bookings
           SET assigned_provider_id = $1, status = 'SCHEDULED_LOCKED',
               exact_address_unlocked = TRUE, accepted_at = NOW()
           WHERE id = $2`,
          [assignedProviderId, bk.id]
        );
      } else {
        resolvedStatus = 'OPS_ESCALATED';
        await client.query(`UPDATE bookings SET status = 'OPS_ESCALATED' WHERE id = $1`, [bk.id]);
      }
    }

    await client.query(
      `INSERT INTO booking_status_events (booking_id, to_status, actor_user_id, metadata)
       VALUES ($1, $2::booking_status, $3, $4::jsonb)`,
      [bk.id, resolvedStatus, req.user!.id, JSON.stringify({ booking_mode: d.booking_mode })]
    );

    const fresh = await client.query(`SELECT * FROM bookings WHERE id = $1`, [bk.id]);
    return { ...fresh.rows[0], exact_address_unlocked: exactAddressUnlocked };
  });

  realtimeHub.broadcast({
    type: 'BOOKING_UPDATED',
    bookingId: booking.id,
    payload: { booking_code: booking.booking_code, status: booking.status, booking_mode: booking.booking_mode },
  });

  res.status(201).json(booking);
});

// 3. List Bookings (strictly enforces L4 Homeowner Location Privacy during LIVE_BIDDING!)
catalogAndBookingsRouter.get('/bookings', requireAuth, async (req, res) => {
  const scope = String(req.query.scope || 'mine'); // 'mine' | 'open_bids' | 'provider_assigned' | 'admin_all'
  const isAdmin = req.user!.roles.some((r) =>
    ['OPS_DISPATCHER', 'FINANCE_ADMIN', 'GRIEVANCE_OFFICER', 'SUPER_ADMIN'].includes(r)
  );

  let where = `b.customer_id = $1`;
  const params: unknown[] = [req.user!.id];

  if (scope === 'open_bids') {
    where = `b.status = 'LIVE_BIDDING' AND (b.bidding_closes_at IS NULL OR b.bidding_closes_at > NOW())`;
    params.length = 0;
  } else if (scope === 'provider_assigned') {
    where = `b.assigned_provider_id = $1`;
  } else if (scope === 'admin_all' && isAdmin) {
    where = `TRUE`;
    params.length = 0;
  }

  const { rows } = await pool.query(
    `SELECT b.*,
            c.name_en AS category_name, s.title_en AS sku_title, z.code AS zone_code,
            cu.full_name AS customer_name,
            pu.full_name AS provider_name, pp.rolling_avg_rating AS provider_rating, pp.tier_code AS provider_tier,
            a.city, a.ward_no, a.tole_neighborhood,
            a.exact_address_line,
            ST_Y(a.exact_location::geometry) AS exact_lat,
            ST_X(a.exact_location::geometry) AS exact_lng,
            ST_Y(a.masked_location::geometry) AS masked_lat,
            ST_X(a.masked_location::geometry) AS masked_lng,
            e.status AS escrow_status, e.total_held_npr AS escrow_held_npr,
            (SELECT COUNT(*)::int FROM bids bd WHERE bd.booking_id = b.id AND bd.status = 'ACTIVE') AS active_bids_count
     FROM bookings b
     JOIN categories c ON c.id = b.category_id
     LEFT JOIN service_skus s ON s.id = b.sku_id
     JOIN service_zones z ON z.id = b.zone_id
     JOIN users cu ON cu.id = b.customer_id
     LEFT JOIN users pu ON pu.id = b.assigned_provider_id
     LEFT JOIN provider_profiles pp ON pp.user_id = b.assigned_provider_id
     JOIN user_addresses a ON a.id = b.address_id
     LEFT JOIN escrow_accounts e ON e.booking_id = b.id
     WHERE ${where}
     ORDER BY b.created_at DESC
     LIMIT 60`,
    params
  );

  // L4 Privacy Enforcement: Mask exact address & coordinates unless caller is owner, admin, or winning assigned provider
  const sanitized = rows.map((row) => {
    const canSeeExact =
      isAdmin ||
      row.customer_id === req.user!.id ||
      (row.exact_address_unlocked && row.assigned_provider_id === req.user!.id);

    if (!canSeeExact) {
      return {
        ...row,
        exact_address_line: null,
        exact_lat: null,
        exact_lng: null,
        address_privacy_masked: true,
      };
    }
    return { ...row, address_privacy_masked: false };
  });

  res.json({ bookings: sanitized });
});

// 4. Live Competitive Bidding (Submit / Edit / List / Accept)
catalogAndBookingsRouter.get('/bookings/:bookingId/bids', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT bd.*, u.full_name AS provider_name, p.tier_code, p.rolling_avg_rating,
            p.lifetime_completed_jobs, p.visibility_score, p.kyc_status,
            (p.new_provider_grace_until IS NOT NULL AND p.new_provider_grace_until > NOW()) AS is_new_verified
     FROM bids bd
     JOIN users u ON u.id = bd.provider_user_id
     JOIN provider_profiles p ON p.user_id = bd.provider_user_id
     WHERE bd.booking_id = $1
     ORDER BY p.visibility_score DESC, bd.quoted_labor_npr ASC`,
    [req.params.bookingId]
  );
  res.json({ bids: rows });
});

catalogAndBookingsRouter.post('/bookings/:bookingId/bids', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      quoted_labor_npr: z.number().min(100).max(500000),
      estimated_arrival_min: z.number().int().min(5).max(480),
      estimated_duration_min: z.number().int().min(15).max(600),
      parts_included: z.boolean().default(false),
      notes: z.string().max(500).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const bid = await withTransaction(async (client) => {
    // L1: Verify provider KYC + financial linking + not in cooldown
    const pRes = await client.query(
      `SELECT kyc_status, financial_account_verified, cooldown_until, cash_jobs_enabled
       FROM provider_profiles WHERE user_id = $1`,
      [req.user!.id]
    );
    const prov = pRes.rows[0];
    if (!prov || prov.kyc_status !== 'VERIFIED_ACTIVE' || !prov.financial_account_verified) {
      throw Object.assign(
        new Error('Only biometrically verified providers with linked bank/eSewa accounts can bid'),
        { statusCode: 403 }
      );
    }
    if (prov.cooldown_until && new Date(prov.cooldown_until) > new Date()) {
      throw Object.assign(new Error('Provider is currently under a cancellation cooldown'), {
        statusCode: 403,
      });
    }

    const bRes = await client.query(
      `SELECT b.*, s.min_bid_sanity_npr, s.max_bid_sanity_npr
       FROM bookings b LEFT JOIN service_skus s ON s.id = b.sku_id
       WHERE b.id = $1`,
      [req.params.bookingId]
    );
    const bk = bRes.rows[0];
    if (!bk || bk.status !== 'LIVE_BIDDING') {
      throw Object.assign(new Error('Booking is not open for live bidding'), { statusCode: 409 });
    }
    if (bk.bidding_closes_at && new Date(bk.bidding_closes_at) < new Date()) {
      throw Object.assign(new Error('Bidding window has expired'), { statusCode: 409 });
    }
    // L5: Enforce cash-job float eligibility on cash bookings
    if (bk.payment_method === 'CASH' && !prov.cash_jobs_enabled) {
      throw Object.assign(
        new Error('Cash-job bidding paused: Commission Float is below -NPR 300. Please top up.'),
        { statusCode: 403 }
      );
    }

    // L2: Prevent overlapping calendar bids (including 15-min travel buffer)
    const conflict = await client.query(
      `SELECT id FROM provider_calendar_slots
       WHERE provider_user_id = $1 AND status = 'LOCKED'
         AND slot_range && tstzrange($2::timestamptz - INTERVAL '15 minutes', $3::timestamptz + INTERVAL '15 minutes')`,
      [req.user!.id, bk.requested_slot_start, bk.requested_slot_end]
    );
    if (conflict.rowCount && conflict.rowCount > 0) {
      throw Object.assign(
        new Error('Calendar conflict: you already have a locked booking overlapping this time window'),
        { statusCode: 409 }
      );
    }

    // Sanity check alert flag
    const minS = bk.min_bid_sanity_npr ? Number(bk.min_bid_sanity_npr) : 200;
    const maxS = bk.max_bid_sanity_npr ? Number(bk.max_bid_sanity_npr) : 50000;
    const sanityAlert = parsed.data.quoted_labor_npr < minS || parsed.data.quoted_labor_npr > maxS;

    // L3: Upsert with strict edit_count <= 1 cap
    const existingBid = await client.query(
      `SELECT id, edit_count FROM bids WHERE booking_id = $1 AND provider_user_id = $2`,
      [bk.id, req.user!.id]
    );
    if (existingBid.rows[0]) {
      if (Number(existingBid.rows[0].edit_count) >= 1) {
        throw Object.assign(
          new Error('Bid edit limit reached (max 1 edit allowed to prevent bait-and-switch)'),
          { statusCode: 409 }
        );
      }
      const upd = await client.query(
        `UPDATE bids
         SET quoted_labor_npr = $1, estimated_arrival_min = $2, estimated_duration_min = $3,
             parts_included = $4, notes = $5, edit_count = edit_count + 1,
             sanity_alert_triggered = $6, updated_at = NOW()
         WHERE id = $7 RETURNING *`,
        [
          parsed.data.quoted_labor_npr,
          parsed.data.estimated_arrival_min,
          parsed.data.estimated_duration_min,
          parsed.data.parts_included,
          parsed.data.notes || null,
          sanityAlert,
          existingBid.rows[0].id,
        ]
      );
      return upd.rows[0];
    }

    const ins = await client.query(
      `INSERT INTO bids (booking_id, provider_user_id, quoted_labor_npr, estimated_arrival_min, estimated_duration_min, parts_included, notes, sanity_alert_triggered)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        bk.id,
        req.user!.id,
        parsed.data.quoted_labor_npr,
        parsed.data.estimated_arrival_min,
        parsed.data.estimated_duration_min,
        parsed.data.parts_included,
        parsed.data.notes || null,
        sanityAlert,
      ]
    );
    return ins.rows[0];
  });

  realtimeHub.broadcast({
    type: 'BID_CREATED',
    bookingId: String(req.params.bookingId),
    payload: bid,
  });

  res.status(201).json(bid);
});

// Accept Winning Bid -> Atomic Calendar GiST Lock + Exact Address Unlock + Escrow Init
catalogAndBookingsRouter.post(
  '/bookings/:bookingId/bids/:bidId/accept',
  requireAuth,
  async (req, res) => {
    const result = await withTransaction(async (client) => {
      const bRes = await client.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [
        req.params.bookingId,
      ]);
      const bk = bRes.rows[0];
      if (!bk || bk.customer_id !== req.user!.id) {
        throw Object.assign(new Error('Booking not found or unauthorized'), { statusCode: 404 });
      }
      if (bk.status !== 'LIVE_BIDDING') {
        throw Object.assign(new Error('Booking is no longer in LIVE_BIDDING state'), { statusCode: 409 });
      }

      const bidRes = await client.query(
        `SELECT * FROM bids WHERE id = $1 AND booking_id = $2 AND status = 'ACTIVE'`,
        [req.params.bidId, bk.id]
      );
      const winningBid = bidRes.rows[0];
      if (!winningBid) {
        throw Object.assign(new Error('Active bid not found'), { statusCode: 404 });
      }

      // L2: Database-level PostgreSQL GiST exclusion constraint guarantees zero overlap
      try {
        await client.query(
          `INSERT INTO provider_calendar_slots (provider_user_id, booking_id, slot_range, status)
           VALUES ($1, $2, tstzrange($3::timestamptz - INTERVAL '15 minutes', $4::timestamptz + INTERVAL '15 minutes'), 'LOCKED')`,
          [winningBid.provider_user_id, bk.id, bk.requested_slot_start, bk.requested_slot_end]
        );
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23P01') {
          throw Object.assign(
            new Error('Provider slot became unavailable (calendar exclusion constraint triggered)'),
            { statusCode: 409 }
          );
        }
        throw err;
      }

      await client.query(`UPDATE bids SET status = 'ACCEPTED', updated_at = NOW() WHERE id = $1`, [
        winningBid.id,
      ]);
      await client.query(
        `UPDATE bids SET status = 'REJECTED', updated_at = NOW() WHERE booking_id = $1 AND id <> $2`,
        [bk.id, winningBid.id]
      );

      const quotedLabor = Number(winningBid.quoted_labor_npr);
      const totalNpr = Math.max(0, quotedLabor + Number(bk.visiting_fee_npr) - Number(bk.discount_npr));
      // Completion OTP (demo '4829') for escrow release confirmation
      const otpHash = crypto.createHash('sha256').update('4829').digest('hex');

      const updated = await client.query(
        `UPDATE bookings
         SET assigned_provider_id = $1,
             status = 'SCHEDULED_LOCKED',
             exact_address_unlocked = TRUE,
             quoted_labor_npr = $2,
             estimated_duration_min = $3,
             final_total_npr = $4,
             completion_otp_hash = $5,
             accepted_at = NOW(),
             updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [
          winningBid.provider_user_id,
          quotedLabor,
          winningBid.estimated_duration_min,
          totalNpr,
          otpHash,
          bk.id,
        ]
      );

      // Automatically prepare Escrow account for high-value jobs (> NPR 5000) or ESCROW_WALLET mode
      if (totalNpr >= 5000 || bk.payment_method === 'ESCROW_WALLET') {
        await client.query(
          `INSERT INTO escrow_accounts (booking_id, total_held_npr, status)
           VALUES ($1, 0, 'PENDING_FUNDING')
           ON CONFLICT (booking_id) DO NOTHING`,
          [bk.id]
        );
      }

      await client.query(
        `INSERT INTO booking_status_events (booking_id, from_status, to_status, actor_user_id, metadata)
         VALUES ($1, 'LIVE_BIDDING', 'SCHEDULED_LOCKED', $2, $3::jsonb)`,
        [bk.id, req.user!.id, JSON.stringify({ winning_bid_id: winningBid.id, quoted_labor_npr: quotedLabor })]
      );

      return updated.rows[0];
    });

    realtimeHub.broadcast({
      type: 'BID_ACCEPTED',
      bookingId: result.id,
      payload: { assigned_provider_id: result.assigned_provider_id, status: result.status },
    });

    res.json({ ...result, demo_completion_otp: process.env.NODE_ENV === 'production' ? undefined : '4829' });
  }
);

// 5. Provider Automated Calendar & Availability Toggle (Enforces L12 Random Selfie 428 Gate!)
catalogAndBookingsRouter.get('/providers/me/calendar', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.booking_id, lower(s.slot_range) AS start_at, upper(s.slot_range) AS end_at,
            s.status, b.booking_code, b.status AS booking_status, a.tole_neighborhood
     FROM provider_calendar_slots s
     JOIN bookings b ON b.id = s.booking_id
     JOIN user_addresses a ON a.id = b.address_id
     WHERE s.provider_user_id = $1
     ORDER BY lower(s.slot_range) ASC`,
    [req.user!.id]
  );
  res.json({ slots: rows });
});

catalogAndBookingsRouter.patch('/providers/me/availability', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      availability_state: z.enum(['AVAILABLE', 'OFFLINE']),
      lat: z.number().optional(),
      lng: z.number().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const pRes = await pool.query(
    `SELECT kyc_status, financial_account_verified FROM provider_profiles WHERE user_id = $1`,
    [req.user!.id]
  );
  if (!pRes.rows[0] || pRes.rows[0].kyc_status !== 'VERIFIED_ACTIVE' || !pRes.rows[0].financial_account_verified) {
    res.status(403).json({ error: 'Biometric KYC and financial account linking must be verified before going AVAILABLE' });
    return;
  }

  // L12: Random Selfie Re-Check Gate -> HTTP 428 Precondition Required
  if (parsed.data.availability_state === 'AVAILABLE') {
    const pendingCheck = await pool.query(
      `SELECT id, trigger_reason FROM random_selfie_checks WHERE provider_user_id = $1 AND completed_at IS NULL LIMIT 1`,
      [req.user!.id]
    );
    if (pendingCheck.rows[0]) {
      res.status(428).json({
        error: 'Random biometric selfie liveness re-check required before going AVAILABLE',
        check_id: pendingCheck.rows[0].id,
        trigger_reason: pendingCheck.rows[0].trigger_reason,
      });
      return;
    }
  }

  const upd = await pool.query(
    `UPDATE provider_profiles
     SET availability_state = $1::provider_availability_state,
         last_known_location = CASE WHEN $2::double precision IS NOT NULL AND $3::double precision IS NOT NULL
           THEN ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography ELSE last_known_location END,
         last_location_at = NOW(),
         updated_at = NOW()
     WHERE user_id = $4
     RETURNING user_id, availability_state`,
    [parsed.data.availability_state, parsed.data.lat ?? null, parsed.data.lng ?? null, req.user!.id]
  );
  res.json(upd.rows[0]);
});

// 6. Job Execution State Machine + Live GPS + Offline Sync + L8 GPS Proximity-Cancel Anti-Leakage!
catalogAndBookingsRouter.post('/bookings/:bookingId/status', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      to_status: z.enum(['EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED_PENDING_CONFIRM', 'CANCELLED']),
      lat: z.number().optional(),
      lng: z.number().optional(),
      offline_recorded_at: z.string().datetime().optional(),
      photo_blob_paths: z.array(z.string()).optional(),
      cancellation_reason: z.string().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;

  const outcome = await withTransaction(async (client) => {
    const bRes = await client.query(
      `SELECT b.*, a.exact_location
       FROM bookings b JOIN user_addresses a ON a.id = b.address_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [req.params.bookingId]
    );
    const bk = bRes.rows[0];
    if (!bk) throw Object.assign(new Error('Booking not found'), { statusCode: 404 });

    const isCustomer = bk.customer_id === req.user!.id;
    const isProvider = bk.assigned_provider_id === req.user!.id;
    const isAdmin = req.user!.roles.some((r) => ['OPS_DISPATCHER', 'SUPER_ADMIN'].includes(r));
    if (!isCustomer && !isProvider && !isAdmin) {
      throw Object.assign(new Error('Not authorized to update this booking'), { statusCode: 403 });
    }

    let antiLeakageFlagged = false;
    let distanceMeters: number | null = null;

    // Update provider live GPS if supplied
    if (isProvider && d.lat !== undefined && d.lng !== undefined) {
      await client.query(
        `UPDATE provider_profiles
         SET last_known_location = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, last_location_at = NOW()
         WHERE user_id = $3`,
        [d.lat, d.lng, req.user!.id]
      );
      const distRes = await client.query(
        `SELECT ST_Distance(
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           (SELECT exact_location FROM user_addresses WHERE id = $3)
         ) AS meters`,
        [d.lat, d.lng, bk.address_id]
      );
      distanceMeters = Number(distRes.rows[0]?.meters ?? 99999);
    }

    // L8: GPS Proximity Cancellation Anti-Leakage Check (Provider cancels within <= 300m of customer pin!)
    if (d.to_status === 'CANCELLED' && isProvider) {
      if (distanceMeters === null) {
        const prevDist = await client.query(
          `SELECT ST_Distance(p.last_known_location, a.exact_location) AS meters
           FROM provider_profiles p, user_addresses a
           WHERE p.user_id = $1 AND a.id = $2`,
          [req.user!.id, bk.address_id]
        );
        distanceMeters = prevDist.rows[0]?.meters !== null ? Number(prevDist.rows[0].meters) : null;
      }

      if (distanceMeters !== null && distanceMeters <= 300) {
        antiLeakageFlagged = true;
        await client.query(
          `INSERT INTO anti_leakage_flags (provider_user_id, booking_id, flag_type, min_distance_to_customer_m, evidence_summary)
           VALUES ($1, $2, 'GPS_PROXIMITY_CANCEL', $3, $4::jsonb)`,
          [
            req.user!.id,
            bk.id,
            distanceMeters.toFixed(2),
            JSON.stringify({
              from_status: bk.status,
              reason: d.cancellation_reason || 'None provided',
              detected_rule: 'SOP-07: Provider cancelled accepted job within 300m of homeowner GPS',
            }),
          ]
        );
      }

      // Release locked calendar slot & increment cancellation rate
      await client.query(
        `UPDATE provider_calendar_slots SET status = 'RELEASED' WHERE booking_id = $1`,
        [bk.id]
      );
      await client.query(
        `UPDATE provider_profiles
         SET rolling_cancellation_rate = LEAST(1.0, rolling_cancellation_rate + 0.05),
             availability_state = 'AVAILABLE'
         WHERE user_id = $1`,
        [req.user!.id]
      );
    } else if (d.to_status === 'CANCELLED') {
      await client.query(
        `UPDATE provider_calendar_slots SET status = 'RELEASED' WHERE booking_id = $1`,
        [bk.id]
      );
    }

    const upd = await client.query(
      `UPDATE bookings
       SET status = $1::booking_status,
           en_route_at = CASE WHEN $1 = 'EN_ROUTE' THEN NOW() ELSE en_route_at END,
           arrived_at = CASE WHEN $1 = 'ARRIVED' THEN NOW() ELSE arrived_at END,
           started_at = CASE WHEN $1 = 'IN_PROGRESS' THEN NOW() ELSE started_at END,
           completed_at = CASE WHEN $1 = 'COMPLETED_PENDING_CONFIRM' THEN NOW() ELSE completed_at END,
           cancelled_at = CASE WHEN $1 = 'CANCELLED' THEN NOW() ELSE cancelled_at END,
           cancelled_by = CASE WHEN $1 = 'CANCELLED' THEN $3::uuid ELSE cancelled_by END,
           cancellation_reason = CASE WHEN $1 = 'CANCELLED' THEN $4 ELSE cancellation_reason END,
           before_photo_paths = CASE WHEN $1 = 'IN_PROGRESS' AND $5::text[] IS NOT NULL THEN $5 ELSE before_photo_paths END,
           after_photo_paths = CASE WHEN $1 = 'COMPLETED_PENDING_CONFIRM' AND $5::text[] IS NOT NULL THEN $5 ELSE after_photo_paths END,
           warranty_expires_at = CASE WHEN $1 = 'COMPLETED_PENDING_CONFIRM' THEN NOW() + (warranty_days || ' days')::interval ELSE warranty_expires_at END,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [d.to_status, bk.id, req.user!.id, d.cancellation_reason || null, d.photo_blob_paths || null]
    );

    if (d.to_status === 'COMPLETED_PENDING_CONFIRM') {
      await client.query(`UPDATE provider_calendar_slots SET status = 'COMPLETED' WHERE booking_id = $1`, [bk.id]);
      await client.query(
        `UPDATE escrow_accounts SET auto_release_at = NOW() + INTERVAL '48 hours' WHERE booking_id = $1 AND status = 'HELD'`,
        [bk.id]
      );
      if (bk.assigned_provider_id) {
        await client.query(
          `UPDATE provider_profiles SET availability_state = 'AVAILABLE', updated_at = NOW() WHERE user_id = $1`,
          [bk.assigned_provider_id]
        );
      }
    }
    if (isProvider && (d.to_status === 'EN_ROUTE' || d.to_status === 'IN_PROGRESS')) {
      const pState = d.to_status === 'EN_ROUTE' ? 'EN_ROUTE' : 'ON_JOB';
      await client.query(`UPDATE provider_profiles SET availability_state = $1::provider_availability_state WHERE user_id = $2`, [pState, req.user!.id]);
    }

    await client.query(
      `INSERT INTO booking_status_events (booking_id, from_status, to_status, actor_user_id, actor_location, offline_recorded_at, metadata)
       VALUES ($1, $2::booking_status, $3::booking_status, $4,
         CASE WHEN $5::double precision IS NOT NULL AND $6::double precision IS NOT NULL
           THEN ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography ELSE NULL END,
         $7, $8::jsonb)`,
      [
        bk.id,
        bk.status,
        d.to_status,
        req.user!.id,
        d.lat ?? null,
        d.lng ?? null,
        d.offline_recorded_at || null,
        JSON.stringify({ distance_m: distanceMeters, anti_leakage_flagged: antiLeakageFlagged }),
      ]
    );

    return { booking: upd.rows[0], anti_leakage_flagged: antiLeakageFlagged, distance_meters: distanceMeters };
  });

  if (outcome.anti_leakage_flagged) {
    realtimeHub.broadcast({
      type: 'ANTI_LEAKAGE_FLAG',
      bookingId: String(req.params.bookingId),
      payload: { distance_meters: outcome.distance_meters, provider_id: req.user!.id },
    });
  }
  realtimeHub.broadcast({
    type: 'BOOKING_UPDATED',
    bookingId: String(req.params.bookingId),
    payload: { status: outcome.booking.status, lat: d.lat, lng: d.lng },
  });

  res.json(outcome);
});

// 7. On-Site Change Orders (MRP Spare Parts + Extra Labor) & Customer Approval
catalogAndBookingsRouter.get('/bookings/:bookingId/change-orders', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM change_orders WHERE booking_id = $1 ORDER BY created_at DESC`,
    [req.params.bookingId]
  );
  res.json({ change_orders: rows });
});

catalogAndBookingsRouter.post('/bookings/:bookingId/change-orders', requireAuth, async (req, res) => {
  const parsed = z
    .object({
      reason: z.string().min(3).max(400),
      additional_labor_npr: z.number().min(0).default(0),
      spare_parts_items: z
        .array(
          z.object({
            name: z.string().min(1),
            qty: z.number().int().min(1),
            mrp_unit_npr: z.number().min(0),
            receipt_blob_path: z.string().min(3),
          })
        )
        .default([]),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const totalParts = parsed.data.spare_parts_items.reduce(
    (sum, item) => sum + item.qty * item.mrp_unit_npr,
    0
  );

  const co = await withTransaction(async (client) => {
    const bRes = await client.query(`SELECT * FROM bookings WHERE id = $1`, [req.params.bookingId]);
    if (!bRes.rows[0] || bRes.rows[0].assigned_provider_id !== req.user!.id) {
      throw Object.assign(new Error('Only the assigned technician can propose a Change Order'), {
        statusCode: 403,
      });
    }
    const ins = await client.query(
      `INSERT INTO change_orders (booking_id, proposed_by, reason, additional_labor_npr, spare_parts_items, total_parts_mrp_npr)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
      [
        req.params.bookingId,
        req.user!.id,
        parsed.data.reason,
        parsed.data.additional_labor_npr,
        JSON.stringify(parsed.data.spare_parts_items),
        totalParts,
      ]
    );
    await client.query(`UPDATE bookings SET status = 'CHANGE_ORDER_PENDING' WHERE id = $1`, [
      req.params.bookingId,
    ]);
    return ins.rows[0];
  });

  realtimeHub.broadcast({ type: 'CHANGE_ORDER_PROPOSED', bookingId: String(req.params.bookingId), payload: co });
  res.status(201).json(co);
});

catalogAndBookingsRouter.post(
  '/bookings/:bookingId/change-orders/:changeOrderId/respond',
  requireAuth,
  async (req, res) => {
    const parsed = z.object({ decision: z.enum(['APPROVE', 'REJECT']) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const updated = await withTransaction(async (client) => {
      const bRes = await client.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [
        req.params.bookingId,
      ]);
      const bk = bRes.rows[0];
      if (!bk || bk.customer_id !== req.user!.id) {
        throw Object.assign(new Error('Only the homeowner can respond to Change Orders'), { statusCode: 403 });
      }
      const nextStatus = parsed.data.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const coRes = await client.query(
        `UPDATE change_orders
         SET status = $1::change_order_status, customer_responded_at = NOW()
         WHERE id = $2 AND booking_id = $3 AND status = 'PENDING_CUSTOMER_APPROVAL'
         RETURNING *`,
        [nextStatus, req.params.changeOrderId, bk.id]
      );
      if (!coRes.rows[0]) {
        throw Object.assign(new Error('Pending Change Order not found'), { statusCode: 404 });
      }
      const co = coRes.rows[0];
      if (nextStatus === 'APPROVED') {
        const newCoLabor = Number(bk.approved_change_order_labor_npr) + Number(co.additional_labor_npr);
        const newParts = Number(bk.approved_parts_mrp_npr) + Number(co.total_parts_mrp_npr);
        const newTotal = Math.max(
          0,
          Number(bk.quoted_labor_npr) + newCoLabor + newParts + Number(bk.visiting_fee_npr) - Number(bk.discount_npr)
        );
        await client.query(
          `UPDATE bookings
           SET approved_change_order_labor_npr = $1, approved_parts_mrp_npr = $2,
               final_total_npr = $3, status = 'IN_PROGRESS', updated_at = NOW()
           WHERE id = $4`,
          [newCoLabor, newParts, newTotal, bk.id]
        );
      } else {
        await client.query(`UPDATE bookings SET status = 'IN_PROGRESS', updated_at = NOW() WHERE id = $1`, [bk.id]);
      }
      return co;
    });

    realtimeHub.broadcast({
      type: 'CHANGE_ORDER_RESPONDED',
      bookingId: String(req.params.bookingId),
      payload: updated,
    });
    res.json(updated);
  }
);

// 8. Masked Call Bridge (ACS Proxy) & Auditable In-App Chat
catalogAndBookingsRouter.post('/bookings/:bookingId/masked-call', requireAuth, async (req, res) => {
  res.status(201).json({
    bridge_id: `acs-masked-${crypto.randomUUID().slice(0, 8)}`,
    proxy_number: '+977-1-5970282',
    caller_number_hidden: true,
    callee_number_hidden: true,
    expires_in_sec: 1800,
  });
});

catalogAndBookingsRouter.get('/bookings/:bookingId/chat', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.*, u.full_name AS sender_name
     FROM booking_chat_messages m JOIN users u ON u.id = m.sender_user_id
     WHERE m.booking_id = $1 ORDER BY m.created_at ASC`,
    [req.params.bookingId]
  );
  res.json({ messages: rows });
});

catalogAndBookingsRouter.post('/bookings/:bookingId/chat', requireAuth, async (req, res) => {
  const parsed = z
    .object({ message_text: z.string().min(1).max(1000), media_blob_path: z.string().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO booking_chat_messages (booking_id, sender_user_id, message_text, media_blob_path)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.params.bookingId, req.user!.id, parsed.data.message_text, parsed.data.media_blob_path || null]
  );
  realtimeHub.broadcast({
    type: 'CHAT_MESSAGE',
    bookingId: String(req.params.bookingId),
    payload: { ...rows[0], sender_name: req.user!.full_name },
  });
  res.status(201).json(rows[0]);
});
