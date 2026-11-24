export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error || `HTTP ${status}`));
    this.status = status;
    this.body = body;
  }
}

export async function apiRequest<T = any>(
  path: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    idempotencyKey?: string;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const res = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data);
  }
  return data as T;
}

export const DEMO_DEFAULT_PASSWORD = 'Sipalu@2026';

export const DEMO_PERSONAS = [
  { key: 'customer', label: 'Customer (aarav)', username: 'aarav', portal: 'customer' as const },
  { key: 'provider', label: 'Verified Plumber (bikram)', username: 'bikram', portal: 'provider' as const },
  { key: 'applicant', label: 'New Tech Applicant (raju)', username: 'raju', portal: 'provider' as const },
  { key: 'b2b', label: 'Facility Mgr (sita)', username: 'sita', portal: 'b2b' as const },
  { key: 'admin', label: 'Ops Admin (admin)', username: 'admin', portal: 'admin' as const },
];
