import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { pool } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'sipalu-dev-jwt-secret-rotate-via-keyvault';

export interface AuthUser {
  id: string;
  phone_e164: string;
  full_name: string;
  roles: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: user.id,
      phone: user.phone_e164,
      name: user.full_name,
      roles: user.roles,
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET) as {
      sub: string;
      phone: string;
      name: string;
      roles: string[];
    };
    // Refresh active/anonymized state from DB
    const { rows } = await pool.query(
      `SELECT id, phone_e164, full_name, roles, is_active, is_anonymized FROM users WHERE id = $1`,
      [decoded.sub]
    );
    if (!rows[0] || !rows[0].is_active || rows[0].is_anonymized) {
      res.status(401).json({ error: 'Account inactive or anonymized' });
      return;
    }
    req.user = {
      id: rows[0].id,
      phone_e164: rows[0].phone_e164,
      full_name: rows[0].full_name,
      roles: parsePgTextArray(rows[0].roles),
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAnyRole(...allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const has = req.user.roles.some((r) => allowed.includes(r));
    if (!has) {
      res.status(403).json({ error: `Forbidden: requires one of [${allowed.join(', ')}]` });
      return;
    }
    next();
  };
}

export function parsePgTextArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string' && val.startsWith('{') && val.endsWith('}')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.replace(/^"|"$/g, ''));
  }
  return [];
}
