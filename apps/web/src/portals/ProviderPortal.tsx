import React, { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';

interface Props {
  token: string | null;
  me: any;
  notify: (msg: string, tone?: 'ok' | 'danger' | 'warn') => void;
  refreshMe: () => Promise<void>;
}

export const ProviderPortal: React.FC<Props> = ({ token, me, notify, refreshMe }) => {
  const [openBids, setOpenBids] = useState<any[]>([]);
  const [assigned, setAssigned] = useState<any[]>([]);
  const [calendar, setCalendar] = useState<any[]>([]);
  const [payouts, setPayouts] = useState<any[]>([]);

  // Bid Form
  const [bidAmount, setBidAmount] = useState(1400);
  const [bidEta, setBidEta] = useState(25);
  const [bidNotes, setBidNotes] = useState('Includes diagnostic pressure test; spare parts at MRP');

  // Biometric KYC Form
  const [docType, setDocType] = useState<'CITIZENSHIP_NAGARIKTA' | 'NATIONAL_ID_RASTRIYA'>('CITIZENSHIP_NAGARIKTA');
  const [docNum, setDocNum] = useState('27-01-75-09821');
  const [bankName, setBankName] = useState('Nabil Bank');
  const [bankAcct, setBankAcct] = useState('01201017508821');
  const [esewaId, setEsewaId] = useState('9800000005');

  // Change Order Form
  const [coReason, setCoReason] = useState('Replace damaged 1HP brass check valve & capacitor');
  const [coLabor, setCoLabor] = useState(350);
  const [coPartName, setCoPartName] = useState('Brass Check Valve 1-inch (MRP)');
  const [coPartMrp, setCoPartMrp] = useState(650);

  const loadAll = async () => {
    if (!token) return;
    try {
      const [ob, asgn, cal, pay] = await Promise.all([
        apiRequest('/v1/bookings?scope=open_bids', { token }),
        apiRequest('/v1/bookings?scope=provider_assigned', { token }),
        apiRequest('/v1/providers/me/calendar', { token }),
        apiRequest('/v1/providers/me/payouts', { token }),
      ]);
      setOpenBids(ob.bookings || []);
      setAssigned(asgn.bookings || []);
      setCalendar(cal.slots || []);
      setPayouts(pay.payouts || []);
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  useEffect(() => {
    loadAll();
  }, [token]);

  const handleSubmitKyc = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const liveness = await apiRequest('/v1/providers/kyc/liveness-session', {
        method: 'POST',
        token,
        body: { purpose: 'INITIAL_KYC' },
      });
      const res = await apiRequest('/v1/providers/kyc/submit', {
        method: 'POST',
        token,
        body: {
          document_type: docType,
          document_number: docNum,
          doc_front_blob_path: liveness.upload_urls.doc_front_sas,
          doc_back_blob_path: liveness.upload_urls.doc_back_sas,
          selfie_blob_path: liveness.upload_urls.selfie_sas,
          azure_liveness_session_id: liveness.session_id,
          liveness_passed: true,
          simulated_face_score: 0.94,
          primary_city: 'BANEPA',
          service_radius_km: 10,
          specialties: ['plumbing', 'water_pump'],
          linked_bank_name: bankName,
          linked_bank_account_no: bankAcct,
          linked_esewa_id: esewaId,
          pan_number: '609887711',
        },
      });
      notify(`Biometric KYC submitted (Face Match: ${res.face_match_confidence}, Status: ${res.status})`, 'ok');
      await refreshMe();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleToggleAvailability = async (next: 'AVAILABLE' | 'OFFLINE') => {
    try {
      await apiRequest('/v1/providers/me/availability', {
        method: 'PATCH',
        token,
        body: { availability_state: next, lat: 27.6308, lng: 85.5205 },
      });
      notify(`Availability switched to ${next}`, 'ok');
      await refreshMe();
    } catch (err: any) {
      notify(err.message, err.status === 428 ? 'warn' : 'danger');
    }
  };

  const handleCompleteRandomSelfie = async () => {
    if (!me?.pending_selfie_check?.id) return;
    try {
      const liveness = await apiRequest('/v1/providers/kyc/liveness-session', {
        method: 'POST',
        token,
        body: { purpose: 'RANDOM_SELFIE_RECHECK' },
      });
      await apiRequest('/v1/providers/kyc/random-selfie/complete', {
        method: 'POST',
        token,
        body: {
          check_id: me.pending_selfie_check.id,
          azure_liveness_session_id: liveness.session_id,
          selfie_blob_path: liveness.upload_urls.selfie_sas,
          simulated_face_score: 0.95,
        },
      });
      notify('Random selfie liveness verified! You may now go AVAILABLE.', 'ok');
      await refreshMe();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handlePlaceBid = async (bookingId: string) => {
    try {
      const bid = await apiRequest(`/v1/bookings/${bookingId}/bids`, {
        method: 'POST',
        token,
        body: {
          quoted_labor_npr: Number(bidAmount),
          estimated_arrival_min: Number(bidEta),
          estimated_duration_min: 75,
          parts_included: false,
          notes: bidNotes,
        },
      });
      notify(`Bid submitted (Rs ${bid.quoted_labor_npr}, edits used: ${bid.edit_count}/1)`, 'ok');
      await loadAll();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleStatusUpdate = async (bookingId: string, toStatus: string, nearCustomerGps = false) => {
    try {
      const res = await apiRequest(`/v1/bookings/${bookingId}/status`, {
        method: 'POST',
        token,
        idempotencyKey: `st-${bookingId}-${toStatus}-${Date.now()}`,
        body: {
          to_status: toStatus,
          lat: nearCustomerGps ? 27.6299 : 27.6305,
          lng: nearCustomerGps ? 85.5215 : 85.5208,
          cancellation_reason: toStatus === 'CANCELLED' ? 'Customer requested offline deal test' : undefined,
        },
      });
      notify(
        res.anti_leakage_flagged
          ? `Status -> ${toStatus} (ANTI-LEAKAGE FLAG TRIGGERED: ${Math.round(res.distance_meters)}m from customer!)`
          : `Job status updated to ${toStatus}`,
        res.anti_leakage_flagged ? 'warn' : 'ok'
      );
      await loadAll();
      await refreshMe();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleProposeChangeOrder = async (bookingId: string) => {
    try {
      await apiRequest(`/v1/bookings/${bookingId}/change-orders`, {
        method: 'POST',
        token,
        body: {
          reason: coReason,
          additional_labor_npr: Number(coLabor),
          spare_parts_items: [
            { name: coPartName, qty: 1, mrp_unit_npr: Number(coPartMrp), receipt_blob_path: 'receipts/valve-mrp.jpg' },
          ],
        },
      });
      notify('Change Order pushed to homeowner for explicit approval!', 'ok');
      await loadAll();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleFloatTopUp = async () => {
    try {
      const res = await apiRequest('/v1/providers/me/float/topup', {
        method: 'POST',
        token,
        idempotencyKey: `topup-${Date.now()}`,
        body: { amount_npr: 500 },
      });
      notify(`Commission Float topped up! Current Float: Rs ${res.currentFloatNpr}`, 'ok');
      await refreshMe();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handlePayout = async (cadence: 'INSTANT_2H' | 'SAME_DAY_BATCH' | 'WEEKLY_BANK') => {
    try {
      const res = await apiRequest('/v1/providers/me/payouts', {
        method: 'POST',
        token,
        idempotencyKey: `payout-${cadence}-${Date.now()}`,
        body: { cadence, amount_npr: 500, destination_rail: cadence === 'WEEKLY_BANK' ? 'BANK' : 'ESEWA' },
      });
      notify(
        `Payout ${res.payout.status}: Gross Rs ${res.payout.gross_amount_npr}, Fee Rs ${res.payout.instant_fee_npr}, Net Rs ${res.payout.net_disbursed_npr}`,
        'ok'
      );
      await loadAll();
      await refreshMe();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  return (
    <div>
      <div className="kpi-strip">
        <div className="kpi-box">
          <div className="kpi-label">KYC &amp; Tier</div>
          <div className="kpi-value" id="provider-kyc-tier">
            {me?.kyc_status || 'N/A'} · {me?.tier_code || 'TRAINEE'}
          </div>
        </div>
        <div className="kpi-box">
          <div className="kpi-label">Visibility Score</div>
          <div className="kpi-value" id="provider-visibility-score">{me?.visibility_score ?? '—'} / 100</div>
        </div>
        <div className="kpi-box">
          <div className="kpi-label">Cash Commission Float</div>
          <div className="kpi-value" id="provider-float-balance">
            Rs {Number(me?.current_float_npr ?? 0).toFixed(0)} {me?.is_cash_paused ? '(PAUSED)' : ''}
          </div>
        </div>
        <div className="kpi-box">
          <div className="kpi-label">Withdrawable Payable</div>
          <div className="kpi-value" id="provider-payable-balance">Rs {Number(me?.payable_balance_npr ?? 0).toFixed(0)}</div>
        </div>
      </div>

      {/* Random Selfie Re-Check Gate Banner (SOP-01 / L12) */}
      {me?.pending_selfie_check && (
        <div className="alert-banner alert-warn" id="random-selfie-banner">
          <strong>Periodic Biometric Selfie Re-Check Required</strong> (Reason: {me.pending_selfie_check.trigger_reason}).
          You must complete active liveness verification before going AVAILABLE.
          <div className="btn-group">
            <button id="complete-random-selfie-btn" type="button" className="btn btn-primary btn-sm" onClick={handleCompleteRandomSelfie}>
              Complete Active Liveness Selfie Now
            </button>
          </div>
        </div>
      )}

      <div className="grid-2">
        {/* Left: Biometric KYC / Availability / Live Bidding Hub */}
        <div className="item-list">
          <section className="surface-card">
            <div className="section-header">
              <h2>Availability &amp; Financial Controls</h2>
              <span className={`badge ${me?.availability_state === 'AVAILABLE' ? 'badge-ok' : 'badge-warn'}`}>
                {me?.availability_state || 'OFFLINE'}
              </span>
            </div>
            <div className="btn-group">
              <button id="provider-go-available-btn" type="button" className="btn btn-primary btn-sm" onClick={() => handleToggleAvailability('AVAILABLE')}>
                Go AVAILABLE
              </button>
              <button id="provider-go-offline-btn" type="button" className="btn btn-secondary btn-sm" onClick={() => handleToggleAvailability('OFFLINE')}>
                Go OFFLINE
              </button>
              <button id="provider-topup-float-btn" type="button" className="btn btn-secondary btn-sm" onClick={handleFloatTopUp}>
                Top-Up Float (+Rs 500)
              </button>
              <button id="provider-instant-payout-btn" type="button" className="btn btn-accent btn-sm" onClick={() => handlePayout('INSTANT_2H')}>
                Instant 2h Payout (Rs 500, Fee Rs 25)
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => handlePayout('SAME_DAY_BATCH')}>
                Free 11AM/5PM Batch
              </button>
            </div>
          </section>

          {/* Biometric KYC Onboarding Panel */}
          {me?.kyc_status !== 'VERIFIED_ACTIVE' && (
            <section className="surface-card" id="kyc-onboarding-panel">
              <h2>Biometric KYC + Mandatory Bank/eSewa Linking</h2>
              <p style={{ fontSize: '0.84rem', color: 'var(--ink-secondary)' }}>
                Upload Nepali Citizenship (Nagarikta) or National ID, complete Azure AI Vision Active Liveness, and link Bank/eSewa before activation.
              </p>
              <form className="form-stack" onSubmit={handleSubmitKyc}>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="kyc-doc-type">Government ID Type</label>
                    <select id="kyc-doc-type" value={docType} onChange={(e) => setDocType(e.target.value as any)}>
                      <option value="CITIZENSHIP_NAGARIKTA">Citizenship (Nagarikta)</option>
                      <option value="NATIONAL_ID_RASTRIYA">National ID (Rastriya Parichayapatra)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="kyc-doc-num">ID Number</label>
                    <input id="kyc-doc-num" value={docNum} onChange={(e) => setDocNum(e.target.value)} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="kyc-bank-name">Linked Bank</label>
                    <input id="kyc-bank-name" value={bankName} onChange={(e) => setBankName(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="kyc-bank-acct">Account Number</label>
                    <input id="kyc-bank-acct" value={bankAcct} onChange={(e) => setBankAcct(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="kyc-esewa-id">eSewa Wallet ID</label>
                    <input id="kyc-esewa-id" value={esewaId} onChange={(e) => setEsewaId(e.target.value)} />
                  </div>
                </div>
                <button id="submit-kyc-btn" type="submit" className="btn btn-primary">
                  Verify Liveness &amp; Submit KYC
                </button>
              </form>
            </section>
          )}

          {/* Open Live Bidding Feed (Location Masked!) */}
          <section className="surface-card">
            <div className="section-header">
              <h2>Live Bidding Hub (Privacy-Masked Locations)</h2>
              <button type="button" className="btn btn-secondary btn-sm" onClick={loadAll}>Refresh</button>
            </div>
            <div className="form-row" style={{ marginBottom: '0.75rem' }}>
              <div className="field">
                <label htmlFor="bid-amount-input">Your Labor Bid (NPR)</label>
                <input id="bid-amount-input" type="number" value={bidAmount} onChange={(e) => setBidAmount(Number(e.target.value))} />
              </div>
              <div className="field">
                <label htmlFor="bid-eta-input">ETA (mins)</label>
                <input id="bid-eta-input" type="number" value={bidEta} onChange={(e) => setBidEta(Number(e.target.value))} />
              </div>
            </div>
            <div className="item-list">
              {openBids.length === 0 && <p style={{ color: 'var(--ink-muted)' }}>No open bidding requests right now.</p>}
              {openBids.map((b) => (
                <div key={b.id} className="booking-item open-bid-card" data-booking-id={b.id}>
                  <div className="section-header" style={{ marginBottom: '0.2rem' }}>
                    <strong>{b.booking_code} · {b.sku_title || b.category_name}</strong>
                    <span className="badge badge-warn">Area: {b.tole_neighborhood}</span>
                  </div>
                  <p style={{ fontSize: '0.84rem', margin: '0.25rem 0' }}>{b.issue_description}</p>
                  <div className="meta-row">
                    <span>Address Masked: <strong>{b.address_privacy_masked ? 'YES (Exact pin hidden)' : 'NO'}</strong></span>
                    <span>Mode: {b.payment_method}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-accent btn-sm submit-bid-btn"
                    onClick={() => handlePlaceBid(b.id)}
                  >
                    Submit / Update Bid (Rs {bidAmount})
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Right: Assigned Jobs Execution, Change Orders, Automated Calendar & Payouts */}
        <div className="item-list">
          <section className="surface-card">
            <div className="section-header">
              <h2>My Assigned Jobs (Exact Address Unlocked)</h2>
              <span className="badge badge-info">{assigned.length} jobs</span>
            </div>
            <div className="item-list">
              {assigned.length === 0 && <p style={{ color: 'var(--ink-muted)' }}>No assigned jobs yet.</p>}
              {assigned.map((b) => (
                <div key={b.id} className="booking-item assigned-job-card" data-booking-code={b.booking_code}>
                  <div className="section-header" style={{ marginBottom: '0.2rem' }}>
                    <strong>{b.booking_code} · {b.customer_name}</strong>
                    <span className="badge badge-info">{b.status}</span>
                  </div>
                  <div className="meta-row">
                    <span>Unlocked Address: <strong>{b.exact_address_line}</strong></span>
                    <span>Total: Rs {Number(b.final_total_npr)}</span>
                  </div>
                  <div className="btn-group">
                    {b.status === 'SCHEDULED_LOCKED' && (
                      <button type="button" className="btn btn-primary btn-sm en-route-btn" onClick={() => handleStatusUpdate(b.id, 'EN_ROUTE')}>
                        Mark En Route (GPS On)
                      </button>
                    )}
                    {b.status === 'EN_ROUTE' && (
                      <button type="button" className="btn btn-primary btn-sm arrived-btn" onClick={() => handleStatusUpdate(b.id, 'ARRIVED', true)}>
                        Check-In Arrived
                      </button>
                    )}
                    {b.status === 'ARRIVED' && (
                      <button type="button" className="btn btn-primary btn-sm start-work-btn" onClick={() => handleStatusUpdate(b.id, 'IN_PROGRESS', true)}>
                        Start Work
                      </button>
                    )}
                    {b.status === 'IN_PROGRESS' && (
                      <>
                        <button type="button" className="btn btn-secondary btn-sm propose-co-btn" onClick={() => handleProposeChangeOrder(b.id)}>
                          Propose Change Order (+Rs {coLabor} Labor + Rs {coPartMrp} MRP Parts)
                        </button>
                        <button type="button" className="btn btn-accent btn-sm complete-job-btn" onClick={() => handleStatusUpdate(b.id, 'COMPLETED_PENDING_CONFIRM', true)}>
                          Complete Job
                        </button>
                      </>
                    )}
                    {['SCHEDULED_LOCKED', 'EN_ROUTE'].includes(b.status) && (
                      <button type="button" className="btn btn-danger btn-sm cancel-near-btn" onClick={() => handleStatusUpdate(b.id, 'CANCELLED', true)}>
                        Cancel Near Site (Anti-Leakage Test)
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="surface-card">
            <h2>Automated Calendar (GiST Conflict-Locked Slots)</h2>
            {calendar.length === 0 ? (
              <p style={{ color: 'var(--ink-muted)', fontSize: '0.85rem' }}>No locked slots yet.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Booking</th>
                    <th>Window (+15m Buffer)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {calendar.map((c) => (
                    <tr key={c.id}>
                      <td>{c.booking_code}</td>
                      <td>{new Date(c.start_at).toLocaleTimeString()} – {new Date(c.end_at).toLocaleTimeString()}</td>
                      <td><span className={`badge ${c.status === 'LOCKED' ? 'badge-ok' : 'badge-info'}`}>{c.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="surface-card">
            <h2>Recent Payout History</h2>
            {payouts.length === 0 ? (
              <p style={{ color: 'var(--ink-muted)', fontSize: '0.85rem' }}>No payouts requested yet.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Cadence</th>
                    <th>Rail</th>
                    <th>Net Disbursed</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id}>
                      <td>{p.cadence}</td>
                      <td>{p.destination_rail}</td>
                      <td>Rs {Number(p.net_disbursed_npr).toFixed(0)}</td>
                      <td><span className="badge badge-ok">{p.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
