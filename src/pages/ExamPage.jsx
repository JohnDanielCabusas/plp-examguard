import React, { useEffect, useRef } from 'react';

export default function ExamPage() {
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    const fbEl = document.getElementById('fb-loading');
    document.addEventListener('firebaseReady', () => {
      if (fbEl) fbEl.style.display = 'none';
      // Populate topbar user chip from student session
      requestAnimationFrame(() => {
        const session = window.Auth?.getStudentSession?.();
        if (session) {
          const initial = (session.studentName || session.studentId || 'S').charAt(0).toUpperCase();
          const name = session.studentName || session.studentId || 'Student';
          const avatarEl = document.getElementById('portal-topbar-avatar');
          const nameEl = document.getElementById('portal-topbar-name');
          if (avatarEl) avatarEl.textContent = initial;
          if (nameEl) nameEl.textContent = name;
        }
      });
    });
    setTimeout(() => {
      if (fbEl && fbEl.style.display !== 'none') {
        fbEl.style.display = 'none';
        document.dispatchEvent(new Event('firebaseReady'));
      }
    }, 1200);
    // Portal sidebar toggle (desktop: icon-only, mobile: hide/show)
    window._portalToggleSidebar = () => {
      const sidebar = document.getElementById('portal-sidebar');
      const main = document.getElementById('portal-main');
      if (!sidebar) return;
      sidebar.classList.toggle('collapsed');
      if (main) main.classList.toggle('portal-sidebar-collapsed');
    };

    window.FirebaseSync.init();
  }, []);

  return (
    <>
      {/* Firebase loading overlay */}
      <div id="fb-loading" style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.97)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 99999, gap: '14px' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid #e5e7eb', borderTopColor: '#1a4d2a', borderRadius: '50%', animation: '_fbspin 0.75s linear infinite' }} />
        <p style={{ color: '#6b7280', fontSize: '13px', fontFamily: 'sans-serif', margin: 0 }}>Connecting to server&hellip;</p>
        <style>{`@keyframes _fbspin{to{transform:rotate(360deg)}}`}</style>
      </div>

      {/* WARNING OVERLAY */}
      <div id="warning-overlay" style={{ display: 'none' }}>
        <div className="warning-overlay-content" id="warning-overlay-content">
          <div className="warning-overlay-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div className="warning-overlay-title" id="warning-overlay-title">WARNING!</div>
          <div className="warning-pips">
            <div className="warning-pip" id="wpip-1" />
            <div className="warning-pip" id="wpip-2" />
            <div className="warning-pip" id="wpip-3" />
          </div>
          <div className="warning-overlay-count-row">
            <span className="warning-overlay-count" id="warning-overlay-count">1</span>
            <span className="warning-overlay-of">of 3 warnings</span>
          </div>
          <div className="warning-overlay-msg" id="warning-overlay-msg">Suspicious activity detected.</div>
          <div className="warning-overlay-sub" id="warning-overlay-sub">This incident has been recorded.</div>
          <div className="warning-countdown-wrap" id="warning-countdown-wrap" style={{ display: 'none' }}>
            <div className="warning-countdown-ring">
              <svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
                <circle className="cd-track" cx="30" cy="30" r="26" />
                <circle className="cd-fill" cx="30" cy="30" r="26" id="cd-circle" strokeDasharray="163.36" strokeDashoffset="0" />
              </svg>
              <span className="cd-num" id="cd-num">10</span>
            </div>
            <div className="warning-countdown-msg">Return to this window or your exam will be auto-submitted</div>
          </div>
        </div>
      </div>

      {/* STATE: DASHBOARD */}
      <div id="state-dashboard" className="hidden">
        <div className="student-portal" id="student-portal">
          <div className="portal-sidebar" id="portal-sidebar">
            <div className="portal-sidebar-top">
              <div className="portal-brand">
                <img id="portal-logo" src="/plp-logo.png" alt="PLP" className="portal-logo-img" />
                <div className="portal-brand-text">
                  <span className="portal-logo-text">Pamantasan ng Lungsod ng Pasig</span>
                  <span className="portal-logo-subtext">Student Portal</span>
                </div>
              </div>
            </div>
            <nav className="portal-nav">
              <div className="portal-nav-section-label">Main</div>
              <div className="portal-nav-item active" id="pnav-home" data-label="Home" onClick={() => window.ExamApp.showPortalTab('home')}>
                <span className="portal-nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></span>
                <span className="portal-nav-label">Home</span>
              </div>
              <div className="portal-nav-item" id="pnav-settings" data-label="Settings" onClick={() => window.ExamApp.showPortalTab('settings')}>
                <span className="portal-nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
                <span className="portal-nav-label">Settings</span>
              </div>
              <div className="portal-nav-divider" />
              <div className="portal-nav-section-label">Enrolled</div>
              <div id="portal-nav-courses" />
            </nav>
            <div className="portal-sidebar-footer">
              {/* Hidden targets kept for exam.js compatibility */}
              <span id="portal-avatar" style={{ display: 'none' }} />
              <span id="portal-footer-name" style={{ display: 'none' }} />
              <span id="portal-footer-id" style={{ display: 'none' }} />

              <button className="portal-signout-btn" data-label="Sign Out" onClick={() => window.ExamApp.dashSignOut()}>
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                <span className="portal-nav-label">Sign Out</span>
              </button>
            </div>
          </div>

          <div className="portal-main" id="portal-main">
            <div className="portal-topbar">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button className="hamburger-btn" onClick={() => window._portalToggleSidebar?.()}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                </button>
                <span className="portal-topbar-title" id="portal-topbar-title">Home</span>
              </div>
              {/* User chip — top-right, same style as admin topbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f3f4f6', borderRadius: '100px', padding: '4px 12px 4px 4px', cursor: 'default' }}>
                <div id="portal-topbar-avatar" style={{ width: '28px', height: '28px', background: 'var(--accent)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#fff', flexShrink: 0 }}>S</div>
                <span id="portal-topbar-name" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--primary)', whiteSpace: 'nowrap' }}>Student</span>
              </div>
            </div>

            <div className="portal-content">
              <div id="portal-tab-course" className="hidden">
                <div className="course-banner" id="course-banner">
                  <div className="course-banner-inner">
                    <div className="course-banner-title" id="course-banner-title" />
                    <div className="course-banner-sub" id="course-banner-sub" />
                  </div>
                </div>
                <div className="course-tabs-bar">
                  <button className="course-tab-btn active" id="ctab-exams" onClick={() => window.ExamApp.showCourseTab('exams')}>Exams</button>
                  <button className="course-tab-btn" id="ctab-people" onClick={() => window.ExamApp.showCourseTab('people')}>People</button>
                </div>
                <div id="course-tab-exams" style={{ paddingTop: '16px' }} />
                <div id="course-tab-people" className="hidden" style={{ paddingTop: '16px' }} />
              </div>

              <div id="portal-tab-home">
                <div className="dash-greeting" id="dash-greeting" />
                <div className="dash-quick-row">
                  <div className="dash-quick-card">
                    <div className="dash-quick-card-title">
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                      Enter Exam Code
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input type="text" className="form-control" id="dash-exam-code-input" placeholder="e.g. EXAM01" autoComplete="off" style={{ textTransform: 'uppercase', fontFamily: 'monospace', fontWeight: 700, letterSpacing: '1.5px', flex: 1 }} />
                      <button className="btn btn-primary" onClick={() => window.ExamApp.dashEnterExamCode()} style={{ whiteSpace: 'nowrap', padding: '0 20px' }}>Go</button>
                    </div>
                  </div>
                  <div className="dash-quick-card">
                    <div className="dash-quick-card-title">
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="9" y1="10" x2="15" y2="10"/></svg>
                      Enroll in a Course
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input type="text" className="form-control" id="dash-enroll-code" placeholder="Course enrollment code" autoComplete="off" style={{ textTransform: 'uppercase', fontFamily: 'monospace', fontWeight: 700, letterSpacing: '1.5px', flex: 1 }} maxLength={8} />
                      <button className="btn btn-secondary" onClick={() => window.ExamApp.dashEnrollCourse()} style={{ whiteSpace: 'nowrap' }}>Enroll</button>
                    </div>
                    <div id="dash-enroll-msg" style={{ marginTop: '6px', fontSize: '12px', minHeight: '16px' }} />
                  </div>
                </div>
                <div id="dash-subjects-list" />
              </div>

              <div id="portal-tab-settings" className="hidden">
                <div className="dash-section-label" style={{ marginBottom: '18px' }}>Account Settings</div>
                <div className="settings-grid">
                  <div className="settings-card">
                    <div className="settings-card-title">
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                      Profile
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Full Name</div>
                      <input type="text" className="form-control" id="stg-name" style={{ fontSize: '14px' }} />
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Email</div>
                      <div className="settings-field-readonly"><span id="stg-email" style={{ fontSize: '14px', color: '#374151' }} /><span className="settings-readonly-badge">Read-only</span></div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Student ID</div>
                      <input type="text" className="form-control settings-mono-input" id="stg-studentid" placeholder="e.g. 26-00001" maxLength={8} inputMode="numeric" autoComplete="off" />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                      <div className="settings-field" style={{ margin: 0 }}>
                        <div className="settings-field-label">Year Level</div>
                        <select className="form-control" id="stg-year">
                          <option value="">Select year level</option>
                          <option value="1st Year">1st Year</option>
                          <option value="2nd Year">2nd Year</option>
                          <option value="3rd Year">3rd Year</option>
                          <option value="4th Year">4th Year</option>
                        </select>
                      </div>
                      <div className="settings-field" style={{ margin: 0 }}>
                        <div className="settings-field-label">Section</div>
                        <input type="text" className="form-control" id="stg-section" placeholder="e.g. Section A" autoComplete="off" />
                      </div>
                    </div>
                    <div id="stg-profile-msg" style={{ fontSize: '12px', marginBottom: '10px', minHeight: '16px' }} />
                    <button className="btn btn-primary" onClick={() => window.ExamApp.saveStudentProfile()}>Save Profile</button>
                  </div>
                  <div className="settings-card">
                    <div className="settings-card-title">
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                      Change Password
                    </div>
                    <div className="form-group"><label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Current Password</label><input type="password" className="form-control" id="stg-cur-pass" placeholder="Enter current password" /></div>
                    <div className="form-group"><label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>New Password</label><input type="password" className="form-control" id="stg-new-pass" placeholder="Minimum 6 characters" /></div>
                    <div className="form-group"><label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Confirm New Password</label><input type="password" className="form-control" id="stg-confirm-pass" placeholder="Re-enter new password" /></div>
                    <div id="stg-pass-msg" style={{ fontSize: '12px', marginBottom: '10px', minHeight: '16px' }} />
                    <button className="btn btn-primary" onClick={() => window.ExamApp.saveStudentPassword()}>Change Password</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* STATE: REVIEW */}
      <div id="state-review" className="hidden" style={{ background: '#f0f2f5', minHeight: '100vh' }}>
        <div style={{ background: '#0f2d1a', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 800, color: '#fff' }} id="review-exam-title">Exam Review</div>
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }} id="review-student-name" />
          </div>
          <div id="review-score-chip" style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: '12px', padding: '8px 18px', fontSize: '15px', fontWeight: 800, color: '#fff' }} />
        </div>
        <div style={{ maxWidth: '760px', margin: '0 auto', padding: '24px 16px 60px' }} id="review-container" />
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: '#fff', borderTop: '1px solid #e5e7eb', padding: '14px 24px', textAlign: 'center' }}>
          <button className="btn btn-primary" onClick={() => window.ExamApp.returnToLogin()} style={{ minWidth: '160px' }}>← Back</button>
        </div>
      </div>

      {/* STATE: ENTRY (fallback) */}
      <div id="state-entry" className="state-center hidden">
        <div className="state-card">
          <img src="/plp-logo.png" alt="PLP" style={{ height: '64px', objectFit: 'contain', marginBottom: '12px' }} />
          <h2>Enter Exam</h2>
          <p>Enter your Student ID and the exam code provided by your instructor.</p>
          <div className="form-group" style={{ textAlign: 'left' }}>
            <label>Student ID</label>
            <input type="text" className="form-control" id="entry-student-id" placeholder="e.g. STU001" style={{ textTransform: 'uppercase' }} />
          </div>
          <div className="form-group" style={{ textAlign: 'left' }}>
            <label>Exam Code</label>
            <input type="text" className="form-control" id="entry-exam-code" placeholder="e.g. EXAM01" style={{ textTransform: 'uppercase' }} />
          </div>
          <div id="entry-error" className="text-danger mb-12" style={{ fontSize: '13px', display: 'none' }} />
          <button className="btn btn-primary btn-block btn-lg" onClick={() => window.ExamApp.submitEntry()}>Proceed</button>
          <a href="index.html" style={{ display: 'block', marginTop: '12px', fontSize: '13px' }}>Back to Login</a>
        </div>
      </div>

      {/* STATE: WAITING */}
      <div id="state-waiting" className="state-center hidden">
        <div className="state-card">
          <div className="spinner" />
          <h2>Waiting for Exam to Start</h2>
          <p>The exam has not started yet. Please wait for your instructor to activate the exam.</p>
          <div className="student-info-box" id="waiting-info-box" />
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>This page refreshes automatically every 3 seconds.</div>
          <a href="#" onClick={(e) => { e.preventDefault(); window.ExamApp.returnToLogin(); }} style={{ display: 'block', marginTop: '16px', fontSize: '13px' }}>← Back to Dashboard</a>
        </div>
      </div>

      {/* STATE: EXAM (active) */}
      <div id="state-exam" className="hidden">
        <div className="exam-header">
          <div className="exam-header-left">
            <div className="exam-header-logo">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            </div>
            <div>
              <div className="exam-title" id="exam-header-title">Loading...</div>
              <div className="exam-subject" id="exam-header-subject" />
            </div>
          </div>
          <div id="exam-timer" className="exam-timer">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span id="timer-display">--:--</span>
          </div>
          <div className="exam-header-right">
            <div className="warning-count" id="warning-count-display">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
              <span id="warning-num">0</span>/3
            </div>
            <button className="btn btn-exam-submit" onClick={() => window.ExamApp.confirmSubmit()}>Submit Exam</button>
          </div>
        </div>
        <div className="exam-body">
          <div className="exam-meta-bar">
            <div className="exam-student-chip" id="exam-student-info" />
            <div className="exam-answered-chip" id="exam-answered-status" />
          </div>
          <div className="progress-bar-wrap"><div className="progress-bar-fill" id="exam-progress-bar" style={{ width: '0%' }} /></div>
          <div id="questions-container" />
          <div className="exam-submit-area">
            <div className="answered-progress" id="submit-progress" />
            <button className="btn btn-primary btn-lg" onClick={() => window.ExamApp.confirmSubmit()}>Submit Exam</button>
          </div>
        </div>
      </div>

      {/* STATE: SUBMITTED */}
      <div id="state-submitted" className="state-center hidden">
        <div className="state-card">
          <div className="submitted-icon-wrap" id="submitted-icon-wrap" />
          <h2 id="submitted-title">Exam Submitted!</h2>
          <p id="submitted-msg">Your answers have been submitted successfully.</p>
          <div className="student-info-box" id="submitted-info-box" />
          <div id="score-display" className="hidden">
            <div className="score-released-label">Your Score</div>
            <div className="score-released-value" id="score-value" />
            <div className="score-released-pct" id="score-pct" />
            <div className="score-released-bar-wrap"><div className="score-released-bar-fill" id="score-bar-fill" /></div>
          </div>
          <div id="score-pending" className="hidden">
            <div className="score-pending-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12"/><path d="M12 16h.01"/></svg>
              <span>Your score will be available once your instructor releases the results.</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '20px' }}>
            <button id="btn-review-answers" className="btn btn-secondary btn-block" onClick={() => window.ExamApp.showReview()} style={{ display: 'none' }}>
              📋 Review My Answers
            </button>
            <button className="btn btn-primary btn-block" onClick={() => window.ExamApp.returnToLogin()}>← Back</button>
          </div>
        </div>
      </div>

      {/* Motion Warning Overlay */}
      <div id="motion-warning-overlay" style={{ display: 'none', position: 'fixed', inset: 0, background: 'rgba(220,38,38,0.95)', zIndex: 9000, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#fff' }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" style={{ marginBottom: '20px', opacity: 0.9 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div style={{ fontSize: '28px', fontWeight: 900, marginBottom: '10px', fontFamily: "'Plus Jakarta Sans',sans-serif" }}>No Person Detected</div>
        <div style={{ fontSize: '16px', opacity: 0.85, marginBottom: '24px', maxWidth: '400px', lineHeight: 1.5 }}>Please return to your camera view.<br />The exam will resume once you are detected.</div>
        <div style={{ fontSize: '13px', opacity: 0.7 }}>Stay visible in front of your camera to continue the exam.</div>
      </div>

      {/* Camera Container */}
      <div id="camera-container" className="camera-container" style={{ display: 'none' }}>
        <div className="camera-feed-wrap">
          <video id="camera-feed" className="camera-feed" autoPlay muted playsInline />
          <canvas id="camera-canvas" style={{ display: 'none' }} />
          <span className="camera-live-label">REC</span>
          <div id="camera-blocked-msg" className="camera-blocked-msg" style={{ display: 'none', position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
            <span>Camera<br />blocked</span>
          </div>
        </div>
        <div className="camera-status-bar">
          <span className="cam-rec-dot" />
          <span id="camera-status-text">Camera active</span>
        </div>
      </div>

      {/* Confirm Submit Modal */}
      <div id="confirm-submit-modal" className="modal-backdrop hidden">
        <div className="modal-dialog modal-sm">
          <div className="modal-body confirm-dialog">
            <div className="confirm-icon"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#02530A" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></div>
            <div className="confirm-title">Submit Exam?</div>
            <div className="confirm-message" id="confirm-submit-msg">Are you sure you want to submit? You cannot change your answers after submission.</div>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => window.ExamApp.cancelSubmit()}>Continue Exam</button>
              <button className="btn btn-primary" onClick={() => window.ExamApp.submitExam('manual')}>Submit Now</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
