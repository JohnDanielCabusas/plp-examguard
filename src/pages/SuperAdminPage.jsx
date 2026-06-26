import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── tiny helpers ────────────────────────────────────────────────
function EyeToggle({ show, onToggle }) {
  return (
    <button type="button" onClick={onToggle} tabIndex={-1}
      style={{ position:'absolute', right:'8px', top:'50%', transform:'translateY(-50%)',
               background:'none', border:'none', cursor:'pointer', padding:0, color:'#666' }}>
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {show ? (
          <>
            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
            <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </>
        ) : (
          <>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </>
        )}
      </svg>
    </button>
  );
}

function Toast({ message, type, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);
  const bg = type === 'error' ? '#dc2626' : type === 'warning' ? '#d97706' : '#16a34a';
  return (
    <div style={{ position:'fixed', bottom:'24px', right:'24px', background:bg, color:'#fff',
                  padding:'12px 20px', borderRadius:'10px', fontSize:'13px', fontWeight:600,
                  boxShadow:'0 4px 16px rgba(0,0,0,0.2)', zIndex:99999, maxWidth:'320px' }}>
      {message}
    </div>
  );
}

// ── nav icons ───────────────────────────────────────────────────
const ICONS = {
  dashboard: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  professors: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  settings:   <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  signout:    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
};

// ── stat card ───────────────────────────────────────────────────
function StatCard({ label, value, icon, color }) {
  return (
    <div style={{ background:'#fff', borderRadius:'14px', padding:'20px 24px',
                  boxShadow:'0 1px 4px rgba(0,0,0,0.08)', display:'flex',
                  alignItems:'center', gap:'16px' }}>
      <div style={{ width:'48px', height:'48px', borderRadius:'12px', background:color,
                    display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
             fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
             dangerouslySetInnerHTML={{ __html: icon }} />
      </div>
      <div>
        <div style={{ fontSize:'28px', fontWeight:800, color:'var(--primary)', lineHeight:1 }}>{value}</div>
        <div style={{ fontSize:'12px', color:'var(--text-muted)', marginTop:'3px', fontWeight:600 }}>{label}</div>
      </div>
    </div>
  );
}

// ── confirm dialog ──────────────────────────────────────────────
function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:9999,
                  display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'#fff', borderRadius:'16px', padding:'28px 28px 20px',
                    maxWidth:'380px', width:'90%', boxShadow:'0 8px 32px rgba(0,0,0,0.18)' }}>
        <div style={{ fontSize:'15px', fontWeight:600, color:'#1f2937', marginBottom:'20px', lineHeight:1.5 }}>
          {message}
        </div>
        <div style={{ display:'flex', gap:'10px', justifyContent:'flex-end' }}>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── professor modal ─────────────────────────────────────────────
