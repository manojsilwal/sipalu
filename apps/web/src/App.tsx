import React, { useEffect, useState } from 'react';
import { apiRequest, DEMO_DEFAULT_PASSWORD, DEMO_PERSONAS } from './lib/api';
import { CustomerPortal } from './portals/CustomerPortal';
import { ProviderPortal } from './portals/ProviderPortal';
import { AdminOpsPortal } from './portals/AdminOpsPortal';
import { B2bProjectPortal } from './portals/B2bProjectPortal';

type PortalTab = 'customer' | 'provider' | 'b2b' | 'admin';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<PortalTab>('customer');
  const [locale, setLocale] = useState<'en' | 'ne'>('en');
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<any | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'danger' | 'warn' } | null>(null);

  // Username & Password Auth Modal State
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [fullNameInput, setFullNameInput] = useState('');
  const [regRole, setRegRole] = useState<'CUSTOMER' | 'PROVIDER'>('CUSTOMER');

  const notify = (msg: string, tone: 'ok' | 'danger' | 'warn' = 'ok') => {
    setToast({ msg, tone });
    setTimeout(() => setToast((curr) => (curr?.msg === msg ? null : curr)), 6000);
  };

  const refreshMe = async (tok = token) => {
    if (!tok) return;
    try {
      const profile = await apiRequest('/v1/auth/me', { token: tok });
      setMe(profile);
    } catch {
      setMe(null);
    }
  };

  const loginWithCredentials = async (username: string, password: string, targetTab?: PortalTab) => {
    try {
      const res = await apiRequest('/v1/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      const profile = await apiRequest('/v1/auth/me', { token: res.token });
      if (targetTab) {
        setActiveTab(targetTab);
      } else if (profile.roles?.includes('SUPER_ADMIN')) {
        setActiveTab('admin');
      } else if (profile.roles?.includes('PROVIDER')) {
        setActiveTab('provider');
      } else {
        setActiveTab('customer');
      }
      setMe(profile);
      setToken(res.token);
      setAuthModalOpen(false);
      notify(`Signed in as ${res.user.full_name}`, 'ok');
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authMode === 'login') {
      await loginWithCredentials(usernameInput, passwordInput);
      return;
    }
    try {
      const res = await apiRequest('/v1/auth/register', {
        method: 'POST',
        body: {
          username: usernameInput,
          password: passwordInput,
          full_name: fullNameInput,
          role: regRole,
        },
      });
      const profile = await apiRequest('/v1/auth/me', { token: res.token });
      setActiveTab(regRole === 'PROVIDER' ? 'provider' : 'customer');
      setMe(profile);
      setToken(res.token);
      setAuthModalOpen(false);
      notify(`Account created! Welcome, ${res.user.full_name}`, 'ok');
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleLogout = () => {
    setToken(null);
    setMe(null);
    setAuthModalOpen(true);
    setAuthMode('login');
    notify('Signed out', 'warn');
  };

  useEffect(() => {
    // Auto sign-in default Banepa pilot customer via Username/Password
    loginWithCredentials('aarav', DEMO_DEFAULT_PASSWORD, 'customer');

    // Auto-handle external eSewa / Khalti / Fonepay sandbox return URL callbacks if present
    const qs = new URLSearchParams(window.location.search);
    const gwCb = qs.get('gw_callback');
    if (gwCb === 'esewa' && qs.get('data')) {
      apiRequest('/v1/payments/webhooks/esewa', { method: 'POST', body: { data: qs.get('data') } })
        .then(() => notify('eSewa Sandbox payment verified & settled in double-entry ledger!', 'ok'))
        .catch((e) => notify(`eSewa callback error: ${e.message}`, 'danger'));
      window.history.replaceState({}, '', window.location.pathname);
    } else if (gwCb === 'fonepay' && qs.get('PRN') && qs.get('DV')) {
      apiRequest('/v1/payments/webhooks/fonepay', {
        method: 'POST',
        body: Object.fromEntries(qs.entries()),
      })
        .then(() => notify('Fonepay Sandbox payment verified & settled!', 'ok'))
        .catch((e) => notify(`Fonepay callback error: ${e.message}`, 'danger'));
      window.history.replaceState({}, '', window.location.pathname);
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'SOS_P0_ALERT') {
          notify(`LIVE P0 SOS ALERT on booking ${data.bookingId}`, 'danger');
        }
      } catch {
        // ignore heartbeat parse
      }
    };
    return () => ws.close();
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand-lockup">
            <div className="brand-mark">S</div>
            <div>
              <div className="brand-name">Sipalu</div>
              <div className="brand-tag">Banepa &amp; Kathmandu Valley Pilot · Azure Cloud</div>
            </div>
          </div>

          <nav className="nav-tabs" aria-label="Primary Portals">
            <button
              id="tab-customer"
              type="button"
              className={`nav-tab ${activeTab === 'customer' ? 'active' : ''}`}
              onClick={() => setActiveTab('customer')}
            >
              Customer Marketplace
            </button>
            <button
              id="tab-provider"
              type="button"
              className={`nav-tab ${activeTab === 'provider' ? 'active' : ''}`}
              onClick={() => setActiveTab('provider')}
            >
              Provider Hub
            </button>
            <button
              id="tab-b2b"
              type="button"
              className={`nav-tab ${activeTab === 'b2b' ? 'active' : ''}`}
              onClick={() => setActiveTab('b2b')}
            >
              B2B AMC &amp; Projects
            </button>
            <button
              id="tab-admin"
              type="button"
              className={`nav-tab ${activeTab === 'admin' ? 'active' : ''}`}
              onClick={() => setActiveTab('admin')}
            >
              Ops &amp; Admin
            </button>
          </nav>

          <div className="topbar-controls">
            <span className={`badge ${wsConnected ? 'badge-ok' : 'badge-warn'}`} id="ws-status-badge">
              {wsConnected ? 'Live Sync ON' : 'Syncing'}
            </span>
            <button
              id="locale-toggle-btn"
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setLocale((l) => (l === 'en' ? 'ne' : 'en'))}
            >
              {locale === 'en' ? 'नेपाली (NP)' : 'English (EN)'}
            </button>
            <button
              id="open-auth-modal-btn"
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setAuthModalOpen((o) => !o)}
            >
              {me ? 'Account / Sign In' : 'Sign In / Register'}
            </button>
          </div>
        </div>
      </header>

      {/* Username/Password Auth Drawer */}
      {authModalOpen && (
        <div
          id="auth-modal"
          style={{
            background: '#ffffff',
            borderBottom: '1px solid var(--border-subtle)',
            padding: '1.15rem 1.25rem',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div style={{ maxWidth: 880, margin: '0 auto' }}>
            <div className="section-header" style={{ marginBottom: '0.65rem' }}>
              <h3 style={{ margin: 0 }}>
                {authMode === 'login' ? 'Sign In with Username & Password' : 'Create Sipalu Account'}
              </h3>
              <div className="btn-group" style={{ marginTop: 0 }}>
                <button
                  id="switch-login-mode-btn"
                  type="button"
                  className={`btn btn-sm ${authMode === 'login' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setAuthMode('login')}
                >
                  Sign In
                </button>
                <button
                  id="switch-register-mode-btn"
                  type="button"
                  className={`btn btn-sm ${authMode === 'register' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setAuthMode('register')}
                >
                  Register
                </button>
                {me && (
                  <button id="logout-btn" type="button" className="btn btn-secondary btn-sm" onClick={handleLogout}>
                    Sign Out
                  </button>
                )}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAuthModalOpen(false)}>
                  Close
                </button>
              </div>
            </div>

            <form className="form-row" onSubmit={handleAuthSubmit} style={{ alignItems: 'end' }}>
              <div className="field">
                <label htmlFor="auth-username">Username</label>
                <input
                  id="auth-username"
                  type="text"
                  required
                  placeholder="e.g. aarav, bikram, admin"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="auth-password">Password</label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  placeholder="Min 6 characters"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                />
              </div>
              {authMode === 'register' && (
                <>
                  <div className="field">
                    <label htmlFor="auth-fullname">Full Name</label>
                    <input
                      id="auth-fullname"
                      type="text"
                      required
                      placeholder="Your full name"
                      value={fullNameInput}
                      onChange={(e) => setFullNameInput(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="auth-role">Account Role</label>
                    <select
                      id="auth-role"
                      value={regRole}
                      onChange={(e) => setRegRole(e.target.value as 'CUSTOMER' | 'PROVIDER')}
                    >
                      <option value="CUSTOMER">Homeowner / Customer</option>
                      <option value="PROVIDER">Service Technician / Provider</option>
                    </select>
                  </div>
                </>
              )}
              <button id="auth-submit-btn" type="submit" className="btn btn-accent">
                {authMode === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            </form>
            <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', marginTop: '0.5rem' }}>
              Sipalu Test Accounts (Password: <code>Sipalu@2026</code>): <code>manoj</code> (Founder/Admin),{' '}
              <code>sipalu_customer</code>, <code>sipalu_expert</code>, <code>aarav</code>, <code>bikram</code>,{' '}
              <code>raju</code>, <code>sita</code>, <code>admin</code>
            </div>
          </div>
        </div>
      )}

      {/* Pilot Role Switcher Bar */}
      <div className="persona-bar">
        <div className="persona-bar-inner">
          <div>
            <strong>Active Session:</strong>{' '}
            <span id="active-user-label">
              {me ? `${me.full_name} (@${me.username || me.phone_e164})` : 'Not signed in'}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }}>
            <span style={{ color: 'var(--ink-muted)' }}>Demo Sign-In:</span>
            {DEMO_PERSONAS.map((p) => (
              <button
                key={p.key}
                id={`persona-btn-${p.key}`}
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => loginWithCredentials(p.username, DEMO_DEFAULT_PASSWORD, p.portal)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="main-content">
        {activeTab === 'customer' && (
          <CustomerPortal token={token} me={me} locale={locale} notify={notify} refreshMe={() => refreshMe()} />
        )}
        {activeTab === 'provider' && (
          <ProviderPortal token={token} me={me} notify={notify} refreshMe={() => refreshMe()} />
        )}
        {activeTab === 'b2b' && <B2bProjectPortal token={token} notify={notify} />}
        {activeTab === 'admin' && <AdminOpsPortal token={token} me={me} notify={notify} />}
      </main>

      {toast && (
        <div id="toast-notification" role="status" className={`toast-bar alert-${toast.tone}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
};
