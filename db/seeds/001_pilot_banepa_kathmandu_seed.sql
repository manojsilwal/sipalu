-- 001_pilot_banepa_kathmandu_seed.sql
-- Seed data for Phase 1 Pilot (Banepa & Kathmandu Valley — Plumbing & Mechanical) + Core System Ledger Accounts

-- 1. Four-Tier Commission Ladder (Labor Revenue Only)
INSERT INTO commission_tiers (code, display_name, min_lifetime_jobs, max_lifetime_jobs, min_rating_for_promotion, commission_rate, priority_weight, tool_loan_limit_npr)
VALUES
    ('TRAINEE',  'Trainee',  0,   25,   4.40, 0.2200, 1.00, 15000.00),
    ('VERIFIED', 'Verified', 26,  100,  4.40, 0.1800, 1.25, 15000.00),
    ('PRO',      'Pro',      101, 400,  4.40, 0.1500, 1.50, 25000.00),
    ('ELITE',    'Elite',    401, NULL, 4.40, 0.1200, 1.85, 25000.00)
ON CONFLICT (code) DO NOTHING;

-- 2. Core System Ledger Accounts (Double-Entry)
INSERT INTO ledger_accounts (code, account_type)
VALUES
    ('SYS_GATEWAY_CLEARING_ESEWA',   'ASSET'),
    ('SYS_GATEWAY_CLEARING_KHALTI',  'ASSET'),
    ('SYS_GATEWAY_CLEARING_FONEPAY', 'ASSET'),
    ('SYS_GATEWAY_CLEARING_BANK',    'ASSET'),
    ('SYS_ESCROW_LIABILITY',         'LIABILITY'),
    ('SYS_WARRANTY_RESERVE',         'LIABILITY'),
    ('SYS_VAT_PAYABLE',              'LIABILITY'),
    ('SYS_PLATFORM_COMMISSION_REV',  'REVENUE'),
    ('SYS_INSTANT_PAYOUT_FEE_REV',   'REVENUE'),
    ('SYS_PROMO_SUBSIDY_EXP',        'EXPENSE')
ON CONFLICT (code) DO NOTHING;

-- 3. Service Zones (Phase 1 Pilot Active: Banepa + Kathmandu Valley)
INSERT INTO service_zones (code, name_en, name_ne, is_pilot_active, is_active)
VALUES
    ('BANEPA',    'Banepa',    'बनेपा',      TRUE,  TRUE),
    ('KATHMANDU', 'Kathmandu', 'काठमाडौं',    TRUE,  TRUE),
    ('LALITPUR',  'Lalitpur',  'ललितपुर',     TRUE,  TRUE),
    ('BHAKTAPUR', 'Bhaktapur', 'भक्तपुर',     TRUE,  TRUE),
    ('POKHARA',   'Pokhara',   'पोखरा',      FALSE, TRUE),
    ('BUTWAL',    'Butwal',    'बुटवल',      FALSE, FALSE)
ON CONFLICT (code) DO NOTHING;

-- 4. Pilot Categories (Plumbing & Mechanical) + Expansion Placeholders
INSERT INTO categories (slug, name_en, name_ne, sort_order, is_active)
VALUES
    ('plumbing',                  'Plumbing',                  'प्लम्बिङ',              1,  TRUE),
    ('mechanical-utility',        'Mechanical & Water Pumps',  'मेकानिकल र पानी पम्प',  2,  TRUE),
    ('electrical',                'Electrical',                'इलेक्ट्रिकल',           3,  FALSE),
    ('ac-appliances',             'AC & Appliances',           'एसी र उपकरण',          4,  FALSE),
    ('washing-machine',           'Washing Machine',           'वासिङ मेसिन',          5,  FALSE),
    ('cleaning-pest-control',     'Cleaning & Pest Control',   'सफाई र कीट नियन्त्रण',   6,  FALSE),
    ('computer-repair',           'Computer Repair',           'कम्प्युटर मर्मत',        7,  FALSE),
    ('office-maintenance-amc',    'Office Maintenance (AMC)',  'कार्यालय मर्मत (AMC)',   8,  FALSE),
    ('home-office-renovation',    'Home/Office Renovation',    'घर/कार्यालय नवीकरण',    9,  FALSE),
    ('ev-charger-automobile',     'EV Charger & Automobile',   'ईभी चार्जर र अटोमोबाइल', 10, FALSE)
