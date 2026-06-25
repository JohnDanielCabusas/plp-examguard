import React, { useState, useEffect, useRef } from 'react';

const EYE_OPEN = (
  <>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </>
);

const DEPARTMENT_OPTIONS = [
  'College of Arts & Sciences (CAS)',
  'College of Education (COE)',
  'College of Business & Accountancy (CBA)',
  'College of Computer Studies (CCS)',
  'College of Engineering (COE)',
  'College of Nursing (CON)',
];
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

function ButtonSpinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: '16px',
        height: '16px',
        border: '2px solid rgba(255,255,255,0.35)',
        borderTopColor: '#ffffff',
        borderRadius: '50%',
        display: 'inline-block',
        animation: 'loginBtnSpin 0.75s linear infinite',
      }}
    />
  );
}

export default function LoginPage() {
  const [activeTab, setActiveTab] = useState('admin');
  const [adminStep, setAdminStep] = useState('login');
  const [studentStep, setStudentStep] = useState(1); // 1 | 'verify' | '2a' | '2b'
  const [studentEmail, setStudentEmail] = useState('');
  const [studentVerifyMessage, setStudentVerifyMessage] = useState('');
  const [adminError, setAdminError] = useState('');
  const [adminResetEmail, setAdminResetEmail] = useState('');
  const [adminResetMessage, setAdminResetMessage] = useState('');
  const [step1Error, setStep1Error] = useState('');
  const [step2aError, setStep2aError] = useState('');
  const [step2bError, setStep2bError] = useState('');
  const [showAdminPass, setShowAdminPass] = useState(false);
  const [showStudentPass, setShowStudentPass] = useState(false);
  const [showSetupPass, setShowSetupPass] = useState(false);
  const [showSetupConfirmPass, setShowSetupConfirmPass] = useState(false);
  const [showAdminResetPass, setShowAdminResetPass] = useState(false);
  const [showAdminResetConfirm, setShowAdminResetConfirm] = useState(false);
  const [fbLoading, setFbLoading] = useState(true);
  const [studentEmailLookupBusy, setStudentEmailLookupBusy] = useState(false);
  const [studentEmailSendBusy, setStudentEmailSendBusy] = useState(false);
  const [adminEmailSendBusy, setAdminEmailSendBusy] = useState(false);
  const [studentResendCooldown, setStudentResendCooldown] = useState(0);
  const [adminResendCooldown, setAdminResendCooldown] = useState(0);
  const [settings, setSettings] = useState({
    schoolName: 'Pamantasan ng Lungsod ng Pasig',
    logoUrl: '/plp-logo.png',
  });

  const adminUsernameRef = useRef();
  const adminPasswordRef = useRef();
  const adminResetEmailRef = useRef();
  const adminResetCodeRef = useRef();
  const adminResetPasswordRef = useRef();
  const adminResetConfirmRef = useRef();
  const studentEmailRef = useRef();
  const studentVerifyCodeRef = useRef();
  const studentPasswordRef = useRef();
  const setupIdRef = useRef();
  const setupNameRef = useRef();
  const setupYearSectionRef = useRef();
  const setupDepartmentRef = useRef();
  const setupProgramRef = useRef();
  const setupPassRef = useRef();
  const setupConfirmRef = useRef();
  const readyHandledRef = useRef(false);

  useEffect(() => {
    const applyBootState = () => {
      setFbLoading(false);
      const s = window.DB?.getSettings?.() || {};
      setSettings({
        schoolName: s.schoolName || 'Pamantasan ng Lungsod ng Pasig',
        logoUrl: s.logoUrl || '/plp-logo.png',
      });
      const params = new URLSearchParams(window.location.search);
      if (params.get('tab') === 'student') setActiveTab('student');
      if (window.Auth?.getAdminSession?.()) { window.location.replace('admin.html'); return; }
      if (window.Auth?.getStudentSession?.()) { window.location.replace('exam.html'); return; }
    };

    const onReady = () => {
      if (readyHandledRef.current) return;
      readyHandledRef.current = true;
      applyBootState();
    };

    document.addEventListener('firebaseReady', onReady);
    if (window.DB && window.Auth) {
      applyBootState();
    } else {
      setFbLoading(false);
    }
    if (window.FirebaseSync?.init) window.FirebaseSync.init();

    return () => {
      document.removeEventListener('firebaseReady', onReady);
    };
  }, []);

  useEffect(() => {
    if (!studentResendCooldown) return undefined;
    const timer = window.setInterval(() => {
      setStudentResendCooldown(value => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [studentResendCooldown]);

  useEffect(() => {
    if (!adminResendCooldown) return undefined;
    const timer = window.setInterval(() => {
      setAdminResendCooldown(value => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [adminResendCooldown]);

  const switchTab = (tab) => {
    setActiveTab(tab);
    setAdminStep('login');
    setAdminError('');
    setAdminResetEmail('');
    setAdminResetMessage('');
    setAdminResendCooldown(0);
    setStep1Error('');
    setStep2aError('');
    setStep2bError('');
    setStudentVerifyMessage('');
    setStudentResendCooldown(0);
    window.Auth?.clearStudentEmailVerification?.();
    setStudentStep(1);
  };

  const startAdminReset = () => {
    setAdminStep('email');
    setAdminError('');
    setAdminResetEmail('');
    setAdminResetMessage('');
    setAdminResendCooldown(0);
    requestAnimationFrame(() => adminResetEmailRef.current?.focus());
  };

  const adminResetBackToLogin = () => {
    setAdminStep('login');
    setAdminError('');
    setAdminResetMessage('');
    setAdminResendCooldown(0);
    window.Auth?.clearAdminPasswordReset?.();
    requestAnimationFrame(() => adminUsernameRef.current?.focus());
  };

  const sendVerificationEmail = async ({ email, code, type }) => {
    const response = await fetch('/api/email/send-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, type }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Unable to send the verification email.');
    }
  };

  const sendAdminResetCode = async () => {
    const email = (adminResetEmailRef.current?.value || '').trim().toLowerCase();
    setAdminError('');
    if (!email) {
      const message = 'Please enter your professor email address.';
      setAdminError(message);
      return;
    }
    const result = window.Auth.beginAdminPasswordReset(email);
    if (!result.success) {
      setAdminError(result.message);
      return;
    }
    setAdminEmailSendBusy(true);
    try {
      await sendVerificationEmail({
        email,
        code: result.previewCode,
        type: 'admin-reset',
      });
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : 'Unable to send the verification email right now. Please try again.');
      return;
    } finally {
      setAdminEmailSendBusy(false);
    }
    setAdminResetEmail(email);
    setAdminResetMessage('Verification code sent. Check your email inbox for the 6-digit code.');
    setAdminResendCooldown(60);
    setAdminStep('code');
    requestAnimationFrame(() => adminResetCodeRef.current?.focus());
  };

  const verifyAdminResetCode = () => {
    const code = (adminResetCodeRef.current?.value || '').trim();
    setAdminError('');
    if (!/^\d{6}$/.test(code)) {
      const message = 'Please enter the 6-digit verification code.';
      setAdminError(message);
      return;
    }
    const result = window.Auth.verifyAdminResetCode(adminResetEmail, code);
    if (!result.success) {
      setAdminError(result.message);
      return;
    }
    setAdminResetMessage('Code verified. You can now create a new password.');
    setAdminStep('password');
    requestAnimationFrame(() => adminResetPasswordRef.current?.focus());
  };

  const saveAdminNewPassword = () => {
    const password = adminResetPasswordRef.current?.value || '';
    const confirm = adminResetConfirmRef.current?.value || '';
    setAdminError('');
    if (password.length < 6) {
      const message = 'Password must be at least 6 characters.';
      setAdminError(message);
      return;
    }
    if (password !== confirm) {
      const message = 'Passwords do not match.';
      setAdminError(message);
      return;
    }
    const result = window.Auth.completeAdminPasswordReset(adminResetEmail, password);
    if (!result.success) {
      setAdminError(result.message);
      return;
    }
    setAdminResetMessage('Password updated successfully. Sign in with your new password.');
    setAdminStep('login');
    requestAnimationFrame(() => {
      if (adminUsernameRef.current && result.username) adminUsernameRef.current.value = result.username;
      if (adminPasswordRef.current) adminPasswordRef.current.value = '';
      adminPasswordRef.current?.focus();
    });
  };

  const studentGoBack = () => {
    setStudentStep(1);
    setStep1Error('');
    setStep2aError('');
    setStep2bError('');
    setStudentVerifyMessage('');
    setStudentResendCooldown(0);
    window.Auth?.clearStudentEmailVerification?.();
    requestAnimationFrame(() => studentEmailRef.current?.focus());
  };

  const resolveStudentEmailStatus = async (email, options = {}) => {
    const { advanceToPassword = true, showErrors = true, showLoading = true } = options;
    if (!email) {
      if (showErrors) setStep1Error('Please enter your PLP email address.');
      return { success: false, reason: 'missing-email' };
    }
    if (!email.endsWith('@plpasig.edu.ph')) {
      if (showErrors) setStep1Error('Only @plpasig.edu.ph email addresses are allowed.');
      return { success: false, reason: 'invalid-domain' };
    }

    if (showLoading) setStudentEmailLookupBusy(true);
    try {
      const studentStatus = await window.Auth.checkStudentEmail(email);
      if (studentStatus?.hasPassword) {
        setStudentEmail(email);
        setStudentVerifyMessage('');
        setStudentResendCooldown(0);
        setStep1Error('');
        if (advanceToPassword) {
          setStudentStep('2a');
          requestAnimationFrame(() => studentPasswordRef.current?.focus());
        }
        return { success: true, status: 'existing', studentStatus };
      }
      return { success: true, status: 'verification-needed', studentStatus };
    } catch (error) {
      if (showErrors) {
        setStep1Error(error instanceof Error ? error.message : 'Unable to validate the student email right now. Please try again.');
      }
      return { success: false, reason: 'lookup-failed' };
    } finally {
      if (showLoading) setStudentEmailLookupBusy(false);
    }
  };

  const doEmailContinue = async () => {
    const email = (studentEmailRef.current?.value || '').trim().toLowerCase();
    setStep1Error('');
    try {
      const lookup = await resolveStudentEmailStatus(email);
      if (!lookup.success) return;
      if (lookup.status === 'existing') return;
      const result = await window.Auth.beginStudentEmailVerification(email);
      if (!result.success) { setStep1Error(result.message); return; }
      setStudentEmailSendBusy(true);
      await sendVerificationEmail({
        email,
        code: result.previewCode,
        type: 'student-verification',
      });
    } catch (error) {
      setStep1Error(error instanceof Error ? error.message : 'Unable to continue right now. Please try again.');
      return;
    } finally {
      setStudentEmailSendBusy(false);
    }
    setStudentEmail(email);
    setStudentVerifyMessage('Verification code sent. Check your email inbox for the 6-digit code.');
    setStudentResendCooldown(60);
    setStudentStep('verify');
    requestAnimationFrame(() => studentVerifyCodeRef.current?.focus());
  };

  const verifyStudentEmail = () => {
    const code = (studentVerifyCodeRef.current?.value || '').trim();
    setStep1Error('');
    if (!/^\d{6}$/.test(code)) { setStep1Error('Please enter the 6-digit verification code.'); return; }
    const result = window.Auth.verifyStudentEmailCode(studentEmail, code);
    if (!result.success) { setStep1Error(result.message); return; }
    setStudentVerifyMessage('Email verified successfully.');
    if (result.hasPassword) {
      setStudentStep('2a');
      requestAnimationFrame(() => studentPasswordRef.current?.focus());
    } else {
      setStudentStep('2b');
      requestAnimationFrame(() => setupNameRef.current?.focus());
    }
  };

  const doPasswordLogin = async () => {
    const email = (studentEmail || studentEmailRef.current?.value || '').trim().toLowerCase();
    const password = studentPasswordRef.current?.value || '';
    setStep2aError('');
    if (!password) { setStep2aError('Please enter your password.'); return; }
    let result;
    try {
      result = await window.Auth.studentLoginWithPassword(email, password);
    } catch (error) {
      setStep2aError(error instanceof Error ? error.message : 'Unable to sign in right now. Please try again.');
      return;
    }
    if (result.success) { window.location.href = 'exam.html'; }
    else { setStep2aError(result.message); }
  };

  const doFirstSetup = async () => {
    const email = (studentEmail || studentEmailRef.current?.value || '').trim().toLowerCase();
    const studentId = (setupIdRef.current?.value || '').trim().toUpperCase();
    const name = (setupNameRef.current?.value || '').trim();
    const yearSection = (setupYearSectionRef.current?.value || '').trim().toUpperCase();
    const department = (setupDepartmentRef.current?.value || '').trim();
    const program = (setupProgramRef.current?.value || '').trim().toUpperCase();
    const password = setupPassRef.current?.value || '';
    const confirm = setupConfirmRef.current?.value || '';
    setStep2bError('');

    if (!email) { setStep2bError('Student email verification is missing. Please start again.'); return; }
    if (!name) { setStep2bError('Please enter your full name.'); return; }
    if (!studentId) { setStep2bError('Please enter your Student ID.'); return; }
    const idMatch = studentId.match(/^(\d{2})-\d{5}$/);
    if (!idMatch) { setStep2bError('Student ID must be in YY-NNNNN format (e.g. 23-00218).'); return; }
    const yr = parseInt(idMatch[1]);
    if (yr < 18 || yr > 35) { setStep2bError('Invalid Student ID year.'); return; }
    if (!/^[1-4]-[A-Z]$/.test(yearSection)) { setStep2bError('Year & section must use the format 3-B.'); return; }
    if (!department) { setStep2bError('Please select your department.'); return; }
    if (!program) { setStep2bError('Please enter your program, such as BSIT or BSCS.'); return; }
    if (!password) { setStep2bError('Please create a password.'); return; }
    if (password.length < 6) { setStep2bError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setStep2bError('Passwords do not match.'); return; }

    let result;
    try {
      result = await window.Auth.studentFirstSetup(email, studentId, password, name, yearSection, department, program);
    } catch (error) {
      setStep2bError(error instanceof Error ? error.message : 'Unable to create the student account right now. Please try again.');
      return;
    }
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
      <style>{`@keyframes _fbspin{to{transform:rotate(360deg)}} @keyframes loginBtnSpin{to{transform:rotate(360deg)}}`}</style>
      {fbLoading && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.97)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 99999, gap: '14px' }}>
          <div style={{ width: '36px', height: '36px', border: '3px solid #e5e7eb', borderTopColor: '#1a4d2a', borderRadius: '50%', animation: '_fbspin 0.75s linear infinite' }} />
          <p style={{ color: '#6b7280', fontSize: '13px', fontFamily: 'sans-serif', margin: 0 }}>Connecting to server&hellip;</p>
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
              {adminStep === 'login' && (
                <>
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
                </>
              )}
              {adminStep === 'email' && (
                <>
                  <div className="form-group">
                    <label htmlFor="admin-reset-email">Professor Email</label>
                    <input type="email" className="form-control" id="admin-reset-email" ref={adminResetEmailRef}
                      placeholder="Enter your email address" autoComplete="email"
                      onKeyDown={(e) => { if (e.key === 'Enter') sendAdminResetCode(); }} />
                  </div>
                  <p className="text-muted" style={{ fontSize: '12px', marginTop: '-4px', marginBottom: '14px' }}>
                    Enter the professor email linked to your account to receive a 6-digit verification code.
                  </p>
                </>
              )}
              {adminStep === 'code' && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px', background: '#f3f4f6', borderRadius: '8px', padding: '8px 12px' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{adminResetEmail}</span>
                  </div>
                  <div className="form-group">
                    <label htmlFor="admin-reset-code">6-Digit Verification Code</label>
                    <input type="text" className="form-control" id="admin-reset-code" ref={adminResetCodeRef}
                      placeholder="Enter the 6-digit code" inputMode="numeric" maxLength={6} autoComplete="one-time-code"
                      onKeyDown={(e) => { if (e.key === 'Enter') verifyAdminResetCode(); }} />
                  </div>
                </>
              )}
              {adminStep === 'password' && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px', background: '#ecfdf5', borderRadius: '8px', padding: '8px 12px', border: '1px solid #bbf7d0' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth="2"><path d="M20 6L9 17l-5-5" /></svg>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#166534' }}>Code verified for {adminResetEmail}</span>
                  </div>
                  <div className="form-group">
                    <label htmlFor="admin-reset-password">New Password</label>
                    <div style={{ position: 'relative' }}>
                      <input type={showAdminResetPass ? 'text' : 'password'} className="form-control" id="admin-reset-password" ref={adminResetPasswordRef}
                        placeholder="Minimum 6 characters" style={{ paddingRight: '42px' }}
                        onKeyDown={(e) => { if (e.key === 'Enter') adminResetConfirmRef.current?.focus(); }} />
                      <EyeToggle show={showAdminResetPass} onToggle={() => setShowAdminResetPass(v => !v)} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="admin-reset-confirm">Confirm New Password</label>
                    <div style={{ position: 'relative' }}>
                      <input type={showAdminResetConfirm ? 'text' : 'password'} className="form-control" id="admin-reset-confirm" ref={adminResetConfirmRef}
                        placeholder="Re-enter new password" style={{ paddingRight: '42px' }}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveAdminNewPassword(); }} />
                      <EyeToggle show={showAdminResetConfirm} onToggle={() => setShowAdminResetConfirm(v => !v)} />
                    </div>
                  </div>
                </>
              )}
              {adminError && <div className="text-danger mb-12" style={{ fontSize: '13px' }}>{adminError}</div>}
              {adminResetMessage && <div className="mb-12" style={{ fontSize: '12px', color: '#4b5563' }}>{adminResetMessage}</div>}
              {adminStep === 'login' && (
                <>
                  <button className="btn btn-primary btn-block btn-lg" onClick={doAdminLogin}>Sign In</button>
                  <div style={{ marginTop: '10px', textAlign: 'center' }}>
                    <button type="button" onClick={startAdminReset} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '12px', color: '#1a4d2a', fontWeight: 600 }}>
                      Forgot Password?
                    </button>
                  </div>
                </>
              )}
              {adminStep === 'email' && (
                <>
                  <button className="btn btn-primary btn-block btn-lg" onClick={sendAdminResetCode} disabled={adminEmailSendBusy} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                    {adminEmailSendBusy && <ButtonSpinner />}
                    <span>{adminEmailSendBusy ? 'Sending Code...' : 'Send Code'}</span>
                  </button>
                  <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: '10px' }} onClick={adminResetBackToLogin}>Back to Sign In</button>
                </>
              )}
              {adminStep === 'code' && (
                <>
                  <button className="btn btn-primary btn-block btn-lg" onClick={verifyAdminResetCode}>Verify Code</button>
                  <div style={{ marginTop: '10px', textAlign: 'right' }}>
                    <button type="button" onClick={sendAdminResetCode} disabled={adminEmailSendBusy || adminResendCooldown > 0} style={{ background: 'none', border: 'none', cursor: adminEmailSendBusy || adminResendCooldown > 0 ? 'default' : 'pointer', padding: 0, fontSize: '12px', color: '#1a4d2a', fontWeight: 600, opacity: adminEmailSendBusy || adminResendCooldown > 0 ? 0.6 : 1 }}>
                      {adminEmailSendBusy ? 'Sending...' : adminResendCooldown > 0 ? `Send Code Again in ${adminResendCooldown}s` : 'Send Code Again'}
                    </button>
                  </div>
                </>
              )}
              {adminStep === 'password' && (
                <>
                  <button className="btn btn-primary btn-block btn-lg" onClick={saveAdminNewPassword}>Update Password</button>
                  <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: '10px' }} onClick={adminResetBackToLogin}>Cancel</button>
                </>
              )}
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
                  <button className="btn btn-primary btn-block btn-lg" onClick={doEmailContinue} disabled={studentEmailLookupBusy || studentEmailSendBusy} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                    {(studentEmailLookupBusy || studentEmailSendBusy) && <ButtonSpinner />}
                    <span>{studentEmailSendBusy ? 'Sending Code...' : 'Continue'}</span>
                  </button>
                  <p className="text-center text-muted mt-8" style={{ fontSize: '12px' }}>Must be a <strong>@plpasig.edu.ph</strong> email address.</p>
                </div>
              )}

              {studentStep === 'verify' && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px', background: '#f3f4f6', borderRadius: '8px', padding: '8px 12px' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{studentEmail}</span>
                    <button onClick={studentGoBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', color: '#6b7280', whiteSpace: 'nowrap', padding: 0 }}>Change</button>
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-verify-code">6-Digit Verification Code</label>
                    <input type="text" className="form-control" id="student-verify-code" ref={studentVerifyCodeRef}
                      placeholder="Enter the 6-digit code" inputMode="numeric" maxLength={6} autoComplete="one-time-code"
                      onKeyDown={(e) => { if (e.key === 'Enter') verifyStudentEmail(); }} />
                  </div>
                  {studentVerifyMessage && <div className="mb-12" style={{ fontSize: '12px', color: '#4b5563' }}>{studentVerifyMessage}</div>}
                  {step1Error && <div className="text-danger mb-12" style={{ fontSize: '13px' }}>{step1Error}</div>}
                  <div style={{ marginTop: '-2px', marginBottom: '12px', textAlign: 'right' }}>
                    <button type="button" onClick={doEmailContinue} disabled={studentEmailSendBusy || studentResendCooldown > 0} style={{ background: 'none', border: 'none', cursor: studentEmailSendBusy || studentResendCooldown > 0 ? 'default' : 'pointer', padding: 0, fontSize: '12px', color: '#1a4d2a', fontWeight: 600, opacity: studentEmailSendBusy || studentResendCooldown > 0 ? 0.6 : 1 }}>
                      {studentEmailSendBusy ? 'Sending...' : studentResendCooldown > 0 ? `Send Code Again in ${studentResendCooldown}s` : 'Send Code Again'}
                    </button>
                  </div>
                  <button className="btn btn-primary btn-block btn-lg" onClick={verifyStudentEmail}>Verify Email</button>
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
                        placeholder="Enter your password" autoComplete="new-password" style={{ paddingRight: '42px' }}
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
                  <div className="form-group">
                    <label htmlFor="student-setup-name">Full Name</label>
                    <input type="text" className="form-control" id="student-setup-name" ref={setupNameRef}
                      placeholder="Last, First Middle" autoComplete="name"
                      onKeyDown={(e) => { if (e.key === 'Enter') setupIdRef.current?.focus(); }} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-id">Student ID <span style={{ color: '#9ca3af', fontWeight: 400 }}>(YY-NNNNN)</span></label>
                    <input type="text" className="form-control" id="student-setup-id" ref={setupIdRef}
                      placeholder="e.g. 23-00218" inputMode="numeric" maxLength={8} autoComplete="off"
                      onInput={formatStudentId}
                      onKeyDown={(e) => { if (e.key === 'Enter') setupYearSectionRef.current?.focus(); }} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-year-section">Year &amp; Section</label>
                    <input type="text" className="form-control" id="student-setup-year-section" ref={setupYearSectionRef}
                      placeholder="e.g. 3-B" autoComplete="off" maxLength={3}
                      onInput={(e) => { e.target.value = e.target.value.toUpperCase().replace(/[^0-9A-Z-]/g, '').slice(0, 3); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') setupDepartmentRef.current?.focus(); }} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-department">Department</label>
                    <select className="form-control" id="student-setup-department" ref={setupDepartmentRef}
                      onKeyDown={(e) => { if (e.key === 'Enter') setupProgramRef.current?.focus(); }}>
                      <option value="">Select your department</option>
                      {DEPARTMENT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-program">Program</label>
                    <input type="text" className="form-control" id="student-setup-program" ref={setupProgramRef}
                      placeholder="e.g. BSIT or BSCS" autoComplete="off"
                      onInput={(e) => { e.target.value = e.target.value.toUpperCase(); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') setupPassRef.current?.focus(); }} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-pass">Create Password</label>
                    <div style={{ position: 'relative' }}>
                      <input type={showSetupPass ? 'text' : 'password'} className="form-control" id="student-setup-pass" ref={setupPassRef}
                        placeholder="Minimum 6 characters" autoComplete="new-password" style={{ paddingRight: '42px' }}
                        onKeyDown={(e) => { if (e.key === 'Enter') setupConfirmRef.current?.focus(); }} />
                      <EyeToggle show={showSetupPass} onToggle={() => setShowSetupPass(v => !v)} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="student-setup-confirm">Confirm Password</label>
                    <div style={{ position: 'relative' }}>
                      <input type={showSetupConfirmPass ? 'text' : 'password'} className="form-control" id="student-setup-confirm" ref={setupConfirmRef}
                        placeholder="Re-enter password" autoComplete="new-password" style={{ paddingRight: '42px' }}
                        onKeyDown={(e) => { if (e.key === 'Enter') doFirstSetup(); }} />
                      <EyeToggle show={showSetupConfirmPass} onToggle={() => setShowSetupConfirmPass(v => !v)} />
                    </div>
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
