import React, { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';

interface Props {
  token: string | null;
  me: any;
  locale: 'en' | 'ne';
  notify: (msg: string, tone?: 'ok' | 'danger' | 'warn') => void;
  refreshMe: () => Promise<void>;
}

export const CustomerPortal: React.FC<Props> = ({ token, me, locale, notify, refreshMe }) => {
  const [zoneCode, setZoneCode] = useState('BANEPA');
  const [query, setQuery] = useState('');
  const [services, setServices] = useState<any[]>([]);
  const [selectedSku, setSelectedSku] = useState<any | null>(null);
  const [bookingMode, setBookingMode] = useState<'INSTANT_FIXED' | 'LIVE_BIDDING'>('LIVE_BIDDING');
  const [issueDesc, setIssueDesc] = useState('Water pump humming loudly and not lifting water to rooftop tank');
  const [promoCode, setPromoCode] = useState('SIPALU50');
  const [payMethod, setPayMethod] = useState<'ESEWA' | 'KHALTI' | 'FONEPAY_QR' | 'CASH' | 'ESCROW_WALLET'>('ESEWA');
  const [slotOffsetHours, setSlotOffsetHours] = useState(2);

  const [bookings, setBookings] = useState<any[]>([]);
  const [bidsByBooking, setBidsByBooking] = useState<Record<string, any[]>>({});
  const [coByBooking, setCoByBooking] = useState<Record<string, any[]>>({});
  const [chatByBooking, setChatByBooking] = useState<Record<string, any[]>>({});
  const [chatDraft, setChatDraft] = useState('');
  const [otpInput, setOtpInput] = useState('4829');
  const [invoiceView, setInvoiceView] = useState<any | null>(null);
  const [maskedCallInfo, setMaskedCallInfo] = useState<any | null>(null);
  const [sandboxSession, setSandboxSession] = useState<{
    gateway: 'esewa' | 'khalti' | 'fonepay';
    bookingId: string;
    bookingCode: string;
    data: any;
  } | null>(null);

  const handleOpenSandboxGateway = async (booking: any, gateway: 'esewa' | 'khalti' | 'fonepay') => {
    try {
      const origin = window.location.origin;
      const amt = Math.max(10, Number(booking.final_total_npr || 500));
      let data: any;
      if (gateway === 'esewa') {
        data = await apiRequest('/v1/payments/gateways/esewa/sign', {
          method: 'POST',
          token,
          body: {
            booking_id: booking.id,
            amount_npr: amt,
            success_url: `${origin}/?gw_callback=esewa`,
            failure_url: `${origin}/?gw_callback=esewa_failed`,
          },
        });
      } else if (gateway === 'khalti') {
        data = await apiRequest('/v1/payments/gateways/khalti/initiate', {
          method: 'POST',
          token,
          body: {
            booking_id: booking.id,
            amount_npr: amt,
            return_url: `${origin}/?gw_callback=khalti&booking_id=${booking.id}`,
            website_url: origin,
            purchase_order_name: `Sipalu ${booking.booking_code}`,
          },
        });
      } else {
        data = await apiRequest('/v1/payments/gateways/fonepay/sign', {
          method: 'POST',
          token,
          body: {
            booking_id: booking.id,
            amount_npr: amt,
            return_url: `${origin}/?gw_callback=fonepay&booking_id=${booking.id}`,
          },
        });
      }
      setSandboxSession({ gateway, bookingId: booking.id, bookingCode: booking.booking_code, data });
      notify(`${gateway.toUpperCase()} Sandbox checkout initialized (${data.mode})`, 'ok');
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleCompleteSandboxCallback = async () => {
    if (!sandboxSession) return;
    try {
      const { gateway, bookingId, data } = sandboxSession;
      let res: any;
      if (gateway === 'esewa') {
        res = await apiRequest('/v1/payments/webhooks/esewa', {
          method: 'POST',
          body: { data: data.simulated_callback_base64, booking_id: bookingId },
        });
      } else if (gateway === 'khalti') {
        res = await apiRequest('/v1/payments/webhooks/khalti', {
          method: 'POST',
          body: data.simulated_callback,
        });
      } else {
        res = await apiRequest('/v1/payments/webhooks/fonepay', {
          method: 'POST',
          body: data.simulated_callback,
        });
      }
      notify(
        `${gateway.toUpperCase()} Sandbox verified (${res.gateway})! Settled Rs ${res.payment?.amount_npr} & 30-day warranty active.`,
        'ok'
      );
      setSandboxSession(null);
      await fetchBookings();
      await refreshMe();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleLaunchExternalEsewa = () => {
    if (!sandboxSession || sandboxSession.gateway !== 'esewa') return;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = sandboxSession.data.action_url;
    form.target = '_blank';
    for (const [k, v] of Object.entries(sandboxSession.data.form_fields || {})) {
      const inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = k;
      inp.value = String(v);
      form.appendChild(inp);
    }
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  };

  const fetchCatalog = async (qStr = query, zStr = zoneCode) => {
    try {
      const res = await apiRequest(`/v1/catalog/search?zone_code=${encodeURIComponent(zStr)}&q=${encodeURIComponent(qStr)}`);
      setServices(res.services || []);
    } catch (e: any) {
      notify(e.message, 'danger');
    }
  };

  const fetchBookings = async () => {
    if (!token) return;
    try {
      const res = await apiRequest('/v1/bookings?scope=mine', { token });
      const list = res.bookings || [];
      setBookings(list);
      for (const b of list.slice(0, 6)) {
        if (b.booking_mode === 'LIVE_BIDDING') {
          apiRequest(`/v1/bookings/${b.id}/bids`, { token }).then((r) =>
            setBidsByBooking((prev) => ({ ...prev, [b.id]: r.bids || [] }))
          );
        }
        apiRequest(`/v1/bookings/${b.id}/change-orders`, { token }).then((r) =>
          setCoByBooking((prev) => ({ ...prev, [b.id]: r.change_orders || [] }))
        );
        apiRequest(`/v1/bookings/${b.id}/chat`, { token }).then((r) =>
          setChatByBooking((prev) => ({ ...prev, [b.id]: r.messages || [] }))
        );
      }
    } catch (e: any) {
      notify(e.message, 'danger');
    }
  };

  useEffect(() => {
    fetchCatalog();
  }, [zoneCode]);

  useEffect(() => {
    fetchBookings();
  }, [token]);

  const handleCreateBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !me?.addresses?.[0]) {
      notify('Please sign in as a customer with a saved address first.', 'warn');
      return;
    }
    const start = new Date(Date.now() + slotOffsetHours * 3600_000);
    const end = new Date(start.getTime() + 90 * 60_000);
    try {
      const bk = await apiRequest('/v1/bookings', {
        method: 'POST',
        token,
        idempotencyKey: `ui-bk-${Date.now()}`,
        body: {
          zone_code: zoneCode,
          category_slug: selectedSku?.category_slug || 'plumbing',
          sku_id: selectedSku?.id,
          booking_mode: bookingMode,
          urgency: 'URGENT_ASAP',
          address_id: me.addresses[0].id,
          quantity: 1,
          issue_description: issueDesc,
          requested_slot_start: start.toISOString(),
          requested_slot_end: end.toISOString(),
          promo_code: promoCode || undefined,
          payment_method: payMethod,
        },
      });
      notify(`Booking ${bk.booking_code} created (${bk.status})`, 'ok');
      await fetchBookings();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleAcceptBid = async (bookingId: string, bidId: string) => {
    try {
      const res = await apiRequest(`/v1/bookings/${bookingId}/bids/${bidId}/accept`, {
        method: 'POST',
        token,
        idempotencyKey: `accept-${bidId}`,
      });
      notify(
        `Bid accepted! Calendar locked & address unlocked. Completion OTP: ${res.demo_completion_otp || '4829'}`,
        'ok'
      );
      await fetchBookings();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleRespondChangeOrder = async (bookingId: string, coId: string, decision: 'APPROVE' | 'REJECT') => {
    try {
      await apiRequest(`/v1/bookings/${bookingId}/change-orders/${coId}/respond`, {
        method: 'POST',
        token,
        body: { decision },
      });
      notify(`Change Order ${decision}D`, 'ok');
      await fetchBookings();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handlePay = async (bookingId: string, method: string, isEscrowHold: boolean) => {
    try {
      const res = await apiRequest('/v1/payments/initiate', {
        method: 'POST',
        token,
        idempotencyKey: `pay-${bookingId}-${isEscrowHold ? 'esc' : method}`,
        body: { booking_id: bookingId, payment_method: method, is_escrow_hold: isEscrowHold, tip_npr: 100 },
      });
      notify(
        isEscrowHold
          ? `Escrow funded (NPR ${res.payment?.amount_npr}). Release via OTP after completion.`
          : `Paid via ${method} (NPR ${res.payment?.amount_npr}). 30-day warranty active!`,
        'ok'
      );
      await fetchBookings();
      await refreshMe();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleReleaseEscrow = async (bookingId: string) => {
    try {
      await apiRequest(`/v1/bookings/${bookingId}/escrow/release`, {
        method: 'POST',
        token,
        idempotencyKey: `rel-${bookingId}`,
        body: { completion_otp: otpInput },
      });
      notify('Escrow released! VAT invoice ready & 30-day warranty active.', 'ok');
      await fetchBookings();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleRate = async (bookingId: string) => {
    try {
      const res = await apiRequest(`/v1/bookings/${bookingId}/ratings`, {
        method: 'POST',
        token,
        body: {
          overall_stars: 5,
          sub_tags: ['punctuality', 'workmanship', 'pricing_transparency'],
          comment: 'Fixed cleanly on time with transparent MRP parts!',
        },
      });
      notify(`Rated 5★! Provider visibility score updated to ${res.updated_ranking?.visibilityScore}`, 'ok');
      await fetchBookings();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleDispute = async (bookingId: string) => {
    try {
      await apiRequest(`/v1/bookings/${bookingId}/disputes`, {
        method: 'POST',
        token,
        body: {
          category: 'WORKMANSHIP',
          description: 'Pipe joint still dripping slightly after test pressure; requesting escrow freeze.',
        },
      });
      notify('48-Hour Dispute filed — Escrow is now FROZEN pending Admin review.', 'warn');
      await fetchBookings();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleWarranty = async (bookingId: string) => {
    try {
      await apiRequest(`/v1/bookings/${bookingId}/warranty-claims`, {
        method: 'POST',
        token,
        body: { issue_description: 'Recurring drip on replaced joint within 30-day warranty window.' },
      });
      notify('30-Day Warranty claim submitted for 4h QA triage & free revisit.', 'ok');
      await fetchBookings();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleSos = async (bookingId: string) => {
    try {
      const sos = await apiRequest(`/v1/bookings/${bookingId}/sos`, {
        method: 'POST',
        token,
        body: { lat: 27.6298, lng: 85.5214, note: 'Homeowner SOS test during active job' },
      });
      notify(`SOS P0 ALERT SENT (${sos.acs_bridge_call_id}) — Ops notified (<60s SLA)!`, 'danger');
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleMaskedCall = async (bookingId: string) => {
    try {
      const res = await apiRequest(`/v1/bookings/${bookingId}/masked-call`, { method: 'POST', token });
      setMaskedCallInfo(res);
      notify(`Masked call bridge ready: ${res.proxy_number} (personal numbers hidden)`, 'ok');
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleSendChat = async (bookingId: string) => {
    if (!chatDraft.trim()) return;
    try {
      await apiRequest(`/v1/bookings/${bookingId}/chat`, {
        method: 'POST',
        token,
        body: { message_text: chatDraft },
      });
      setChatDraft('');
      await fetchBookings();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleViewInvoice = async (bookingId: string) => {
    try {
      const inv = await apiRequest(`/v1/bookings/${bookingId}/invoice`, { token });
      setInvoiceView(inv);
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handlePrivacyDelete = async () => {
    try {
      const req = await apiRequest('/v1/users/me/privacy-deletion', { method: 'POST', token });
      notify(`7-Working-Day PII deletion request queued (ID: ${req.id.slice(0, 8)})`, 'warn');
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  return (
    <div>
      <section className="hero-band">
        <h1>
          {locale === 'ne'
            ? 'विश्वसनीय घर तथा मेकानिकल सेवा — ६० सेकेन्डमा बुक वा लाइभ बिडिङ'
            : 'Verified Home & Mechanical Repairs — Instant Rate Card or Live Bidding'}
        </h1>
        <p>
          {locale === 'ne'
            ? 'बनेपा र काठमाडौं उपत्यकामा बायोमेट्रिक प्रमाणित प्राविधिक, एस्क्रो सुरक्षा, र ३० दिनको वारेन्टी।'
            : 'Biometrically verified plumbers & mechanical technicians across Banepa and Kathmandu Valley, backed by Escrow protection, transparent MRP parts, and 30-day workmanship warranty.'}
        </p>

        <div className="search-bar-row">
          <select
            id="customer-zone-select"
            value={zoneCode}
            onChange={(e) => setZoneCode(e.target.value)}
            aria-label="Service City"
          >
            <option value="BANEPA">Banepa (Pilot Active)</option>
            <option value="KATHMANDU">Kathmandu</option>
            <option value="LALITPUR">Lalitpur</option>
            <option value="BHAKTAPUR">Bhaktapur</option>
            <option value="POKHARA">Pokhara</option>
          </select>
          <input
            id="customer-symptom-search"
            type="text"
            placeholder="Describe your problem (e.g., pani motor chaldaina, tap leaking, burst pipe)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            id="customer-search-btn"
            className="btn btn-accent"
            type="button"
            onClick={() => fetchCatalog(query, zoneCode)}
          >
            Find Service
          </button>
        </div>

        <div className="chip-row">
          {['pani motor chaldaina', 'tap leaking', 'burst pipe', 'flush tank', 'solar rod'].map((sym) => (
            <button
              key={sym}
              type="button"
              className="chip"
              onClick={() => {
                setQuery(sym);
                fetchCatalog(sym, zoneCode);
              }}
            >
              {sym}
            </button>
          ))}
        </div>
      </section>

      <div className="grid-2">
        {/* Left: Service Catalog + Hybrid Booking Form */}
        <div className="item-list">
          <section className="surface-card">
            <div className="section-header">
              <h2>Available Services in {zoneCode}</h2>
              <span className="badge badge-info">{services.length} SKUs</span>
            </div>
            <div className="item-list">
              {services.map((s) => (
                <div key={s.id} className="booking-item">
                  <div className="section-header" style={{ marginBottom: '0.35rem' }}>
                    <strong>{locale === 'ne' ? s.title_ne : s.title_en}</strong>
                    <span className={`badge ${s.pricing_mode === 'INSTANT_FIXED' ? 'badge-ok' : 'badge-warn'}`}>
                      {s.pricing_mode}
                    </span>
                  </div>
                  <div className="meta-row">
                    <span>Base Labor: <strong>Rs {Number(s.labor_price_npr).toLocaleString()}</strong> / {s.unit_label}</span>
                    <span>Visit Fee: Rs {Number(s.visiting_fee_npr)}</span>
                    <span>{s.warranty_days}-Day Warranty</span>
                  </div>
                  <div className="btn-group">
                    <button
                      type="button"
                      id={`select-sku-${s.slug}`}
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        setSelectedSku(s);
                        setBookingMode(s.pricing_mode === 'INSTANT_FIXED' ? 'INSTANT_FIXED' : 'LIVE_BIDDING');
                      }}
                    >
                      Select &amp; Book
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="surface-card">
            <div className="section-header">
              <h2>Create Hybrid Booking</h2>
              {selectedSku && <span className="badge badge-info">{selectedSku.title_en}</span>}
            </div>
            <form className="form-stack" onSubmit={handleCreateBooking}>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="booking-mode-select">Booking Mode</label>
                  <select
                    id="booking-mode-select"
                    value={bookingMode}
                    onChange={(e) => setBookingMode(e.target.value as any)}
                  >
                    <option value="LIVE_BIDDING">Live Competitive Bidding (15m window)</option>
                    <option value="INSTANT_FIXED">Instant Fixed-Price (&lt;60s Auto-Dispatch)</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="booking-payment-select">Payment Preference</label>
                  <select
                    id="booking-payment-select"
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value as any)}
                  >
                    <option value="ESEWA">eSewa Digital Wallet</option>
                    <option value="ESCROW_WALLET">Escrow Milestone Protection</option>
                    <option value="KHALTI">Khalti Wallet</option>
                    <option value="FONEPAY_QR">Fonepay QR</option>
                    <option value="CASH">Cash on Completion</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="field">
                  <label htmlFor="booking-slot-offset">Slot Start (+Hours from now)</label>
                  <input
                    id="booking-slot-offset"
                    type="number"
                    min={1}
                    max={72}
                    value={slotOffsetHours}
                    onChange={(e) => setSlotOffsetHours(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="booking-promo-input">Promo Code</label>
                  <input
                    id="booking-promo-input"
                    type="text"
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value)}
                    placeholder="SIPALU50"
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="booking-issue-textarea">Issue Description (Photos/Notes)</label>
                <textarea
                  id="booking-issue-textarea"
                  rows={2}
                  value={issueDesc}
                  onChange={(e) => setIssueDesc(e.target.value)}
                />
              </div>

              <button id="submit-booking-btn" type="submit" className="btn btn-accent">
                {bookingMode === 'LIVE_BIDDING' ? 'Broadcast for Live Bids' : 'Confirm Instant Booking (<60s)'}
              </button>
            </form>
          </section>
        </div>

        {/* Right: Active Bookings, Live Bids, Change Orders, Checkout, Warranty & SOS */}
        <div className="item-list">
          <section className="surface-card">
            <div className="section-header">
              <h2>My Bookings &amp; Live Loop</h2>
              <div className="btn-group" style={{ marginTop: 0 }}>
                <span className="badge badge-ok">Loyalty: {me?.loyalty_points ?? 0} pts</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={fetchBookings}>
                  Refresh
                </button>
              </div>
            </div>

            {maskedCallInfo && (
              <div className="alert-banner alert-ok">
                Masked VoIP Bridge Active: Call <strong>{maskedCallInfo.proxy_number}</strong> (Bridge {maskedCallInfo.bridge_id}) — Personal numbers hidden.
              </div>
            )}

            {invoiceView && (
              <div className="alert-banner alert-ok" id="vat-invoice-panel">
                <strong>VAT Invoice {invoiceView.invoice_number}</strong> (VAT #{invoiceView.vat_registration_no})<br />
                Labor: Rs {invoiceView.line_items.base_labor_npr} + Change Order Labor: Rs {invoiceView.line_items.change_order_labor_npr} |
                Parts (MRP): Rs {invoiceView.line_items.spare_parts_mrp_npr} | Visit: Rs {invoiceView.line_items.visiting_fee_npr} |
                Tip: Rs {invoiceView.line_items.tip_npr} | <strong>Total: Rs {invoiceView.line_items.total_paid_npr}</strong>
              </div>
            )}

            {sandboxSession && (
              <div className="alert-banner alert-warn" id="sandbox-checkout-panel">
                <div className="section-header" style={{ marginBottom: '0.35rem' }}>
                  <strong>
                    {sandboxSession.gateway.toUpperCase()} Sandbox Checkout · {sandboxSession.bookingCode} ({sandboxSession.data.mode})
                  </strong>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSandboxSession(null)}>
                    Close
                  </button>
                </div>
                <div style={{ fontSize: '0.8rem', lineHeight: 1.45 }}>
                  {sandboxSession.gateway === 'esewa' && (
                    <>
                      <div>Endpoint: <code>{sandboxSession.data.action_url}</code> · Product: <code>{sandboxSession.data.form_fields?.product_code}</code></div>
                      <div>HMAC-SHA256 Signature: <code>{String(sandboxSession.data.form_fields?.signature || '').slice(0, 28)}...</code></div>
                      <div>Test Wallet: <code>9806800001</code> / Pass: <code>Nepal@123</code> / MPIN: <code>1122</code> / OTP: <code>987654</code></div>
                    </>
                  )}
                  {sandboxSession.gateway === 'khalti' && (
                    <>
                      <div>PIDX: <code>{sandboxSession.data.pidx}</code> · Amount: <code>{sandboxSession.data.amount_paisa} paisa</code></div>
                      <div>Test Wallet: <code>9800000000</code> / MPIN: <code>1111</code> / OTP: <code>987654</code></div>
                    </>
                  )}
                  {sandboxSession.gateway === 'fonepay' && (
                    <>
                      <div>PID: <code>{sandboxSession.data.params?.PID}</code> · PRN: <code>{sandboxSession.data.params?.PRN}</code></div>
                      <div>Dynamic QR: <code>{sandboxSession.data.qr_string}</code></div>
                      <div>HMAC-SHA512 DV: <code>{String(sandboxSession.data.params?.DV || '').slice(0, 28)}...</code></div>
                    </>
                  )}
                </div>
                <div className="btn-group">
                  <button
                    id="complete-sandbox-payment-btn"
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleCompleteSandboxCallback}
                  >
                    Verify Signed Sandbox Callback &amp; Settle Ledger
                  </button>
                  {sandboxSession.gateway === 'esewa' && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={handleLaunchExternalEsewa}>
                      Open Official eSewa UAT Portal
                    </button>
                  )}
                  {sandboxSession.gateway === 'khalti' && sandboxSession.data.payment_url && (
                    <a
                      href={sandboxSession.data.payment_url}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-secondary btn-sm"
                      style={{ textDecoration: 'none' }}
                    >
                      Open Khalti Sandbox Page
                    </a>
                  )}
                </div>
              </div>
            )}

            <div className="item-list">
              {bookings.length === 0 && <p style={{ color: 'var(--ink-muted)' }}>No bookings yet. Create one on the left!</p>}
              {bookings.map((b) => {
                const bids = bidsByBooking[b.id] || [];
                const cos = coByBooking[b.id] || [];
                const msgs = chatByBooking[b.id] || [];
                return (
                  <div key={b.id} className="booking-item" data-booking-code={b.booking_code}>
                    <div className="section-header" style={{ marginBottom: '0.25rem' }}>
                      <strong>{b.booking_code} · {b.sku_title || b.category_name}</strong>
                      <span className={`badge ${b.status === 'SETTLED_CLOSED' ? 'badge-ok' : b.status === 'DISPUTED_ESCROW_FROZEN' ? 'badge-danger' : 'badge-info'}`}>
                        {b.status}
                      </span>
                    </div>
                    <div className="meta-row">
                      <span>Mode: {b.booking_mode}</span>
                      <span>Total: <strong>Rs {Number(b.final_total_npr).toLocaleString()}</strong></span>
                      {b.provider_name && <span>Pro: {b.provider_name} ({b.provider_tier} · {b.provider_rating}★)</span>}
                      {b.escrow_status && <span className="badge badge-warn">Escrow: {b.escrow_status}</span>}
                    </div>
                    <p style={{ fontSize: '0.85rem', margin: '0.3rem 0' }}>{b.issue_description}</p>

                    {/* Incoming Live Bids Comparison */}
                    {b.status === 'LIVE_BIDDING' && (
                      <div style={{ marginTop: '0.6rem' }}>
                        <strong style={{ fontSize: '0.84rem' }}>Live Bids ({bids.length}):</strong>
                        {bids.length === 0 && <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>Waiting for verified technicians to bid...</div>}
                        {bids.map((bid) => (
                          <div key={bid.id} className="meta-row" style={{ justifyContent: 'space-between', background: '#fff', padding: '0.45rem 0.6rem', borderRadius: 6, border: '1px solid var(--border-subtle)' }}>
                            <span>
                              <strong>{bid.provider_name}</strong> ({bid.tier_code} · {bid.rolling_avg_rating}★ · {bid.lifetime_completed_jobs} jobs) —{' '}
                              <strong>Rs {Number(bid.quoted_labor_npr)}</strong> · ETA {bid.estimated_arrival_min}m
                            </span>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm accept-bid-btn"
                              onClick={() => handleAcceptBid(b.id, bid.id)}
                            >
                              Accept Bid
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Pending Change Orders (MRP Parts + Extra Labor) */}
                    {cos.filter((c) => c.status === 'PENDING_CUSTOMER_APPROVAL').map((co) => (
                      <div key={co.id} className="alert-banner alert-warn" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
                        <strong>On-Site Change Order:</strong> {co.reason} — Extra Labor: Rs {co.additional_labor_npr} + MRP Parts: Rs {co.total_parts_mrp_npr}
                        <div className="btn-group">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm approve-co-btn"
                            onClick={() => handleRespondChangeOrder(b.id, co.id, 'APPROVE')}
                          >
                            Approve Change Order
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleRespondChangeOrder(b.id, co.id, 'REJECT')}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* Action Controls */}
                    <div className="btn-group">
                      {b.assigned_provider_id && ['SCHEDULED_LOCKED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(b.status) && (
                        <>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleMaskedCall(b.id)}>
                            Masked Call
                          </button>
                          <button type="button" className="btn btn-danger btn-sm sos-btn" onClick={() => handleSos(b.id)}>
                            SOS Emergency
                          </button>
                        </>
                      )}
                      {b.assigned_provider_id && ['SCHEDULED_LOCKED', 'IN_PROGRESS', 'COMPLETED_PENDING_CONFIRM'].includes(b.status) && b.escrow_status !== 'HELD' && (
                        <>
                          <button type="button" className="btn btn-primary btn-sm sandbox-esewa-btn" onClick={() => handleOpenSandboxGateway(b, 'esewa')}>
                            eSewa Sandbox
                          </button>
                          <button type="button" className="btn btn-primary btn-sm sandbox-khalti-btn" onClick={() => handleOpenSandboxGateway(b, 'khalti')}>
                            Khalti Sandbox
                          </button>
                          <button type="button" className="btn btn-primary btn-sm sandbox-fonepay-btn" onClick={() => handleOpenSandboxGateway(b, 'fonepay')}>
                            Fonepay Sandbox
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm fund-escrow-btn" onClick={() => handlePay(b.id, 'ESEWA', true)}>
                            Fund Escrow
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm pay-cash-btn" onClick={() => handlePay(b.id, 'CASH', false)}>
                            Pay Cash
                          </button>
                        </>
                      )}
                      {b.escrow_status === 'HELD' && (
                        <>
                          <input
                            type="text"
                            style={{ width: 78, padding: '0.25rem 0.45rem', borderRadius: 6, border: '1px solid var(--border-subtle)' }}
                            value={otpInput}
                            onChange={(e) => setOtpInput(e.target.value)}
                            aria-label="Completion OTP"
                          />
                          <button type="button" className="btn btn-primary btn-sm release-escrow-btn" onClick={() => handleReleaseEscrow(b.id)}>
                            Release Escrow (OTP)
                          </button>
                        </>
                      )}
                      {['COMPLETED_PENDING_CONFIRM', 'SETTLED_CLOSED'].includes(b.status) && (
                        <>
                          <button type="button" className="btn btn-secondary btn-sm rate-pro-btn" onClick={() => handleRate(b.id)}>
                            Rate 5★
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleViewInvoice(b.id)}>
                            VAT Invoice
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm file-dispute-btn" onClick={() => handleDispute(b.id)}>
                            48h Dispute
                          </button>
                        </>
                      )}
                      {b.status === 'SETTLED_CLOSED' && (
                        <button type="button" className="btn btn-accent btn-sm warranty-btn" onClick={() => handleWarranty(b.id)}>
                          30-Day Warranty
                        </button>
                      )}
                    </div>

                    {/* Mini In-App Auditable Chat */}
                    {b.assigned_provider_id && (
                      <div style={{ marginTop: '0.6rem', paddingTop: '0.5rem', borderTop: '1px dashed var(--border-subtle)' }}>
                        <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', marginBottom: '0.25rem' }}>
                          In-App Audit Chat ({msgs.length})
                        </div>
                        {msgs.slice(-2).map((m) => (
                          <div key={m.id} style={{ fontSize: '0.8rem' }}>
                            <strong>{m.sender_name}:</strong> {m.message_text}
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.35rem' }}>
                          <input
                            type="text"
                            placeholder="Message technician..."
                            style={{ flex: 1, padding: '0.3rem 0.55rem', borderRadius: 6, border: '1px solid var(--border-subtle)' }}
                            value={chatDraft}
                            onChange={(e) => setChatDraft(e.target.value)}
                          />
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleSendChat(b.id)}>
                            Send
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="divider" />
            <div className="section-header" style={{ marginBottom: 0 }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
                Data Privacy: 7-working-day account deletion preserves statutory VAT ledgers.
              </span>
              <button id="request-privacy-delete-btn" type="button" className="btn btn-secondary btn-sm" onClick={handlePrivacyDelete}>
                Request PII Deletion
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
