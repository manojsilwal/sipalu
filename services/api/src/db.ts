import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { hashPassword } from './auth.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://sipaluadmin:sipalu_local_dev_password@localhost:5432/sipalu',
  ssl:
    process.env.PGSSLMODE === 'require' || process.env.DATABASE_URL?.includes('azure.com')
      ? { rejectUnauthorized: false }
      : undefined,
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

/**
 * Idempotently applies SQL migrations & pilot seed on first boot (for zero-touch Azure Student deploy).
 */
export async function runAutoMigrations(): Promise<void> {
  const migrationsDir = process.env.MIGRATIONS_DIR || path.resolve(process.cwd(), '../../db/migrations');
  const seedsDir = process.env.SEEDS_DIR || path.resolve(process.cwd(), '../../db/seeds');
  if (!fs.existsSync(migrationsDir)) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      filename VARCHAR(180) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const check = await pool.query(`SELECT 1 FROM _schema_migrations WHERE filename = $1`, [file]);
    if (check.rowCount && check.rowCount > 0) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      await pool.query(sql);
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      // Ignore already-exists codes (42710 type exists, 42P07 relation exists) if migrating existing DB
      if (pgErr.code !== '42710' && pgErr.code !== '42P07') {
        throw err;
      }
    }
    await pool.query(`INSERT INTO _schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
    console.log(`[AUTO-MIGRATE] Applied ${file}`);
  }

  if (fs.existsSync(seedsDir)) {
    const seedFiles = fs
      .readdirSync(seedsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of seedFiles) {
      const sql = fs.readFileSync(path.join(seedsDir, file), 'utf-8');
      await pool.query(sql);
    }
  }
}

export async function ensureDemoFixtures(): Promise<void> {
  const defaultPassHash = hashPassword(process.env.DEMO_USER_PASSWORD || 'Sipalu@2026');

  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO promo_codes (code, discount_type, discount_value, max_discount_npr, min_order_npr, usage_limit_total, usage_limit_per_user, valid_from, valid_until)
      VALUES ('SIPALU50', 'PERCENT', 10, 300, 300, 10000, 5, NOW() - INTERVAL '1 day', NOW() + INTERVAL '365 days')
      ON CONFLICT (code) DO NOTHING
    `);

    const fixtures = [
      {
        username: 'manoj',
        phone: '+9779800000010',
        email: 'manoj@sipalu.com',
        name: 'Manoj Silwal (Sipalu Founder)',
        roles: ['CUSTOMER', 'OPS_DISPATCHER', 'KYC_REVIEWER', 'FINANCE_ADMIN', 'GRIEVANCE_OFFICER', 'SUPER_ADMIN'],
      },
      {
        username: 'sipalu_customer',
        phone: '+9779800000011',
        email: 'customer@sipalu.com',
        name: 'Manoj Silwal (Sipalu Customer)',
        roles: ['CUSTOMER'],
      },
      {
        username: 'sipalu_expert',
        phone: '+9779800000012',
        email: 'expert@sipalu.com',
        name: 'Sipalu Expert (Manoj)',
        roles: ['PROVIDER'],
      },
      {
        username: 'admin',
        phone: '+9779800000001',
        email: 'admin@sipalu.com',
        name: 'Maya Shrestha (Ops Admin)',
        roles: ['OPS_DISPATCHER', 'KYC_REVIEWER', 'FINANCE_ADMIN', 'GRIEVANCE_OFFICER', 'SUPER_ADMIN'],
      },
      {
        username: 'aarav',
        phone: '+9779800000002',
        email: 'aarav@example.com',
        name: 'Aarav Thapa',
        roles: ['CUSTOMER'],
      },
      {
        username: 'bikram',
        phone: '+9779800000003',
        email: 'bikram.plumber@example.com',
        name: 'Bikram Tamang (Verified Plumber)',
        roles: ['PROVIDER'],
      },
      {
        username: 'sita',
        phone: '+9779800000004',
        email: 'sita.facility@example.com',
        name: 'Sita Gurung (Facility Manager)',
        roles: ['CUSTOMER', 'BUSINESS_ADMIN'],
      },
      {
        username: 'raju',
        phone: '+9779800000005',
        email: 'newtech@example.com',
        name: 'Raju Karki (New Applicant)',
        roles: ['PROVIDER'],
      },
    ];

    for (const f of fixtures) {
      await client.query(
        `INSERT INTO users (username, password_hash, phone_e164, email, full_name, roles)
         VALUES ($1, $2, $3, $4, $5, $6::user_role[])
         ON CONFLICT (phone_e164) DO UPDATE
           SET username = COALESCE(users.username, EXCLUDED.username),
               password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash)`,
        [f.username, defaultPassHash, f.phone, f.email, f.name, f.roles]
      );
    }

    // Seed Banepa/KTM addresses for customer test accounts (aarav, manoj, sipalu_customer)
    for (const phone of ['+9779800000002', '+9779800000010', '+9779800000011']) {
      const custRes = await client.query(`SELECT id FROM users WHERE phone_e164 = $1`, [phone]);
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
    }

    // Seed Verified Provider accounts (bikram & sipalu_expert) with Financial Linking + Float Wallet
    for (const provSpec of [
      { phone: '+9779800000003', esewa: '9806800001', khalti: '9800000000', bankAcct: '01201017500991', floatAmt: 600.0, payAmt: 2400.0, visScore: 88.5 },
      { phone: '+9779800000012', esewa: '9806800001', khalti: '9800000000', bankAcct: '01201017500999', floatAmt: 1000.0, payAmt: 3500.0, visScore: 86.0 },
    ]) {
      const provRes = await client.query(`SELECT id FROM users WHERE phone_e164 = $1`, [provSpec.phone]);
      if (provRes.rows[0]) {
        const provId = provRes.rows[0].id;
        await client.query(
          `INSERT INTO provider_profiles (
             user_id, tier_code, kyc_status, availability_state, primary_city, service_radius_km,
             home_base_location, last_known_location, last_location_at, years_experience, specialties,
             linked_bank_name, linked_bank_account_no, linked_esewa_id, linked_khalti_id, financial_account_verified,
             lifetime_completed_jobs, rolling_avg_rating, visibility_score, cash_jobs_enabled, pan_number
           )
           VALUES (
             $1, 'VERIFIED', 'VERIFIED_ACTIVE', 'AVAILABLE', 'BANEPA', 12.0,
             ST_SetSRID(ST_MakePoint(85.5200, 27.6310), 4326)::geography,
             ST_SetSRID(ST_MakePoint(85.5200, 27.6310), 4326)::geography,
             NOW(), 6, ARRAY['plumbing','water_pump','geyser_solar'],
             'Nabil Bank', $2, $3, $4, TRUE,
             42, 4.80, $5, TRUE, '609112233'
           )
           ON CONFLICT (user_id) DO NOTHING`,
          [provId, provSpec.bankAcct, provSpec.esewa, provSpec.khalti, provSpec.visScore]
        );

        const floatCode = `PROV_FLOAT:${provId}`;
        const payCode = `PROV_PAYABLE:${provId}`;
        const floatAcct = await client.query(
          `INSERT INTO ledger_accounts (code, account_type, owner_user_id, balance_npr)
           VALUES ($1, 'LIABILITY', $2, $3)
           ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
           RETURNING id`,
          [floatCode, provId, provSpec.floatAmt]
        );
        await client.query(
          `INSERT INTO ledger_accounts (code, account_type, owner_user_id, balance_npr)
           VALUES ($1, 'LIABILITY', $2, $3)
           ON CONFLICT (code) DO NOTHING`,
          [payCode, provId, provSpec.payAmt]
        );
        await client.query(
          `INSERT INTO provider_float_wallets (provider_user_id, ledger_account_id, current_float_npr, is_cash_paused)
           VALUES ($1, $2, $3, FALSE)
           ON CONFLICT (provider_user_id) DO NOTHING`,
          [provId, floatAcct.rows[0].id, provSpec.floatAmt]
        );
      }
    }

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
