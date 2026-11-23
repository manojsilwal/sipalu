import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://sipaluadmin:sipalu_local_dev_password@localhost:5432/sipalu',
});

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  isolationLevel: 'READ COMMITTED' | 'SERIALIZABLE' = 'READ COMMITTED'
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function ensureDemoFixtures(): Promise<void> {
  await withTransaction(async (client) => {
    // Promo code SIPALU50 (10% off up to Rs 300)
    await client.query(`
      INSERT INTO promo_codes (code, discount_type, discount_value, max_discount_npr, min_order_npr, usage_limit_total, usage_limit_per_user, valid_from, valid_until)
      VALUES ('SIPALU50', 'PERCENT', 10, 300, 300, 10000, 5, NOW() - INTERVAL '1 day', NOW() + INTERVAL '365 days')
      ON CONFLICT (code) DO NOTHING
    `);

    // Seed Pilot Accounts (Admin, Customer in Banepa, Verified Provider in Banepa, Unverified Provider, B2B Manager)
    const fixtures = [
      {
        phone: '+9779800000001',
        email: 'admin@sipalu.com',
        name: 'Maya Shrestha (Ops Admin)',
        roles: ['OPS_DISPATCHER', 'KYC_REVIEWER', 'FINANCE_ADMIN', 'GRIEVANCE_OFFICER', 'SUPER_ADMIN'],
      },
      {
        phone: '+9779800000002',
        email: 'aarav@example.com',
        name: 'Aarav Thapa',
        roles: ['CUSTOMER'],
      },
      {
        phone: '+9779800000003',
        email: 'bikram.plumber@example.com',
        name: 'Bikram Tamang (Verified Plumber)',
        roles: ['PROVIDER'],
      },
      {
        phone: '+9779800000004',
        email: 'sita.facility@example.com',
        name: 'Sita Gurung (Facility Manager)',
        roles: ['CUSTOMER', 'BUSINESS_ADMIN'],
      },
      {
        phone: '+9779800000005',
        email: 'newtech@example.com',
        name: 'Raju Karki (New Applicant)',
        roles: ['PROVIDER'],
      },
    ];

    for (const f of fixtures) {
      await client.query(
        `INSERT INTO users (phone_e164, email, full_name, roles)
         VALUES ($1, $2, $3, $4::user_role[])
         ON CONFLICT (phone_e164) DO NOTHING`,
        [f.phone, f.email, f.name, f.roles]
      );
    }

    // Seed Customer Banepa Address (exact + ~500m masked centroid)
    const custRes = await client.query(`SELECT id FROM users WHERE phone_e164 = '+9779800000002'`);
    if (custRes.rows[0]) {
      const custId = custRes.rows[0].id;
      const addrCheck = await client.query(`SELECT id FROM user_addresses WHERE user_id = $1`, [custId]);
      if (addrCheck.rowCount === 0) {
        await client.query(
          `INSERT INTO user_addresses (user_id, label, city, ward_no, tole_neighborhood, exact_address_line, exact_location, masked_location, is_default)
           VALUES (
             $1, 'Home (Banepa)', 'Banepa', 7, 'Tindobato Chowk Area',
             'House #42, Araniko Marg, Behind Banepa Bus Park, Ward 7',
             ST_SetSRID(ST_MakePoint(85.5214, 27.6298), 4326)::geography,
             ST_SetSRID(ST_MakePoint(85.5250, 27.6325), 4326)::geography,
             TRUE
           )`,
          [custId]
        );
      }
    }

    // Seed Verified Provider (Bikram) with Financial Linking + Float Wallet + Ledger Accounts
    const provRes = await client.query(`SELECT id FROM users WHERE phone_e164 = '+9779800000003'`);
    if (provRes.rows[0]) {
      const provId = provRes.rows[0].id;
      await client.query(
        `INSERT INTO provider_profiles (
           user_id, tier_code, kyc_status, availability_state, primary_city, service_radius_km,
           home_base_location, last_known_location, last_location_at, years_experience, specialties,
           linked_bank_name, linked_bank_account_no, linked_esewa_id, financial_account_verified,
           lifetime_completed_jobs, rolling_avg_rating, visibility_score, cash_jobs_enabled, pan_number
         )
         VALUES (
           $1, 'VERIFIED', 'VERIFIED_ACTIVE', 'AVAILABLE', 'BANEPA', 12.0,
           ST_SetSRID(ST_MakePoint(85.5200, 27.6310), 4326)::geography,
           ST_SetSRID(ST_MakePoint(85.5200, 27.6310), 4326)::geography,
           NOW(), 6, ARRAY['plumbing','water_pump','geyser_solar'],
           'Nabil Bank', '01201017500991', '9800000003', TRUE,
           42, 4.80, 88.50, TRUE, '609112233'
         )
         ON CONFLICT (user_id) DO NOTHING`,
        [provId]
      );

      // Ensure Provider Ledger & Float Wallet
      const floatCode = `PROV_FLOAT:${provId}`;
      const payCode = `PROV_PAYABLE:${provId}`;
      const floatAcct = await client.query(
        `INSERT INTO ledger_accounts (code, account_type, owner_user_id, balance_npr)
         VALUES ($1, 'LIABILITY', $2, 600.00)
         ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
         RETURNING id`,
        [floatCode, provId]
      );
      await client.query(
        `INSERT INTO ledger_accounts (code, account_type, owner_user_id, balance_npr)
         VALUES ($1, 'LIABILITY', $2, 2400.00)
         ON CONFLICT (code) DO NOTHING`,
        [payCode, provId]
      );
      await client.query(
        `INSERT INTO provider_float_wallets (provider_user_id, ledger_account_id, current_float_npr, is_cash_paused)
         VALUES ($1, $2, 600.00, FALSE)
         ON CONFLICT (provider_user_id) DO NOTHING`,
        [provId, floatAcct.rows[0].id]
      );
    }

    // Seed Unverified Provider (Raju) for KYC Queue & Loophole L1 testing
    const unvRes = await client.query(`SELECT id FROM users WHERE phone_e164 = '+9779800000005'`);
    if (unvRes.rows[0]) {
      const unvId = unvRes.rows[0].id;
      await client.query(
        `INSERT INTO provider_profiles (
           user_id, tier_code, kyc_status, availability_state, primary_city, service_radius_km,
           years_experience, specialties, financial_account_verified, cash_jobs_enabled
         )
         VALUES ($1, 'TRAINEE', 'PENDING_SUBMISSION', 'OFFLINE', 'BANEPA', 8.0, 2, ARRAY['plumbing'], FALSE, FALSE)
         ON CONFLICT (user_id) DO NOTHING`,
        [unvId]
      );
    }
  });
}
