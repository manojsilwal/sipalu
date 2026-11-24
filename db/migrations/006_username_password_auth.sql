-- 006_username_password_auth.sql
-- Add basic username + salted scrypt password authentication (replaces OTP requirement for Pilot/Student launch)

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS username CITEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
