import React, { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';

interface Props {
  token: string | null;
  me: any;
  notify: (msg: string, tone?: 'ok' | 'danger' | 'warn') => void;
}

const ADMIN_ROLES = ['OPS_DISPATCHER', 'KYC_REVIEWER', 'FINANCE_ADMIN', 'GRIEVANCE_OFFICER', 'SUPER_ADMIN'];

export const AdminOpsPortal: React.FC<Props> = ({ token, me, notify }) => {
  const [kycQueue, setKycQueue] = useState<any[]>([]);
  const [cmd, setCmd] = useState<any | null>(null);
  const isAdmin = Boolean(me?.roles?.some((r: string) => ADMIN_ROLES.includes(r)));

  const loadAdmin = async () => {
    if (!token || !isAdmin) return;
    try {
      const [k, c] = await Promise.all([
        apiRequest('/v1/admin/kyc/queue', { token }),
        apiRequest('/v1/admin/command-center', { token }),
      ]);
      setKycQueue(k.items || []);
      setCmd(c);
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  useEffect(() => {
    loadAdmin();
  }, [token, isAdmin]);

  const handleReviewKyc = async (kycId: string, decision: 'VERIFIED_ACTIVE' | 'REJECTED_RESUBMIT') => {
    try {
      await apiRequest(`/v1/admin/kyc/${kycId}/review`, {
        method: 'POST',
        token,
        body: { decision, academy_skill_score: 88, reason: decision === 'REJECTED_RESUBMIT' ? 'Blurry ID back photo' : undefined },
      });
      notify(`KYC marked ${decision}`, 'ok');
      await loadAdmin();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleTriggerSelfie = async (providerId: string) => {
    try {
      await apiRequest(`/v1/admin/providers/${providerId}/trigger-random-selfie`, {
        method: 'POST',
        token,
        body: { trigger_reason: 'PERIODIC_14D' },
      });
      notify('Random biometric selfie re-check triggered; provider set OFFLINE.', 'warn');
      await loadAdmin();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleAckSos = async (sosId: string, status: 'ACKNOWLEDGED' | 'RESOLVED') => {
    try {
      await apiRequest(`/v1/admin/sos/${sosId}/acknowledge`, {
        method: 'POST',
        token,
        body: { status, resolution_notes: 'Safety officer verified caller safe via ACS bridge' },
      });
      notify(`SOS ${status}`, 'ok');
      await loadAdmin();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleResolveDispute = async (disputeId: string) => {
    try {
      await apiRequest(`/v1/admin/disputes/${disputeId}/resolve`, {
        method: 'POST',
        token,
        body: {
          outcome: 'RESOLVED_PARTIAL_ADJUSTMENT',
          refund_amount_npr: 200,
          resolution_notes: 'Verified via before/after photos and chat log; partial adjustment issued.',
        },
      });
      notify('Dispute resolved & Escrow unfrozen.', 'ok');
      await loadAdmin();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleDispatchWarranty = async (claimId: string) => {
    try {
      await apiRequest(`/v1/admin/warranty-claims/${claimId}/dispatch-refix`, {
        method: 'POST',
        token,
        body: { refix_hourly_payout_npr: 450 },
      });
      notify('Free warranty re-fix dispatched (technician paid Rs 450/hr from warranty reserve).', 'ok');
      await loadAdmin();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleExecutePrivacyDelete = async (reqId: string) => {
    try {
      await apiRequest(`/v1/admin/privacy-deletions/${reqId}/execute`, {
        method: 'POST',
        token,
      });
      notify('PII scrubbed/anonymized while statutory VAT/ledger records preserved.', 'ok');
      await loadAdmin();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const activeSos = (cmd?.sos_events || []).filter((s: any) => s.status === 'ACTIVE_P0');

  return (
    <div>
      {activeSos.length > 0 && (
        <div className="alert-banner alert-danger" id="admin-sos-alert-banner">
          <strong>PRIORITY-0 SOS EMERGENCY ACTIVE ({activeSos.length})!</strong>
          {activeSos.map((s: any) => (
            <div key={s.id} style={{ marginTop: '0.4rem' }}>
              Booking {s.booking_code} · Caller: {s.triggered_by_name} · GPS ({Number(s.lat).toFixed(4)}, {Number(s.lng).toFixed(4)}) · ACS Bridge: {s.acs_bridge_call_id}
              <div className="btn-group">
                <button type="button" className="btn btn-primary btn-sm ack-sos-btn" onClick={() => handleAckSos(s.id, 'ACKNOWLEDGED')}>
                  Acknowledge (&lt;60s SLA)
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleAckSos(s.id, 'RESOLVED')}>
                  Mark Resolved
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="kpi-strip">
        <div className="kpi-box">
          <div className="kpi-label">Double-Entry Ledger</div>
          <div className="kpi-value" id="ledger-integrity-status">
            {cmd?.ledger_integrity?.is_balanced ? 'BALANCED ✓' : 'CHECK'}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted)' }}>
            Debits Rs {cmd?.ledger_integrity?.total_debits_npr ?? 0} = Credits Rs {cmd?.ledger_integrity?.total_credits_npr ?? 0}
          </div>
        </div>
        <div className="kpi-box">
          <div className="kpi-label">KYC Queue</div>
          <div className="kpi-value">{kycQueue.length}</div>
        </div>
        <div className="kpi-box">
          <div className="kpi-label">Anti-Leakage Flags</div>
          <div className="kpi-value" id="admin-antileakage-count">{cmd?.anti_leakage_flags?.length ?? 0}</div>
        </div>
        <div className="kpi-box">
          <div className="kpi-label">Disputes &amp; Warranties</div>
          <div className="kpi-value">
            {(cmd?.disputes?.length ?? 0)} / {(cmd?.warranty_claims?.length ?? 0)}
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* Biometric KYC Queue */}
        <section className="surface-card">
          <div className="section-header">
            <h2>Biometric KYC &amp; Onboarding Review Queue</h2>
            <button type="button" className="btn btn-secondary btn-sm" onClick={loadAdmin}>Refresh</button>
          </div>
          {kycQueue.length === 0 ? (
            <p style={{ color: 'var(--ink-muted)' }}>No KYC submissions yet.</p>
          ) : (
            <div className="item-list">
              {kycQueue.map((k) => (
                <div key={k.id} className="booking-item kyc-review-card">
                  <div className="section-header" style={{ marginBottom: '0.2rem' }}>
                    <strong>{k.full_name} ({k.primary_city})</strong>
                    <span className={`badge ${k.status === 'VERIFIED_ACTIVE' ? 'badge-ok' : 'badge-warn'}`}>{k.status}</span>
                  </div>
                  <div className="meta-row">
                    <span>{k.document_type}: {k.document_number}</span>
                    <span>Face Score: <strong>{k.face_match_confidence}</strong></span>
                    <span>Bank/eSewa: <strong>{k.financial_account_verified ? 'Linked ✓' : 'Missing'}</strong></span>
                  </div>
                  <div className="btn-group">
                    {k.status !== 'VERIFIED_ACTIVE' && (
                      <>
                        <button type="button" className="btn btn-primary btn-sm approve-kyc-btn" onClick={() => handleReviewKyc(k.id, 'VERIFIED_ACTIVE')}>
                          Approve &amp; Activate
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleReviewKyc(k.id, 'REJECTED_RESUBMIT')}>
                          Reject
                        </button>
                      </>
                    )}
                    {k.status === 'VERIFIED_ACTIVE' && (
                      <button type="button" className="btn btn-secondary btn-sm trigger-selfie-btn" onClick={() => handleTriggerSelfie(k.provider_user_id)}>
                        Trigger Random Selfie Check
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Anti-Leakage & 48h Disputes & Warranty QA */}
        <div className="item-list">
          <section className="surface-card">
            <h2>Anti-Leakage Anomaly Monitor (GPS &le; 300m)</h2>
            {(cmd?.anti_leakage_flags || []).length === 0 ? (
              <p style={{ color: 'var(--ink-muted)', fontSize: '0.85rem' }}>No leakage anomalies detected.</p>
            ) : (
              <div className="item-list">
                {cmd.anti_leakage_flags.map((f: any) => (
                  <div key={f.id} className="booking-item antileakage-flag-item">
                    <strong>{f.flag_type}</strong> · {f.provider_name} ({f.booking_code || 'N/A'})
                    <div className="meta-row">
                      <span>Distance to Customer Pin: <strong>{f.min_distance_to_customer_m ?? 'N/A'}m</strong></span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="surface-card">
            <h2>48h Disputes (Escrow Frozen) &amp; 30-Day Warranty QA</h2>
            {(cmd?.disputes || []).map((d: any) => (
              <div key={d.id} className="booking-item dispute-card">
                <div className="section-header" style={{ marginBottom: '0.2rem' }}>
                  <strong>Dispute · {d.booking_code} ({d.category})</strong>
                  <span className={`badge ${d.status === 'OPEN_ESCROW_FROZEN' ? 'badge-danger' : 'badge-ok'}`}>{d.status}</span>
                </div>
                <p style={{ fontSize: '0.84rem', margin: '0.25rem 0' }}>{d.description}</p>
                {d.status === 'OPEN_ESCROW_FROZEN' && (
                  <button type="button" className="btn btn-primary btn-sm resolve-dispute-btn" onClick={() => handleResolveDispute(d.id)}>
                    Resolve Dispute &amp; Settle
                  </button>
                )}
              </div>
            ))}

            {(cmd?.warranty_claims || []).map((w: any) => (
              <div key={w.id} className="booking-item warranty-card" style={{ marginTop: '0.5rem' }}>
                <div className="section-header" style={{ marginBottom: '0.2rem' }}>
                  <strong>30d Warranty · {w.booking_code}</strong>
                  <span className="badge badge-warn">{w.status}</span>
                </div>
                <p style={{ fontSize: '0.84rem', margin: '0.25rem 0' }}>{w.issue_description}</p>
                {w.status === 'SUBMITTED' && (
                  <button type="button" className="btn btn-accent btn-sm dispatch-warranty-btn" onClick={() => handleDispatchWarranty(w.id)}>
                    Dispatch Free Re-Fix (Rs 450/hr)
                  </button>
                )}
              </div>
            ))}
          </section>

          <section className="surface-card">
            <h2>7-Day Privacy Deletion Queue</h2>
            {(cmd?.privacy_deletions || []).length === 0 ? (
              <p style={{ color: 'var(--ink-muted)', fontSize: '0.85rem' }}>No pending PII deletion requests.</p>
            ) : (
              cmd.privacy_deletions.map((p: any) => (
                <div key={p.id} className="booking-item">
                  <strong>{p.full_name}</strong> — <span className="badge badge-warn">{p.status}</span>
                  {p.status === 'REQUESTED' && (
                    <div className="btn-group">
                      <button type="button" className="btn btn-danger btn-sm execute-privacy-btn" onClick={() => handleExecutePrivacyDelete(p.id)}>
                        Execute PII Anonymization
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
