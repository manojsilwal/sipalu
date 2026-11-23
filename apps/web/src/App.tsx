import React, { useEffect, useState } from 'react';
import { apiRequest, DEMO_PERSONAS } from './lib/api';
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

  const loginAsPhone = async (phone: string, targetTab?: PortalTab) => {
    try {
      await apiRequest('/v1/auth/otp/request', { method: 'POST', body: { phone_e164: phone, locale } });
      const res = await apiRequest('/v1/auth/otp/verify', {
        method: 'POST',
        body: { phone_e164: phone, otp_code: '123456' },
      });
      const profile = await apiRequest('/v1/auth/me', { token: res.token });
      if (targetTab) setActiveTab(targetTab);
      setMe(profile);
      setToken(res.token);
      notify(`Signed in as ${res.user.full_name}`, 'ok');
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  useEffect(() => {
    // Auto sign-in default Banepa pilot customer on initial load
    loginAsPhone(DEMO_PERSONAS[0].phone, 'customer');

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
          </div>
        </div>
      </header>

      {/* Pilot Role Switcher Bar for Real Human & QA Walkthroughs */}
      <div className="persona-bar">
        <div className="persona-bar-inner">
          <div>
            <strong>Active Session:</strong>{' '}
            <span id="active-user-label">{me ? `${me.full_name} (${me.phone_e164})` : 'Signing in...'}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }}>
            <span style={{ color: 'var(--ink-muted)' }}>Quick OTP Sign-In:</span>
            {DEMO_PERSONAS.map((p) => (
              <button
                key={p.key}
                id={`persona-btn-${p.key}`}
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => loginAsPhone(p.phone, p.portal)}
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