ON CONFLICT (slug) DO NOTHING;

-- 5. Pilot Subcategories & Sample Hybrid SKUs (Plumbing & Mechanical)
WITH cat_plumb AS (SELECT id FROM categories WHERE slug = 'plumbing'),
     cat_mech  AS (SELECT id FROM categories WHERE slug = 'mechanical-utility')
INSERT INTO subcategories (category_id, slug, name_en, name_ne, sort_order)
SELECT id, 'bathroom-fittings', 'Bathroom & Tap Fittings', 'बाथरूम र धारा जडान', 1 FROM cat_plumb
UNION ALL
SELECT id, 'pipelines-drainage', 'Pipelines, Leaks & Blockages', 'पाइपलाइन र लिकेज', 2 FROM cat_plumb
UNION ALL
SELECT id, 'solar-geyser', 'Solar Water Heater & Geyser', 'सोलार र गिजर', 3 FROM cat_plumb
UNION ALL
SELECT id, 'water-pump-motor', 'Water Pump & Pressure Motor', 'पानी पम्प र मोटर', 1 FROM cat_mech
ON CONFLICT (slug) DO NOTHING;

WITH sub_bath AS (SELECT id FROM subcategories WHERE slug = 'bathroom-fittings'),
     sub_pipe AS (SELECT id FROM subcategories WHERE slug = 'pipelines-drainage'),
     sub_sol  AS (SELECT id FROM subcategories WHERE slug = 'solar-geyser'),
     sub_pump AS (SELECT id FROM subcategories WHERE slug = 'water-pump-motor')
INSERT INTO service_skus (subcategory_id, slug, title_en, title_ne, pricing_mode, base_labor_npr, unit_label, estimated_duration_min, warranty_days, min_bid_sanity_npr, max_bid_sanity_npr, symptom_keywords)
SELECT id, 'tap-faucet-leakage-repair', 'Tap & Faucet Leakage Repair', 'धारा चुहिने मर्मत', 'INSTANT_FIXED'::pricing_mode, 350.00, 'Unit', 45, 30, 250, 1200, ARRAY['tap leaking','kitchen tap','faucet drip','dhara chuhiyo'] FROM sub_bath
UNION ALL
SELECT id, 'flush-tank-repair-external', 'Flush Tank Repair (External)', 'फ्लश ट्याङ्की मर्मत', 'INSTANT_FIXED'::pricing_mode, 650.00, 'Unit', 60, 30, 400, 2000, ARRAY['flush not working','toilet running','flush tank'] FROM sub_bath
UNION ALL
SELECT id, 'burst-pipe-emergency-repair', 'Burst / Concealed Pipe Emergency Repair', 'पाइप फुटेको आपतकालीन मर्मत', 'LIVE_BIDDING'::pricing_mode, 650.00, 'Inspection', 90, 30, 500, 15000, ARRAY['burst pipe','wall seepage','pipe phutyo','water leak wall'] FROM sub_pipe
UNION ALL
SELECT id, 'solar-water-heater-rod-replace', 'Solar Water Heater Rod Replacement', 'सोलार हिटर रड परिवर्तन', 'HYBRID'::pricing_mode, 2000.00, 'Unit', 90, 30, 1200, 5000, ARRAY['solar not heating','cold water','solar rod'] FROM sub_sol
UNION ALL
SELECT id, 'water-pump-motor-repair', 'Water Pump / Pressure Motor Diagnostics & Repair', 'पानी तान्ने मोटर मर्मत', 'LIVE_BIDDING'::pricing_mode, 650.00, 'Inspection', 90, 30, 500, 12000, ARRAY['pani motor chaldaina','pump humming','no water tank','motor repair'] FROM sub_pump
ON CONFLICT (slug) DO NOTHING;
