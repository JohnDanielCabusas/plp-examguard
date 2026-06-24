import React, { useState, useEffect, useRef } from 'react';

const EYE_OPEN = (
  <>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </>
);
const EYE_CLOSED = (
  <>
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </>
);

function EyeToggle({ show, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      tabIndex={-1}
      style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#666' }}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {show ? EYE_CLOSED : EYE_OPEN}
      </svg>
    </button>
  );
}

export default function LoginPage() {
  const [activeTab, setActiveTab] = useState('admin');
  const [studentStep, setStudentStep] = useState(1); // 1 | '2a' | '2b'
  const [studentEmail, setStudentEmail] = useState('');
  const [adminError, setAdminError] = useState('');
  const [step1Error, setStep1Error] = useState('');
  const [step2aError, setStep2aError] = useState('');
  const [step2bError, setStep2bError] = useState('');
  const [showAdminPass, setShowAdminPass] = useState(false);
  const [showStudentPass, setShowStudentPass] = useState(false);
  const [showSetupPass, setShowSetupPass] = useState(false);
  const [fbLoading, setFbLoading] = useState(true);
  const [settings, setSettings] = useState({
    schoolName: 'Pamantasan ng Lungsod ng Pasig',
    logoUrl: '/plp-logo.png',
  });

  const adminUsernameRef = useRef();
  const adminPasswordRef = useRef();
  const studentEmailRef = useRef();
  const studentPasswordRef = useRef();
  const setupIdRef = useRef();
  const setupIdConfirmRef = useRef();
  const setupNameRef = useRef();
  const setupPassRef = useRef();
  const setupConfirmRef = useRef();

  useEffect(() => {
    const onReady = () => {
      setFbLoading(false);
      const s = window.DB.getSettings();
      setSettings({
        schoolName: s.schoolName || 'Pamantasan ng Lungsod ng Pasig',
        logoUrl: s.logoUrl || '/plp-logo.png',
      });
      const params = new URLSearchParams(window.location.search);
      if (params.get('tab') === 'student') setActiveTab('student');
      if (window.Auth.getAdminSession()) { window.location.href = 'admin.html'; return; }
      if (window.Auth.getStudentSession()) { window.location.href = 'exam.html'; return; }
    };

    document.addEventListener('firebaseReady', onReady);
    const fallback = setTimeout(() => {
      setFbLoading(false);
      document.dispatchEvent(new Event('firebaseReady'));
    }, 1200);
    window.FirebaseSync.init();

    return () => {
      document.removeEventListener('firebaseReady', onReady);
      clearTimeout(fallback);
    };
  }, []);

  const switchTab = (tab) => {
    setActiveTab(tab);
    setAdminError('');
    setStep1Error('');
    setStep2aError('');
    setStep2bError('');
    setStudentStep(1);
  };

  const studentGoBack = () => {
    setStudentStep(1);
    setStep1Error('');
    setStep2aError('');
    setStep2bError('');
    setTimeout(() => studentEmailRef.current?.focus(), 0);
  };

  const doEmailContinue = () => {
    const email = (studentEmailRef.current?.value || '').trim().toLowerCase();
    setStep1Error('');
    if (!email) { setStep1Error('Please enter your PLP email address.'); return; }
    if (!email.endsWith('@plpasig.edu.ph')) { setStep1Error('Only @plpasig.edu.ph email addresses are allowed.'); return; }
    const result = window.Auth.checkStudentEmail(email);
    setStudentEmail(email);
    if (result.hasPassword) {
      setStudentStep('2a');
      setTimeout(() => studentPasswordRef.current?.focus(), 80);
    } else {
      setStudentStep('2b');
      setTimeout(() => setupIdRef.current?.focus(), 80);
    }
  };

  const doPasswordLogin = () => {
    const email = (studentEmailRef.current?.value || '').trim().toLowerCase();
    const password = studentPasswordRef.current?.value || '';
    setStep2aError('');
    if (!password) { setStep2aError('Please enter your password.'); return; }
    const result = window.Auth.studentLoginWithPassword(email, password);
    if (result.success) { window.location.href = 'exam.html'; }
    else { setStep2aError(result.message); }
  };

  const doFirstSetup = () => {
    const email = (studentEmailRef.current?.value || '').trim().toLowerCase();
    const studentId = (setupIdRef.current?.value || '').trim().toUpperCase();
    const studentIdConfirm = (setupIdConfirmRef.current?.value || '').trim().toUpperCase();
    const name = (setupNameRef.current?.value || '').trim();
    const password = setupPassRef.current?.value || '';
    const confirm = setupConfirmRef.current?.value || '';
    setStep2bError('');

    if (!studentId) { setStep2bError('Please enter your Student ID.'); return; }
    const idMatch = studentId.match(/^(\d{2})-\d{5}$/);
    if (!idMatch) { setStep2bError('Student ID must be in YY-NNNNN format (e.g. 23-00218).'); return; }
    const yr = parseInt(idMatch[1]);
    if (yr < 18 || yr > 35) { setStep2bError('Invalid Student ID year.'); return; }
    if (studentId !== studentIdConfirm) { setStep2bError('Student IDs do not match. Please check and re-enter.'); return; }
    if (!password) { setStep2bError('Please create a password.'); return; }
    if (password.length < 6) { setStep2bError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setStep2bError('Passwords do not match.'); return; }

    const result = window.Auth.studentFirstSetup(email, studentId, password, name);
    if (result.success) { window.location.href = 'exam.html'; }
    else { setStep2bError(result.message); }
  };

  const doAdminLogin = () => {
    const username = (adminUsernameRef.current?.value || '').trim();
    const password = adminPasswordRef.current?.value || '';
    setAdminError('');
    if (!username || !password) { setAdminError('Please enter username and password.'); return; }
    const result = window.Auth.adminLogin(username, password);
    if (result.success) { window.location.href = 'admin.html'; }
    else { setAdminError(result.message); }
  };

  const formatStudentId = (e) => {
    const input = e.target;
    const cursor = input.selectionStart;
    const prev = input.value;
    const digits = prev.replace(/\D/g, '').slice(0, 7);
    input.value = digits.length > 2 ? digits.slice(0, 2) + '-' + digits.slice(2) : digits;
    const added = input.value.length - prev.length;
    input.setSelectionRange(cursor + added, cursor + added);
  };

  return (
    <>
      {fbLoading && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.97)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 99999, gap: '14px' }}>
          <div style={{ width: '36px', height: '36px', border: '3px solid #e5e7eb', borderTopColor: '#1a4d2a', borderRadius: '50%', animation: '_fbspin 0.75s linear infinite' }} />
          <p style={{ color: '#6b7280', fontSize: '13px', fontFamily: 'sans-serif', margin: 0 }}>Connecting to server&hellip;</p>
          <style>{`@keyframes _fbspin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}

      <div className="login-page">
        <div className="login-orb login-orb-1" />
        <div className="login-orb login-orb-2" />
        <div className="login-orb login-orb-3" />
        <div className="login-orb login-orb-4" />

        <div className="login-card">
          <div className="login-logo">
            <img src={settings.logoUrl} alt="PLP Logo" style={{ width: '80px', height: '80px', objectFit: 'contain' }} />
            <h1>{settings.schoolName}</h1>
            <p>Online Examination System</p>
            <p className="login-tagline">University of Pasig City</p>
          </div>

          <div className="tab-switcher">
            <button className={`tab-btn${activeTab === 'admin' ? ' active' : ''}`} onClick={() => switchTab('admin')}>Professor Login</button>
            <button className={`tab-btn${activeTab === 'student' ? ' active' : ''}`} onClick={() => switchTab('student')}>Student Login</button>
          </div>

          <div className="tab-content">

            {/* ===== ADMIN TAB ===== */}
            <div id="tab-admin" className={`tab-panel${activeTab === 'admin' ? ' active' : ''}`}>
              <div className="form-group">
                <label htmlFor="admin-username">Username</label>
                <input type="text" className="form-control" id="admin-username" ref={adminUsernameRef}
                  placeholder="Enter username" autoComplete="username"
                  onKeyDown={(e) => { if (e.key === 'Enter') adminPasswordRef.current?.focus(); }} />
              </div>
              <div className="form-group">
                <label htmlFor="admin-password">Password</label>
                <div style={{ position: 'relative' }}>
                  <input type={showAdminPass ? 'text' : 'password'} className="form-control" id="admin-password" ref={adminPasswordRef}
                    placeholder="Enter password" autoComplete="current-password" style={{ paddingRight: '42px' }}
                    onKeyDown={(e) => { if (e.key === 'Enter') doAdminLogin(); }} />
                  <EyeToggle show={showAdminPass} onToggle={() => setShowAdminPass(v => !v)} />
                </div>
              </div>
              {adminError && <div className="text-danger mb-12" style={{ fontSize: '13px' }}>{adminError}</div>}
              <button className="btn btn-primary btn-block btn-lg" onClick={doAdminLogin}>Sign In</button>
            </div>

            {/* ===== STUDENT TAB ===== */}
            <div id="tab-student" className={`tab-panel${activeTab === 'student' ? ' active' : ''}`}>

              {/* STEP 1: Email */}
              {studentStep === 1 && (
                <div>
                  <div className="form-group">
                    <label htmlFor="student-email">PLP Email Address</label>
                    <input type="email" className="form-control" id="student-email" ref={studentEmailRef}
                      placeholder="e.g. juandelacruz@plpasig.edu.ph" autoComplete="email"
                      onKeyDown={(e) => { if (e.key === 'Enter') doEmailContinue(); }} />
                  </div>
                  {step1Error && <div className="text-danger mb-12" style={{ fontSize: '13px' }}>{step1Error}</div>}
                  <button className="btn btn-primary btn-block btn-lg" onClick={doEmailContinue}>Continue</button>
                  <p className="text-center text-muted mt-8" style={{ fontSize: '12px' }}>Must be a <strong>@plpasig.edu.ph</strong> email address.</p>
                </div>
              )}

              {/* STEP 2A: Returning student */}
              {studentStep === '2a' && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px', background: '#f3f4f6', borderRadius: '8px', padding: '8px 12px' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{studentEmail}</span>
                    <button onClick={studentGoBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', color: '#6b7280', whiteSpace: 'nowrap', padding: 0 }}>Change</button>
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-password">Password</label>
                    <div style={{ position: 'relative' }}>
                      <input type={showStudentPass ? 'text' : 'password'} className="form-control" id="student-password" ref={studentPasswordRef}
                        placeholder="Enter your password" autoComplete="current-password" style={{ paddingRight: '42px' }}
                        onKeyDown={(e) => { if (e.key === 'Enter') doPasswordLogin(); }} />
                      <EyeToggle show={showStudentPass} onToggle={() => setShowStudentPass(v => !v)} />
                    </div>
                  </div>
                  {step2aError && <div className="text-danger mb-12" style={{ fontSize: '13px' }}>{step2aError}</div>}
                  <button className="btn btn-primary btn-block btn-lg" onClick={doPasswordLogin}>Sign In</button>
                  <p className="text-center text-muted mt-8" style={{ fontSize: '11px' }}>Forgot your password? Contact your instructor to reset it.</p>
                </div>
              )}

              {/* STEP 2B: First-time setup */}
              {studentStep === '2b' && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', background: '#f0f7f2', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '8px 12px' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#15803d', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{studentEmail}</span>
                    <button onClick={studentGoBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', color: '#6b7280', whiteSpace: 'nowrap', padding: 0 }}>Change</button>
                  </div>
                  <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '14px' }}>First login detected. Set up your account to continue.</p>
                  <div style={{ background: '#fef9c3', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px 13px', marginBottom: '14px', fontSize: '12px', color: '#92400e', lineHeight: 1.5 }}>
                    <strong>Important:</strong> Your Student ID cannot be changed after account creation. Double-check it carefully — only your professor can correct it.
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-id">Student ID <span style={{ color: '#9ca3af', fontWeight: 400 }}>(YY-NNNNN)</span></label>
                    <input type="text" className="form-control" id="student-setup-id" ref={setupIdRef}
                      placeholder="e.g. 23-00218" inputMode="numeric" maxLength={8} autoComplete="off"
                      onInput={formatStudentId}
                      onKeyDown={(e) => { if (e.key === 'Enter') setupIdConfirmRef.current?.focus(); }} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-id-confirm">Confirm Student ID</label>
                    <input type="text" className="form-control" id="student-setup-id-confirm" ref={setupIdConfirmRef}
                      placeholder="Re-enter your Student ID" inputMode="numeric" maxLength={8} autoComplete="off"
                      onInput={formatStudentId}
                      onKeyDown={(e) => { if (e.key === 'Enter') setupNameRef.current?.focus(); }} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-name">Full Name <span style={{ color: '#9ca3af', fontWeight: 400 }}>(if not yet registered)</span></label>
                    <input type="text" className="form-control" id="student-setup-name" ref={setupNameRef}
                      placeholder="Last, First Middle" autoComplete="name"
                      onKeyDown={(e) => { if (e.key === 'Enter') setupPassRef.current?.focus(); }} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-pass">Create Password</label>
                    <div style={{ position: 'relative' }}>
                      <input type={showSetupPass ? 'text' : 'password'} className="form-control" id="student-setup-pass" ref={setupPassRef}
                        placeholder="Minimum 6 characters" style={{ paddingRight: '42px' }}
                        onKeyDown={(e) => { if (e.key === 'Enter') setupConfirmRef.current?.focus(); }} />
                      <EyeToggle show={showSetupPass} onToggle={() => setShowSetupPass(v => !v)} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-confirm">Confirm Password</label>
                    <input type="password" className="form-control" id="student-setup-confirm" ref={setupConfirmRef}
                      placeholder="Re-enter password"
                      onKeyDown={(e) => { if (e.key === 'Enter') doFirstSetup(); }} />
                  </div>
                  {step2bError && <div className="text-danger mb-12" style={{ fontSize: '13px' }}>{step2bError}</div>}
                  <button className="btn btn-primary btn-block btn-lg" onClick={doFirstSetup}>Create Account &amp; Sign In</button>
                </div>
              )}

            </div>{/* /tab-student */}
          </div>{/* /tab-content */}
        </div>
      </div>
    </>
  );
}
