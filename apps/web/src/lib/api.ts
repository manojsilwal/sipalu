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

export const DEMO_PERSONAS = [
  { key: 'customer', label: 'Customer (Aarav · Banepa)', phone: '+9779800000002', portal: 'customer' as const },
  { key: 'provider', label: 'Verified Plumber (Bikram)', phone: '+9779800000003', portal: 'provider' as const },
  { key: 'applicant', label: 'New Tech Applicant (Raju)', phone: '+9779800000005', portal: 'provider' as const },
  { key: 'b2b', label: 'Facility Mgr (Sita · B2B)', phone: '+9779800000004', portal: 'b2b' as const },
  { key: 'admin', label: 'Ops Admin (Maya)', phone: '+9779800000001', portal: 'admin' as const },
];
