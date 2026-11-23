import React, { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';

interface Props {
  token: string | null;
  notify: (msg: string, tone?: 'ok' | 'danger' | 'warn') => void;
}

export const B2bProjectPortal: React.FC<Props> = ({ token, notify }) => {
  const [contracts, setContracts] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [orgName, setOrgName] = useState('Himalayan Horizon Hotel, Dhulikhel');
  const [annualFee, setAnnualFee] = useState(180000);
  const [scopeType, setScopeType] = useState<'BATHROOM' | 'KITCHEN' | 'WATERPROOFING' | 'FLAT_RENOVATION'>('BATHROOM');

  const loadData = async () => {
    if (!token) return;
    try {
      const [c, p] = await Promise.all([
        apiRequest('/v1/amc/contracts', { token }),
        apiRequest('/v1/projects', { token }),
      ]);
      setContracts(c.contracts || []);
      setProjects(p.projects || []);
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  useEffect(() => {
    loadData();
  }, [token]);

  const handleCreateAmc = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await apiRequest('/v1/amc/contracts', {
        method: 'POST',
        token,
        body: {
          client_org_name: orgName,
          covered_pillars: ['PLUMBING', 'ELECTRICAL', 'AC', 'COMPUTER', 'CLEANING'],
          annual_fee_npr: Number(annualFee),
          asset_registry: [{ asset: 'Booster Pump 3HP', qty: 2 }, { asset: 'Split AC 2T', qty: 14 }],
        },
      });
      notify(`B2B AMC Contract ${created.contract_code} activated (<2h emergency SLA)!`, 'ok');
      await loadData();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleEmergencyAmc = async (contractId: string) => {
    try {
      await apiRequest(`/v1/amc/contracts/${contractId}/emergency`, {
        method: 'POST',
        token,
        body: { issue: 'Main commercial water line pressure drop — immediate crew needed' },
      });
      notify('AMC <2-Hour Emergency Dispatch triggered! Standby Pro/Elite crew alerted.', 'warn');
      await loadData();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  const handleBookRenovation = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const prj = await apiRequest('/v1/projects', {
        method: 'POST',
        token,
        body: { scope_type: scopeType, estimated_budget_npr: 350000 },
      });
      notify(`Turnkey Renovation ${prj.project_code} booked — Free site survey within 48h + 6-Month Warranty!`, 'ok');
      await loadData();
    } catch (err: any) {
      notify(err.message, 'danger');
    }
  };

  return (
    <div className="grid-2">
      <section className="surface-card">
        <h2>B2B Annual Maintenance Contracts (AMC)</h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--ink-secondary)' }}>
          5 Core Facility Pillars (Plumbing, Electrical, Computer/IT, AC, Cleaning) under one VAT contract with scheduled preventive visits and guaranteed &lt;2-hour emergency call-outs.
        </p>
        <form className="form-stack" onSubmit={handleCreateAmc}>
          <div className="field">
            <label htmlFor="amc-org-input">Organization Name</label>
            <input id="amc-org-input" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="amc-fee-input">Annual Contract Value (NPR)</label>
            <input id="amc-fee-input" type="number" value={annualFee} onChange={(e) => setAnnualFee(Number(e.target.value))} />
          </div>
          <button id="create-amc-btn" type="submit" className="btn btn-primary">Activate B2B AMC Contract</button>
        </form>

        <div className="divider" />
        <div className="item-list">
          {contracts.map((c) => (
            <div key={c.id} className="booking-item amc-contract-card">
              <div className="section-header" style={{ marginBottom: '0.2rem' }}>
                <strong>{c.contract_code} · {c.client_org_name}</strong>
                <span className="badge badge-ok">SLA &lt;{c.emergency_sla_minutes}m</span>
              </div>
              <div className="meta-row">
                <span>Annual: Rs {Number(c.annual_fee_npr).toLocaleString()}</span>
                <span>Visits Logged: {c.visits_count}</span>
              </div>
              <button type="button" className="btn btn-danger btn-sm amc-emergency-btn" onClick={() => handleEmergencyAmc(c.id)}>
                Trigger &lt;2h Emergency Call-Out
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="surface-card">
        <h2>Sipalu Project — Turnkey Renovation (6-Month Warranty)</h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--ink-secondary)' }}>
          One contract, one dedicated Project Manager, free site survey within 48 hours, itemized BOQ, Escrow milestone billing, and 6-month workmanship warranty.
        </p>
        <form className="form-stack" onSubmit={handleBookRenovation}>
          <div className="field">
            <label htmlFor="project-scope-select">Renovation Scope</label>
            <select id="project-scope-select" value={scopeType} onChange={(e) => setScopeType(e.target.value as any)}>
              <option value="BATHROOM">Bathroom Remodelling</option>
              <option value="KITCHEN">Kitchen Renovation</option>
              <option value="WATERPROOFING">Waterproofing &amp; Seepage Fix</option>
              <option value="FLAT_RENOVATION">Full Flat Renovation</option>
            </select>
          </div>
          <button id="book-renovation-btn" type="submit" className="btn btn-accent">Book Free 48h Site Survey</button>
        </form>

        <div className="divider" />
        <div className="item-list">
          {projects.map((p) => (
            <div key={p.id} className="booking-item renovation-project-card">
              <div className="section-header" style={{ marginBottom: '0.2rem' }}>
                <strong>{p.project_code} · {p.scope_type}</strong>
                <span className="badge badge-info">{p.warranty_months}-Month Warranty</span>
              </div>
              <div className="meta-row">
                <span>Status: {p.status}</span>
                <span>Survey Due: {new Date(p.site_survey_due_at).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