function ProfessorModal({ professor, onSave, onClose }) {
  const nameRef = useRef();
  const usernameRef = useRef();
  const emailRef = useRef();
  const passRef = useRef();
  const [error, setError] = useState('');
  const [showPass, setShowPass] = useState(false);
  const isEdit = !!professor;

  const handleSave = () => {
    const name = (nameRef.current?.value || '').trim();
    const username = (usernameRef.current?.value || '').trim().toLowerCase();
    const email = (emailRef.current?.value || '').trim().toLowerCase();
    const password = passRef.current?.value || '';

    setError('');
    if (!name) { setError('Full name is required.'); return; }
    if (!username) { setError('Username is required.'); return; }
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) {
      setError('Username must be 3–30 characters (letters, numbers, _ . -).');
      return;
    }
    if (!isEdit && !password) { setError('Password is required.'); return; }
    if (password && password.length < 6) { setError('Password must be at least 6 characters.'); return; }

    const data = { name, username, email };
    if (password) data.password = password;
    onSave(data);
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:9999,
                  display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'#fff', borderRadius:'16px', width:'90%', maxWidth:'440px',
                    boxShadow:'0 8px 32px rgba(0,0,0,0.18)', overflow:'hidden' }}>
        <div style={{ padding:'20px 24px', borderBottom:'1px solid #f3f4f6', display:'flex',
                      alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontWeight:700, fontSize:'16px', color:'var(--primary)' }}>
            {isEdit ? 'Edit Professor' : 'Add Professor'}
          </span>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer',
                                              fontSize:'20px', color:'#9ca3af', lineHeight:1 }}>&#10005;</button>
        </div>
        <div style={{ padding:'20px 24px' }}>
          <div className="form-group">
            <label>Full Name *</label>
            <input ref={nameRef} type="text" className="form-control" placeholder="e.g. Dr. Maria Santos"
                   defaultValue={professor?.name || ''} autoFocus />
          </div>
          <div className="form-group">
            <label>Username *</label>
            <input ref={usernameRef} type="text" className="form-control" placeholder="e.g. msantos"
                   defaultValue={professor?.username || ''} />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input ref={emailRef} type="email" className="form-control" placeholder="professor@plpasig.edu.ph"
                   defaultValue={professor?.email || ''} />
          </div>
          <div className="form-group">
            <label>{isEdit ? 'New Password' : 'Password *'} {isEdit && <span style={{ fontWeight:400, color:'#9ca3af' }}>(leave blank to keep current)</span>}</label>
            <div style={{ position:'relative' }}>
              <input ref={passRef} type={showPass ? 'text' : 'password'} className="form-control"
                     placeholder="Minimum 6 characters" style={{ paddingRight:'42px' }}
                     onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }} />
              <EyeToggle show={showPass} onToggle={() => setShowPass(v => !v)} />
            </div>
          </div>
          {error && <div className="text-danger mb-12" style={{ fontSize:'13px' }}>{error}</div>}
        </div>
        <div style={{ padding:'12px 24px 20px', display:'flex', gap:'10px', justifyContent:'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>
            {isEdit ? 'Save Changes' : 'Add Professor'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── main page ───────────────────────────────────────────────────
export default function SuperAdminPage() {
  const [ready, setReady] = useState(false);
  const [section, setSection] = useState('dashboard');
  const [professors, setProfessors] = useState([]);
  const [stats, setStats] = useState({ professors: 0, students: 0, exams: 0, subjects: 0 });
  const [toast, setToast] = useState(null);
  const [confirm, setConfirm] = useState(null); // { message, onConfirm }
  const [profModal, setProfModal] = useState(null); // null | { professor?: obj }
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // settings tab
  const curPassRef = useRef();
  const newPassRef = useRef();
  const confirmPassRef = useRef();
  const [settingsError, setSettingsError] = useState('');
  const [settingsSuccess, setSettingsSuccess] = useState('');
  const [showCurPass, setShowCurPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);

  const readyRef = useRef(false);
  const sessionRef = useRef(null);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type, key: Date.now() });
  }, []);

  const loadData = useCallback(() => {
    const profs = window.DB?.getAdmins?.() || [];
    const students = window.DB?.getStudents?.() || [];
    const exams = window.DB?.getExams?.() || [];
    const subjects = window.DB?.getSubjects?.() || [];
    setProfessors(profs);
    setStats({
      professors: profs.length,
      students: students.length,
      exams: exams.length,
      subjects: subjects.length,
    });
  }, []);

  useEffect(() => {
    const boot = () => {
      if (readyRef.current) return;
      readyRef.current = true;

      const session = window.Auth?.getSysAdminSession?.();
      if (!session) { window.location.replace('index.html'); return; }
      sessionRef.current = session;

      setReady(true);
      loadData();

      document.getElementById('fb-loading')?.setAttribute('style', 'display:none');
    };

    document.addEventListener('dbReady', boot);
    setTimeout(() => {
      if (!readyRef.current) {
        document.dispatchEvent(new Event('dbReady'));
      }
    }, 1200);
    window.SupabaseSync?.init?.();

    return () => document.removeEventListener('dbReady', boot);
  }, [loadData]);

  const doLogout = async () => {
    setConfirm({
      message: 'Sign out of ExamGuard Admin?',
      onConfirm: () => {
        setConfirm(null);
        window.Auth?.clearSysAdminSession?.();
        window.location.replace('index.html');
      },
    });
  };

  const navTo = (sec) => {
    setSection(sec);
    setSidebarOpen(false);
  };

  // ── Professor CRUD ──────────────────────────────────────────
  const openAddProfessor = () => setProfModal({ professor: null });
  const openEditProfessor = (prof) => setProfModal({ professor: prof });

  const saveProfessor = (data) => {
    const existing = profModal?.professor;
    if (existing) {
      window.DB.updateAdmin(existing.id, data);
      showToast('Professor updated successfully.');
    } else {
      const result = window.DB.addProfessor(data);
      if (!result.success) { showToast(result.message, 'error'); return; }
      showToast('Professor added successfully.');
    }
    setProfModal(null);
    loadData();
  };

  const confirmDeleteProfessor = (prof) => {
    setConfirm({
      message: `Delete professor "${prof.name}" (@${prof.username})? This cannot be undone.`,
      onConfirm: () => {
        window.DB.deleteProfessor(prof.id);
        setConfirm(null);
        showToast('Professor deleted.');
        loadData();
      },
    });
  };

  // ── Change password ─────────────────────────────────────────
  const changePassword = () => {
    const cur = curPassRef.current?.value || '';
    const next = newPassRef.current?.value || '';
    const confirm = confirmPassRef.current?.value || '';
    setSettingsError('');
    setSettingsSuccess('');

    const sysAdmin = window.DB?.getSysAdmin?.();
    if (!sysAdmin || sysAdmin.password !== cur) { setSettingsError('Current password is incorrect.'); return; }
    if (next.length < 6) { setSettingsError('New password must be at least 6 characters.'); return; }
    if (next !== confirm) { setSettingsError('Passwords do not match.'); return; }

    window.DB.updateSysAdmin({ password: next });
    if (curPassRef.current) curPassRef.current.value = '';
    if (newPassRef.current) newPassRef.current.value = '';
    if (confirmPassRef.current) confirmPassRef.current.value = '';
    setSettingsSuccess('Password updated successfully.');
  };

  // ── date/time ───────────────────────────────────────────────
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);
  const dateStr = now.toLocaleDateString('en-PH', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const session = sessionRef.current;

  // ── render ──────────────────────────────────────────────────
  return (
    <>
      <style>{`@keyframes _fbspin{to{transform:rotate(360deg)}}`}</style>

      {/* Loading overlay */}
      <div id="fb-loading" style={{ position:'fixed', inset:0, background:'rgba(255,255,255,0.97)',
                                     display:'flex', flexDirection:'column', alignItems:'center',
                                     justifyContent:'center', zIndex:99999, gap:'14px' }}>
        <div style={{ width:'36px', height:'36px', border:'3px solid #e5e7eb', borderTopColor:'#1a4d2a',
                      borderRadius:'50%', animation:'_fbspin 0.75s linear infinite' }} />
        <p style={{ color:'#6b7280', fontSize:'13px', fontFamily:'sans-serif', margin:0 }}>Connecting to server&hellip;</p>
      </div>

      {toast && <Toast key={toast.key} message={toast.message} type={toast.type} onDone={() => setToast(null)} />}
      {confirm && <ConfirmDialog message={confirm.message} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />}
      {profModal && <ProfessorModal professor={profModal.professor} onSave={saveProfessor} onClose={() => setProfModal(null)} />}

      {/* Mobile overlay */}
      {sidebarOpen && <div onClick={() => setSidebarOpen(false)}
        style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:998 }} />}

      {ready && (
        <div className="admin-layout">
          {/* SIDEBAR */}
          <aside className="sidebar" id="sidebar" style={sidebarOpen ? { transform:'translateX(0)', zIndex:999 } : {}}>
            <div className="sidebar-brand">
              <div className="sidebar-brand-icon">
                <img src="/plp-logo.png" alt="PLP" style={{ width:'40px', height:'40px', objectFit:'contain' }} />
              </div>
              <div className="sidebar-brand-text">
                <h2>PLP ExamGuard</h2>
                <p>System Admin</p>
              </div>
            </div>

            <nav className="sidebar-nav">
              <div className="nav-section-label">Overview</div>
              <div className={`nav-item${section === 'dashboard' ? ' active' : ''}`} onClick={() => navTo('dashboard')}>
                <span className="nav-icon">{ICONS.dashboard}</span>
                <span className="nav-item-label">Dashboard</span>
              </div>
              <div className="nav-section-label">Management</div>
              <div className={`nav-item${section === 'professors' ? ' active' : ''}`} onClick={() => navTo('professors')}>
                <span className="nav-icon">{ICONS.professors}</span>
                <span className="nav-item-label">Professors</span>
              </div>
              <div className="nav-section-label">System</div>
              <div className={`nav-item${section === 'settings' ? ' active' : ''}`} onClick={() => navTo('settings')}>
                <span className="nav-icon">{ICONS.settings}</span>
                <span className="nav-item-label">Settings</span>
              </div>
            </nav>

            <div className="sidebar-footer">
              <button className="sidebar-signout-btn" onClick={doLogout}>
                {ICONS.signout}
                <span className="nav-item-label">Sign Out</span>
              </button>
            </div>
          </aside>

          {/* MAIN */}
          <div className="main-content">
            <header className="topbar">
              <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
                <button className="hamburger-btn" onClick={() => setSidebarOpen(v => !v)}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="2">
                    <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
                  </svg>
                </button>
                <span className="topbar-title">
                  {section === 'dashboard' && 'Dashboard'}
                  {section === 'professors' && 'Professors'}
                  {section === 'settings' && 'Settings'}
                </span>
              </div>
              <div className="topbar-actions">
                <span style={{ fontSize:'12px', color:'var(--text-muted)' }}>{dateStr}</span>
                <div style={{ display:'flex', alignItems:'center', gap:'8px', background:'#f3f4f6',
                              borderRadius:'100px', padding:'4px 12px 4px 4px' }}>
                  <div style={{ width:'28px', height:'28px', background:'var(--accent)', borderRadius:'50%',
                                display:'flex', alignItems:'center', justifyContent:'center',
                                fontSize:'12px', fontWeight:700, color:'#fff', flexShrink:0 }}>
                    {(session?.name || 'A').charAt(0).toUpperCase()}
                  </div>
                  <span style={{ fontSize:'13px', fontWeight:600, color:'var(--primary)', whiteSpace:'nowrap' }}>
                    {session?.name || 'System Admin'}
                  </span>
                </div>
              </div>
            </header>

            <div className="content-area">

              {/* ── DASHBOARD ── */}
              {section === 'dashboard' && (
                <div>
                  <div className="section-header">
                    <div>
                      <div className="section-title">Dashboard</div>
                      <div className="section-subtitle">System overview and statistics</div>
                    </div>
                  </div>

                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))', gap:'16px', marginBottom:'28px' }}>
                    <div style={{ background:'#fff', borderRadius:'14px', padding:'20px 24px',
                                  boxShadow:'0 1px 4px rgba(0,0,0,0.08)', display:'flex',
                                  alignItems:'center', gap:'16px' }}>
                      <div style={{ width:'48px', height:'48px', borderRadius:'12px', background:'#1a4d2a',
                                    display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                      </div>
                      <div>
                        <div style={{ fontSize:'32px', fontWeight:800, color:'var(--primary)', lineHeight:1 }}>{stats.professors}</div>
                        <div style={{ fontSize:'12px', color:'var(--text-muted)', marginTop:'3px', fontWeight:600 }}>Professors</div>
                      </div>
                    </div>
                    <div style={{ background:'#fff', borderRadius:'14px', padding:'20px 24px',
                                  boxShadow:'0 1px 4px rgba(0,0,0,0.08)', display:'flex',
                                  alignItems:'center', gap:'16px' }}>
                      <div style={{ width:'48px', height:'48px', borderRadius:'12px', background:'#2563eb',
                                    display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                      </div>
                      <div>
                        <div style={{ fontSize:'32px', fontWeight:800, color:'var(--primary)', lineHeight:1 }}>{stats.students}</div>
                        <div style={{ fontSize:'12px', color:'var(--text-muted)', marginTop:'3px', fontWeight:600 }}>Students</div>
                      </div>
                    </div>
                    <div style={{ background:'#fff', borderRadius:'14px', padding:'20px 24px',
                                  boxShadow:'0 1px 4px rgba(0,0,0,0.08)', display:'flex',
                                  alignItems:'center', gap:'16px' }}>
                      <div style={{ width:'48px', height:'48px', borderRadius:'12px', background:'#7c3aed',
                                    display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                      </div>
                      <div>
                        <div style={{ fontSize:'32px', fontWeight:800, color:'var(--primary)', lineHeight:1 }}>{stats.exams}</div>
                        <div style={{ fontSize:'12px', color:'var(--text-muted)', marginTop:'3px', fontWeight:600 }}>Exams</div>
                      </div>
                    </div>
                    <div style={{ background:'#fff', borderRadius:'14px', padding:'20px 24px',
                                  boxShadow:'0 1px 4px rgba(0,0,0,0.08)', display:'flex',
                                  alignItems:'center', gap:'16px' }}>
                      <div style={{ width:'48px', height:'48px', borderRadius:'12px', background:'#0891b2',
                                    display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                      </div>
                      <div>
                        <div style={{ fontSize:'32px', fontWeight:800, color:'var(--primary)', lineHeight:1 }}>{stats.subjects}</div>
                        <div style={{ fontSize:'12px', color:'var(--text-muted)', marginTop:'3px', fontWeight:600 }}>Courses</div>
                      </div>
                    </div>
                  </div>

                  {/* Professors quick list */}
                  <div className="card">
                    <div className="card-header">
                      <span className="card-title">Professor Accounts</span>
                      <button className="btn btn-primary btn-sm" onClick={() => { navTo('professors'); openAddProfessor(); }}>
                        + Add Professor
                      </button>
                    </div>
                    <div className="card-body" style={{ padding:0 }}>
                      {professors.length === 0 ? (
                        <div className="dash-empty" style={{ padding:'32px' }}>
                          <div className="dash-empty-title">No professors yet</div>
                          <div className="dash-empty-sub">Add professors so they can access the exam management panel.</div>
                        </div>
                      ) : (
                        <div className="table-wrapper">
                          <table>
                            <thead>
                              <tr>
                                <th>Name</th>
                                <th>Username</th>
                                <th>Email</th>
                                <th style={{ textAlign:'center' }}>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {professors.map(p => (
                                <tr key={p.id}>
                                  <td style={{ fontWeight:600 }}>{p.name}</td>
                                  <td><span style={{ fontFamily:'monospace', background:'#f3f4f6', padding:'2px 8px', borderRadius:'6px', fontSize:'12px' }}>@{p.username}</span></td>
                                  <td style={{ color:'#6b7280', fontSize:'13px' }}>{p.email || '—'}</td>
                                  <td style={{ textAlign:'center' }}>
                                    <button className="btn btn-secondary btn-sm" onClick={() => { navTo('professors'); openEditProfessor(p); }}>Edit</button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ── PROFESSORS ── */}
              {section === 'professors' && (
                <div>
                  <div className="section-header">
                    <div>
                      <div className="section-title">Professors</div>
                      <div className="section-subtitle">Manage professor accounts for the exam management panel</div>
                    </div>
                    <button className="btn btn-primary" onClick={openAddProfessor}>+ Add Professor</button>
                  </div>

                  <div className="card">
                    <div className="card-body" style={{ padding:0 }}>
                      {professors.length === 0 ? (
                        <div className="dash-empty" style={{ padding:'48px' }}>
                          <div className="dash-empty-title">No professors yet</div>
                          <div className="dash-empty-sub">Create professor accounts so they can log in and manage exams.</div>
                        </div>
                      ) : (
                        <div className="table-wrapper">
                          <table>
                            <thead>
                              <tr>
                                <th>Name</th>
                                <th>Username</th>
                                <th>Email</th>
                                <th>Created</th>
                                <th style={{ textAlign:'center' }}>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {professors.map(p => (
                                <tr key={p.id}>
                                  <td>
                                    <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
                                      <div style={{ width:'34px', height:'34px', borderRadius:'50%', background:'var(--accent)',
                                                    display:'flex', alignItems:'center', justifyContent:'center',
                                                    fontSize:'13px', fontWeight:700, color:'#fff', flexShrink:0 }}>
                                        {(p.name || '?').charAt(0).toUpperCase()}
                                      </div>
                                      <span style={{ fontWeight:600 }}>{p.name}</span>
                                    </div>
                                  </td>
                                  <td><span style={{ fontFamily:'monospace', background:'#f3f4f6', padding:'2px 8px', borderRadius:'6px', fontSize:'12px' }}>@{p.username}</span></td>
                                  <td style={{ color:'#6b7280', fontSize:'13px' }}>{p.email || '—'}</td>
                                  <td style={{ color:'#9ca3af', fontSize:'12px' }}>
                                    {p.createdAt ? new Date(p.createdAt).toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' }) : '—'}
                                  </td>
                                  <td style={{ textAlign:'center' }}>
                                    <div style={{ display:'flex', gap:'6px', justifyContent:'center' }}>
                                      <button className="btn btn-secondary btn-sm" onClick={() => openEditProfessor(p)}>Edit</button>
                                      <button className="btn btn-danger btn-sm" onClick={() => confirmDeleteProfessor(p)}>Delete</button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ── SETTINGS ── */}
              {section === 'settings' && (
                <div>
                  <div className="section-header">
                    <div>
                      <div className="section-title">Settings</div>
                      <div className="section-subtitle">System administrator account settings</div>
                    </div>
                  </div>
                  <div style={{ maxWidth:'480px' }}>
                    <div className="card">
                      <div className="card-header"><span className="card-title">Change Admin Password</span></div>
                      <div className="card-body">
                        <div className="form-group">
                          <label>Current Password</label>
                          <div style={{ position:'relative' }}>
                            <input ref={curPassRef} type={showCurPass ? 'text' : 'password'} className="form-control"
                                   placeholder="Enter current password" style={{ paddingRight:'42px' }} />
                            <EyeToggle show={showCurPass} onToggle={() => setShowCurPass(v => !v)} />
                          </div>
                        </div>
                        <div className="form-group">
                          <label>New Password</label>
                          <div style={{ position:'relative' }}>
                            <input ref={newPassRef} type={showNewPass ? 'text' : 'password'} className="form-control"
                                   placeholder="Minimum 6 characters" style={{ paddingRight:'42px' }} />
                            <EyeToggle show={showNewPass} onToggle={() => setShowNewPass(v => !v)} />
                          </div>
                        </div>
                        <div className="form-group">
                          <label>Confirm New Password</label>
                          <div style={{ position:'relative' }}>
                            <input ref={confirmPassRef} type={showConfirmPass ? 'text' : 'password'} className="form-control"
                                   placeholder="Re-enter new password" style={{ paddingRight:'42px' }}
                                   onKeyDown={(e) => { if (e.key === 'Enter') changePassword(); }} />
                            <EyeToggle show={showConfirmPass} onToggle={() => setShowConfirmPass(v => !v)} />
                          </div>
                        </div>
                        {settingsError && <div className="text-danger mb-12" style={{ fontSize:'13px' }}>{settingsError}</div>}
                        {settingsSuccess && <div style={{ color:'#16a34a', fontSize:'13px', marginBottom:'12px' }}>{settingsSuccess}</div>}
                        <button className="btn btn-primary" onClick={changePassword}>Update Password</button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

            </div>{/* /content-area */}
          </div>{/* /main-content */}
        </div>
      )}
    </>
  );
}
