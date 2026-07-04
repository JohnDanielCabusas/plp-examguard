import React, { useEffect, useRef, useState } from 'react';

export default function AdminPage() {
  const booted = useRef(false);
  const [aiDiff, setAiDiff] = useState('mixed');
  const [diffOpen, setDiffOpen] = useState(false);
  const [aiMode, setAiMode] = useState('quick');
  const [aiCountInput, setAiCountInput] = useState('10');

  const parseAiCountInput = (value) => {
    const digits = String(value ?? '').replace(/\D/g, '').slice(0, 3);
    if (!digits) return null;
    return Math.min(100, Math.max(1, parseInt(digits, 10)));
  };

  const aiCountValue = parseAiCountInput(aiCountInput) ?? 1;

  const handleAiCountChange = (value) => {
    const digits = String(value ?? '').replace(/\D/g, '').slice(0, 3);
    if (!digits) {
      setAiCountInput('');
      return;
    }
    const parsed = parseAiCountInput(digits);
    setAiCountInput(parsed === null ? '' : String(parsed));
  };

  const normalizeAiCountInput = () => {
    setAiCountInput(String(parseAiCountInput(aiCountInput) ?? 1));
  };

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    const fbEl = document.getElementById('fb-loading');
    const onReady = () => {
      if (fbEl) fbEl.style.display = 'none';
      requestAnimationFrame(() => {
        const name = document.getElementById('sb-user-name')?.textContent;
        const avatar = document.getElementById('sb-avatar')?.textContent;
        const chip = document.getElementById('topbar-admin-name');
        const avEl = document.getElementById('topbar-avatar');
        if (chip && name) chip.textContent = name;
        if (avEl && avatar) avEl.textContent = avatar;
      });
    };
    document.addEventListener('dbReady', onReady);

    // Desktop sidebar toggle handler
    window._adminToggleSidebar = () => {
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        window.toggleSidebar();
      } else {
        const sidebar = document.getElementById('sidebar');
        const main = document.querySelector('.main-content');
        sidebar.classList.toggle('collapsed');
        main.classList.toggle('sidebar-collapsed');
      }
    };

    window.SupabaseSync.init();
  }, []);

  return (
    <>
      {/* Loading overlay */}
      <div id="fb-loading" style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.97)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 99999, gap: '14px' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid #e5e7eb', borderTopColor: '#1a4d2a', borderRadius: '50%', animation: '_fbspin 0.75s linear infinite' }} />
        <p style={{ color: '#6b7280', fontSize: '13px', fontFamily: 'sans-serif', margin: 0 }}>Loading your workspace&hellip;</p>
        <style>{`@keyframes _fbspin{to{transform:rotate(360deg)}}`}</style>
      </div>

      {/* Toast Container */}
      <div id="toast-container" />

      {/* Sidebar Overlay (mobile) */}
      <div className="sidebar-overlay" id="sidebar-overlay" onClick={() => window.closeSidebar()} />

      <div className="admin-layout">
        {/* SIDEBAR */}
        <aside className="sidebar" id="sidebar">
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon" id="sb-logo-wrap">
              <img src="/plp-logo.png" alt="PLP" style={{ width: '40px', height: '40px', objectFit: 'contain' }} />
            </div>
            <div className="sidebar-brand-text">
              <h2 id="sb-school-name">TUKLAS</h2>
              <p>Admin Panel</p>
            </div>
          </div>

          <nav className="sidebar-nav">
            <div className="nav-section-label">Main</div>
            <div className="nav-item active" id="nav-dashboard" data-label="Dashboard" onClick={() => window.showSection('dashboard')}>
              <span className="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg></span>
              <span className="nav-item-label">Dashboard</span>
            </div>
            <div className="nav-item" id="nav-subjects" data-label="Courses" onClick={() => window.showSection('subjects')}>
              <span className="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></span>
              <span className="nav-item-label">Courses</span>
            </div>
            <div className="nav-item" id="nav-students" data-label="Students" onClick={() => window.showSection('students')}>
              <span className="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
              <span className="nav-item-label">Students</span>
            </div>
            <div className="nav-item" id="nav-exams" data-label="Exams" onClick={() => window.showSection('exams')}>
              <span className="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>
              <span className="nav-item-label">Exams</span>
            </div>
            <div className="nav-section-label">Live</div>
            <div className="nav-item" id="nav-monitoring" data-label="Monitoring" onClick={() => window.showSection('monitoring')}>
              <span className="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span>
              <span className="nav-item-label">Monitoring</span>
            </div>
            <div className="nav-section-label">Analysis</div>
            <div className="nav-item" id="nav-reports" data-label="Reports" onClick={() => window.showSection('reports')}>
              <span className="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></span>
              <span className="nav-item-label">Reports</span>
            </div>
            <div className="nav-item" id="nav-statistics" data-label="Statistics" onClick={() => window.showSection('statistics')}>
              <span className="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>
              <span className="nav-item-label">Statistics</span>
            </div>
            <div className="nav-section-label">System</div>
            <div className="nav-item" id="nav-settings" data-label="Settings" onClick={() => window.showSection('settings')}>
              <span className="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
              <span className="nav-item-label">Settings</span>
            </div>
            <div className="nav-item" id="nav-archive" data-label="Archive" onClick={() => window.showSection('archive')}>
              <span className="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></span>
              <span className="nav-item-label">Archive</span>
            </div>
          </nav>

          <div className="sidebar-footer">
            {/* Hidden targets kept for admin.js — user info lives in topbar chip */}
            <span id="sb-user-name" style={{ display: 'none' }} />
            <span id="sb-avatar" style={{ display: 'none' }} />

            <button className="sidebar-signout-btn" data-label="Sign Out" onClick={() => window.doLogout()}>
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              <span className="nav-item-label">Sign Out</span>
            </button>
          </div>
        </aside>

        {/* MAIN CONTENT */}
        <div className="main-content">
          <header className="topbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button className="hamburger-btn" onClick={() => window._adminToggleSidebar?.()}>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              </button>
              <span className="topbar-title" id="topbar-title">Dashboard</span>
            </div>
            <div className="topbar-actions">
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }} id="topbar-date" />

              {/* Dark mode toggle */}
              <div className="dm-toggle" title="Toggle dark mode">
                <input type="checkbox" id="dm-checkbox" onChange={() => window.toggleDarkMode()} />
                <span className="dm-button"></span>
                <span className="dm-label" id="dm-label">☼</span>
              </div>

              {/* User chip */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f3f4f6', borderRadius: '100px', padding: '4px 12px 4px 4px', cursor: 'default' }}>
                <div id="topbar-avatar" style={{ width: '28px', height: '28px', background: 'var(--accent)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#fff', flexShrink: 0 }}>A</div>
                <span id="topbar-admin-name" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--primary)', whiteSpace: 'nowrap' }}>Administrator</span>
              </div>
            </div>
          </header>

          <div className="content-area">

            {/* DASHBOARD */}
            <section id="section-dashboard" className="admin-section">
              <div className="section-header">
                <div>
                  <div className="section-title">Dashboard</div>
                  <div className="section-subtitle" id="dashboard-department-title" style={{ marginTop: '6px', fontSize: '22px', fontWeight: 800, color: 'var(--primary)', letterSpacing: '-0.03em', lineHeight: 1.15 }} />
                  <div className="section-subtitle">Overview and predictive analytics</div>
                </div>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }} id="dash-refresh-time" />
              </div>
              <div className="stats-grid" id="dash-stats" />
              <div className="analytics-section">
                <div className="analytics-section-heading">
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                  Predictive Analytics
                </div>
                <div className="analytics-grid" id="dash-analytics" />
              </div>
              <div className="dashboard-panels-grid">
                <div className="card">
                  <div className="card-header"><span className="card-title">Recent Exams</span></div>
                  <div className="card-body" id="dash-recent-exams" style={{ padding: 0 }} />
                </div>
                <div className="card">
                  <div className="card-header"><span className="card-title">Active Sessions</span></div>
                  <div className="card-body" id="dash-active-sessions" style={{ padding: 0 }} />
                </div>
              </div>
            </section>

            {/* SUBJECTS (Courses) */}
            <section id="section-subjects" className="admin-section hidden">
              <div className="section-header">
                <div>
                  <div className="section-title">Courses</div>
                  <div className="section-subtitle" id="courses-department-title" style={{ marginTop: '6px', fontSize: '20px', fontWeight: 800, color: 'var(--primary)', letterSpacing: '-0.02em', lineHeight: 1.2 }} />
                  <div className="section-subtitle">Manage courses and their target year levels &amp; sections</div>
                </div>
                <button className="btn btn-primary" onClick={() => window.openSubjectModal()}>+ Add Course</button>
              </div>
              <div id="course-cards-grid" className="course-cards-grid" />
            </section>

            {/* STUDENTS */}
            <section id="section-students" className="admin-section hidden">
              <div className="section-header section-header-students">
                <div className="section-header-copy">
                  <div className="section-title">Students</div>
                  <div className="section-subtitle">Manage enrolled students</div>
                </div>
                <div className="students-toolbar">
                  <div className="students-filters">
                    <select id="filter-year-level" className="form-control filter-select" onChange={() => window.filterStudents()}>
                      <option value="">All Year Levels</option>
                      <option value="1st Year">1st Year</option>
                      <option value="2nd Year">2nd Year</option>
                      <option value="3rd Year">3rd Year</option>
                      <option value="4th Year">4th Year</option>
                      <option value="5th Year">5th Year</option>
                    </select>
                    <select id="filter-section" className="form-control filter-select" onChange={() => window.filterStudents()}>
                      <option value="">All Sections</option>
                    </select>
                    <select id="filter-program" className="form-control filter-select" onChange={() => window.filterStudents()}>
                      <option value="">All Programs</option>
                    </select>
                    <select id="filter-course" className="form-control filter-select" onChange={() => window.filterStudents()}>
                      <option value="">All Courses</option>
                    </select>
                  </div>
                  <button className="btn btn-primary" onClick={() => window.openStudentModal()}>+ Add Student</button>
                </div>
              </div>
              <div className="toolbar" style={{ gap: '10px', marginBottom: '16px' }}>
                <div className="search-input" style={{ flex: 1 }}>
                  <span className="search-icon"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
                  <input type="text" id="student-search" placeholder="Search students..." onInput={() => window.filterStudents()} />
                </div>
              </div>
              <div className="card">
                <div className="card-body" style={{ padding: 0 }}>
                  <div className="table-wrapper">
                    <table>
                      <thead><tr><th>Student ID</th><th>Name</th><th>Year Level</th><th>Section</th><th>Email</th><th>Program</th><th style={{ textAlign: 'center' }}>Actions</th></tr></thead>
                      <tbody id="students-tbody" />
                    </table>
                  </div>
                </div>
              </div>
            </section>

            {/* EXAMS — two views: grid and inline editor */}
            <section id="section-exams" className="admin-section hidden" style={{ padding: 0 }}>

              {/* VIEW 1: Cards grid */}
              <div id="exams-list-view" style={{ padding: '28px' }}>
                <div className="section-header">
                  <div>
                    <div className="section-title">Exams</div>
                    <div className="section-subtitle">Create and manage examinations</div>
                  </div>
                  <button className="btn btn-primary" onClick={() => window.openExamEditor()}>+ Create Exam</button>
                </div>
                <div id="exams-grid" className="exam-cards-grid" />
              </div>

              {/* VIEW 2: Inline exam editor (Google Forms style) */}
              <div id="exam-editor-view" className="hidden">
                {/* Top bar */}
                <div className="exam-editor-topbar">
                  <button className="exam-editor-back" onClick={() => window.closeExamEditor()}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                    Exams
                  </button>
                  <div className="exam-editor-topbar-center">
                    <span id="exam-editor-title-display" className="exam-editor-name">New Exam</span>
                    <span id="exam-editor-status-badge" />
                  </div>
                  <div className="exam-editor-topbar-actions">
                    <button className="btn btn-secondary btn-sm" id="exam-editor-status-btn" onClick={() => window.handleExamEditorStatusAction()} style={{ display: 'none' }} />
                    <button className="btn btn-secondary btn-sm" onClick={() => window.saveExamFromEditor()}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                      Save Draft
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => window.saveAndActivateExam()}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                      Ready
                    </button>
                  </div>
                </div>

                {/* Editor body — scrollable */}
                <div className="exam-editor-body">

                  {/* Details card */}
                  <div className="exam-editor-section-card">
                    <div className="exam-editor-section-label">
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      Exam Details
                    </div>
                    <input type="hidden" id="exam-id" />
                    <div className="form-row cols-2">
                      <div className="form-group"><label>Exam Title *</label><input type="text" className="form-control" id="exam-title-field" placeholder="e.g. Midterm Examination" onInput={() => { const v = document.getElementById('exam-title-field').value; const el = document.getElementById('exam-editor-title-display'); if(el) el.textContent = v || 'New Exam'; }} /></div>
                      <div className="form-group"><label>Subject/Course *</label><select className="form-control" id="exam-subject-field" /></div>
                    </div>
                    <div className="form-group"><label>Description</label><textarea className="form-control" id="exam-desc-field" rows="2" placeholder="Optional exam description" /></div>
                    <div className="form-row cols-2">
                      <div className="form-group"><label>Time Limit (minutes) *</label><input type="number" className="form-control" id="exam-timelimit-field" defaultValue="60" min="1" max="300" /></div>
                      <div className="form-group">
                        <label>Exam Code</label>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <input type="text" className="form-control" id="exam-code-field" placeholder="Auto-generated on Ready" maxLength={10} style={{ textTransform: 'uppercase', flex: 1 }} />
                          <button type="button" className="btn btn-secondary" onClick={() => window.generateAndSetCode()} style={{ whiteSpace: 'nowrap' }}>Generate</button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => window.copyExamCodeFromField()}
                            title="Copy exam code"
                            aria-label="Copy exam code"
                            style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '42px', paddingInline: '12px' }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '20px', marginTop: '8px', flexWrap: 'wrap' }}>
                      {[
                        ['exam-shuffle-q',     'Shuffle Questions', null],
                        ['exam-shuffle-a',     'Shuffle Answers', null],
                        ['exam-require-camera','Motion Detection', {text:'REMOTE', bg:'#dbeafe', color:'#1e40af'}],
                        ['exam-ai-detect',     'AI Detection', {text:'ESSAYS', bg:'#fef9c3', color:'#92400e'}],
                        ['exam-allow-review',  'Allow Review',  {text:'STUDENTS', bg:'#dcfce7', color:'#166534'}],
                      ].map(([id, label, badge]) => (
                        <label key={id} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                          <div className="checkbox-wrapper-30">
                            <div className="checkbox" style={{'--size':'1.0','--stroke':'#1a6b35'}}>
                              <input type="checkbox" id={id} />
                              <svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="3" className="cb-border"/><polyline points="20,6 9,17 4,12" className="cb-check"/></svg>
                            </div>
                          </div>
                          <span>{label}{badge && <span style={{ fontSize: '10px', background: badge.bg, color: badge.color, padding: '1px 6px', borderRadius: '10px', fontWeight: 700, marginLeft: '4px' }}>{badge.text}</span>}</span>
                        </label>
                      ))}
                    </div>
                    {/* Hidden audience inputs kept for saveExamFromEditor compatibility */}
                    <div style={{ display: 'none' }}>
                      <div id="exam-year-checks" />
                      <div id="exam-section-checks" />
                    </div>
                  </div>

                  {/* Questions area */}
                  <div className="exam-editor-section-card" id="exam-editor-questions-card" style={{ display: 'none' }}>
                    <div className="exam-editor-section-label">
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                      Questions <span id="exam-q-count" className="exam-q-badge" style={{ marginLeft: '6px' }} />
                    </div>
                    <div id="questions-list" />
                    <div className="exam-add-q-bar">
                      {[
                        ['mcq',            'Multiple Choice'],
                        ['checkbox',       'Checkboxes'],
                        ['tf',             'True / False'],
                        ['identification', 'Identification'],
                        ['enumeration',    'Enumeration'],
                        ['matching',       'Matching Type'],
                        ['essay',          'Essay'],
                        ['coding',         'Coding'],
                      ].map(([type, label]) => (
                        <button key={type} className="add-q-btn" onClick={() => window.addQuestion(type)}>
                          {label}
                        </button>
                      ))}
                      <button className="add-q-btn add-q-ai" onClick={() => window.openAIGen()}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                        AI Generate
                      </button>
                    </div>
                  </div>

                </div>
              </div>
            </section>

            {/* MONITORING */}
            <section id="section-monitoring" className="admin-section hidden">
              <div className="monitor-topbar">
                <div>
                  <div className="section-title" style={{ marginBottom: '2px' }}>Live Monitoring</div>
                  <div className="section-subtitle">Real-time student exam activity</div>
                </div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <span id="monitor-live-badge" className="hidden monitor-live-chip">
                    <span className="live-dot" />LIVE
                  </span>
                  <select className="form-control filter-select" id="monitor-exam-select" onChange={() => window.onMonitorExamChange()}>
                    <option value="">Select an exam to monitor</option>
                  </select>
                  <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: '8px', padding: '2px' }}>
                    <button id="monitor-view-table" onClick={() => window.setMonitorView('table')}
                      style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 700, background: '#1a4d2a', color: '#fff', transition: 'all 0.15s' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: '4px' }}><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                      Sessions
                    </button>
                    <button id="monitor-view-camera" onClick={() => window.setMonitorView('camera')}
                      style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 700, background: 'transparent', color: '#6b7280', transition: 'all 0.15s' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: '4px' }}><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                      Camera Grid
                    </button>
                  </div>
                </div>
              </div>
              {/* Camera grid view */}
              <div id="camera-grid-view" style={{ display: 'none', padding: '0' }}>
                <div id="camera-grid-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '3px', background: '#0a0a0a', minHeight: '320px', borderRadius: '0 0 12px 12px', padding: '3px' }} />
                <div id="camera-grid-empty" style={{ display: 'none', padding: '48px', textAlign: 'center', color: '#9ca3af', background: '#111', borderRadius: '0 0 12px 12px' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="1.5" style={{ marginBottom: '12px' }}><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#6b7280' }}>No camera feeds available</div>
                  <div style={{ fontSize: '12px', marginTop: '4px', color: '#4b5563' }}>Camera feeds appear here when students have Motion Detection enabled</div>
                </div>
              </div>

              <div className="monitoring-grid" id="monitoring-grid">
                <div className="card" style={{ overflow: 'hidden' }}>
                  <div className="card-header" style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <span className="card-title">Student Sessions</span>
                    <span id="monitor-count" className="monitor-count-chip">0 students</span>
                  </div>
                  <div className="table-wrapper">
                    <table>
                      <thead><tr><th>Student</th><th style={{textAlign:'center'}}>Progress</th><th style={{textAlign:'center'}}>Warnings</th><th style={{textAlign:'center'}}>Status</th><th style={{textAlign:'center'}}>Logs</th><th style={{textAlign:'center'}}>Actions</th></tr></thead>
                      <tbody id="monitor-tbody" />
                    </table>
                  </div>
                </div>
                <div className="activity-log" id="activity-log-panel">
                  <div className="activity-log-header">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    Activity Log
                    <span id="log-student-name" style={{ fontWeight: 500, fontSize: '12px', color: '#9ca3af' }} />
                    <button id="btn-export-log" onClick={() => window.exportActivityLog?.()} title="Export Activity Log as CSV" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '5px', background: 'none', border: '1px solid #d1d5db', borderRadius: '6px', padding: '3px 10px', fontSize: '11px', fontWeight: 600, color: '#374151', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Export CSV
                    </button>
                  </div>
                  <div className="activity-log-body" id="log-body">
                    <div className="empty-state"><p>Select a student to view activity</p></div>
                  </div>
                </div>
              </div>
            </section>

            {/* REPORTS */}
            <section id="section-reports" className="admin-section hidden">
              <div className="section-header">
                <div>
                  <div className="section-title">Reports</div>
                  <div className="section-subtitle">Exam results and analytics</div>
                </div>
              </div>
              <div className="toolbar reports-toolbar" style={{ marginBottom: '20px' }}>
                <div className="reports-toolbar-select">
                  <select className="form-control" id="report-exam-select" onChange={() => window.renderReportTable()}>
                    <option value="">Select an exam to review results</option>
                  </select>
                </div>
                <div className="reports-toolbar-actions">
                  <button className="btn btn-secondary" onClick={() => window.exportExamReportPdf()} id="btn-generate-pdf">Export PDF</button>
                  <button className="btn btn-success" onClick={() => window.releaseScores()} id="btn-release-scores" disabled>Release Scores to Students</button>
                </div>
              </div>
              <div className="card" id="report-card">
                <div className="card-header">
                  <span className="card-title" id="report-exam-title">Choose an exam to load results and rankings</span>
                  <div style={{ display: 'flex', gap: '8px' }} id="report-summary" className="hidden">
                    <span className="badge badge-info" id="report-submitted-count" />
                    <span className="badge badge-success" id="report-avg-score" />
                  </div>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  <div className="table-wrapper">
                    <table>
                      <thead><tr><th>Rank</th><th>Name</th><th>Student ID</th><th>Year / Section</th><th>Score</th><th>Percentage</th><th>Submitted</th><th>Actions</th></tr></thead>
                      <tbody id="report-tbody" />
                    </table>
                  </div>
                </div>
              </div>
            </section>

            {/* STATISTICS */}
            <section id="section-statistics" className="admin-section hidden">
              <div className="section-header">
                <div>
                  <div className="section-title">Statistics</div>
                  <div className="section-subtitle">Detailed per-exam analytics and performance insights</div>
                </div>
              </div>
              <div style={{ background: '#fff', borderRadius: '14px', padding: '16px 20px', marginBottom: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                <label style={{ fontSize: '12px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.7px', whiteSpace: 'nowrap' }}>Exam Analytics</label>
                <select className="form-control" id="stats-exam-select" onChange={() => window.renderExamStats()} style={{ flex: 1, minWidth: '240px', maxWidth: '400px' }}>
                  <option value="">Select an exam to explore analytics</option>
                </select>
              </div>
              <div id="stats-content">
                <div className="dash-empty"><div className="dash-empty-title">No exam selected</div><div className="dash-empty-sub">Pick an exam above to view performance trends, scores, and question insights.</div></div>
              </div>
            </section>

            {/* SETTINGS */}
            <section id="section-settings" className="admin-section hidden">
              <div className="section-header">
                <div>
                  <div className="section-title">Settings</div>
                  <div className="section-subtitle">System configuration</div>
                </div>
              </div>
              <div className="settings-intro-panel">
                <div className="card">
                  <div className="card-header"><span className="card-title">Groq AI Integration</span></div>
                  <div className="card-body">
                    <p className="text-muted" style={{ fontSize: '13px', marginBottom: '12px' }}>Required for AI-powered exam generation from uploaded files (PDF, DOCX, PPTX, TXT). Get your key at <strong>console.groq.com</strong>.</p>
                    <div className="form-group">
                      <label>Groq API Key</label>
                      <div style={{ position: 'relative' }}>
                        <input type="password" className="form-control" id="set-claude-api-key" placeholder="gsk_..." style={{ paddingRight: '42px', fontFamily: 'monospace' }} />
                        <button type="button" onClick={(e) => window.togglePassword('set-claude-api-key', e.currentTarget)} tabIndex={-1} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#666' }}>
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        </button>
                      </div>
                      <div className="text-muted" style={{ fontSize: '12px', marginTop: '6px' }}>Reveal requires your professor account password.</div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <button className="btn btn-primary" onClick={() => window.saveClaudeApiKey()}>Save API Key</button>
                      <button className="btn btn-secondary" onClick={() => window.testGroqKey()}>Test Connection</button>
                      <span id="groq-test-result" style={{ fontSize: '13px' }} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="settings-main-grid">
                <div className="card settings-account-card">
                  <div className="card-header"><span className="card-title">Account Information</span></div>
                  <div className="card-body">
                    <div className="form-group"><label>Professor Name</label><input type="text" className="form-control" id="set-admin-name" /></div>
                    <div className="form-group"><label>Professor Username</label><input type="text" className="form-control" id="set-admin-username" autoComplete="username" /></div>
                    <div className="form-group"><label>Professor Email</label><input type="email" className="form-control" id="set-admin-email" /></div>
                    <div className="form-group">
                      <label>Department</label>
                      <select className="form-control" id="set-department">
                        <option value="">Select Department</option>
                        <option value="College of Arts & Sciences (CAS)">College of Arts & Sciences (CAS)</option>
                        <option value="College of Education (COE)">College of Education (COE)</option>
                        <option value="College of Business & Accountancy (CBA)">College of Business & Accountancy (CBA)</option>
                        <option value="College of Computer Studies (CCS)">College of Computer Studies (CCS)</option>
                        <option value="College of Engineering (COE)">College of Engineering (COE)</option>
                        <option value="College of Nursing (CON)">College of Nursing (CON)</option>
                      </select>
                    </div>
                    <div className="sa-card-actions">
                      <button className="btn btn-primary" onClick={() => window.saveSettings()}>Save Settings</button>
                    </div>
                  </div>
                </div>
                <div className="card settings-password-card">
                  <div className="card-header"><span className="card-title">Change Password</span></div>
                  <div className="card-body">
                    <div className="form-group"><label>Current Password</label><input type="password" className="form-control" id="set-cur-pass" /></div>
                    <div className="form-group"><label>New Password</label><input type="password" className="form-control" id="set-new-pass" /></div>
                    <div className="form-group"><label>Confirm New Password</label><input type="password" className="form-control" id="set-confirm-pass" /></div>
                    <div className="sa-card-actions">
                      <button className="btn btn-warning" onClick={() => window.changePassword()}>Change Password</button>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* ARCHIVE */}
            <section id="section-archive" className="admin-section hidden">
              <div className="section-header">
                <div>
                  <div className="section-title">Archive</div>
                  <div className="section-subtitle">Archived items — restore or permanently delete</div>
                </div>
              </div>
              <input type="hidden" id="archive-active-tab" defaultValue="exams" />
              <div className="tab-switcher" style={{ marginBottom: '16px' }}>
                <button className="tab-btn active" id="archive-tab-exams" onClick={() => window.renderArchive('exams')}>Exams</button>
                <button className="tab-btn" id="archive-tab-students" onClick={() => window.renderArchive('students')}>Students</button>
                <button className="tab-btn" id="archive-tab-courses" onClick={() => window.renderArchive('courses')}>Courses</button>
              </div>
              <div id="archive-exams-table" className="card">
                <div className="card-body" style={{ padding: 0 }}>
                  <div className="table-wrapper">
                    <table><thead><tr><th>Title</th><th>Subject</th><th style={{ textAlign: 'center' }}>Code</th><th style={{ textAlign: 'center' }}>Questions</th><th style={{ textAlign: 'center' }}>Time</th><th style={{ textAlign: 'center' }}>Archived</th><th style={{ textAlign: 'center' }}>Actions</th></tr></thead><tbody id="archive-tbody" /></table>
                  </div>
                </div>
              </div>
              <div id="archive-courses-table" className="card hidden">
                <div className="card-body" style={{ padding: 0 }}>
                  <div className="table-wrapper">
                    <table><thead><tr><th>Code</th><th>Course Name</th><th>Year Level</th><th>Sections</th><th style={{ textAlign: 'center' }}>Archived</th><th style={{ textAlign: 'center' }}>Actions</th></tr></thead><tbody id="archive-courses-tbody" /></table>
                  </div>
                </div>
              </div>
              <div id="archive-students-table" className="card hidden">
                <div className="card-body" style={{ padding: 0 }}>
                  <div className="table-wrapper">
                    <table><thead><tr><th>Student ID</th><th>Name</th><th style={{ textAlign: 'center' }}>Year Level</th><th style={{ textAlign: 'center' }}>Section</th><th style={{ textAlign: 'center' }}>Archived</th><th style={{ textAlign: 'center' }}>Actions</th></tr></thead><tbody id="archive-students-tbody" /></table>
                  </div>
                </div>
              </div>
            </section>

          </div>{/* /content-area */}
        </div>{/* /main-content */}
      </div>{/* /admin-layout */}

      {/* ===== MODALS ===== */}

      <div className="modal-backdrop hidden" id="modal-more-actions">
        <div className="modal-dialog modal-sm">
          <div className="modal-header"><span className="modal-title" id="modal-more-title">More Actions</span><button className="modal-close" onClick={() => window.closeModal('modal-more-actions')}>&#10005;</button></div>
          <div className="modal-body" id="modal-more-body" style={{ padding: '8px 0' }} />
        </div>
      </div>

      <div className="modal-backdrop hidden" id="modal-subject">
        <div className="modal-dialog">
          <div className="modal-header"><span className="modal-title" id="modal-subject-title">Add Course</span><button className="modal-close" onClick={() => window.closeModal('modal-subject')}>&#10005;</button></div>
          <div className="modal-body">
            <input type="hidden" id="subj-id" />
            <div className="form-row cols-2">
              <div className="form-group"><label>Course Code *</label><input type="text" className="form-control" id="subj-code" placeholder="e.g. CS101" /></div>
              <div className="form-group"><label>Course Name *</label><input type="text" className="form-control" id="subj-name" placeholder="e.g. Introduction to Computing" /></div>
            </div>
            <div className="form-group"><label>Description</label><textarea className="form-control" id="subj-desc" rows="2" placeholder="Brief description..." /></div>
            <div className="form-row cols-2" style={{ marginBottom: 0 }}>
              <div className="form-group">
                <label>Year Level</label>
                <select className="form-control" id="subj-year-level">
                  <option value="">— All Year Levels —</option>
                  <option value="1st Year">1st Year</option>
                  <option value="2nd Year">2nd Year</option>
                  <option value="3rd Year">3rd Year</option>
                  <option value="4th Year">4th Year</option>
                </select>
              </div>
              <div className="form-group">
                <label>Section</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '12px 14px', border: '1.5px solid var(--border)', borderRadius: '10px', background: '#f9fafb' }}>
                  {['A','B','C','D','E'].map(s => (
                    <label key={s} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, minWidth: '48px' }}>
                      <div className="checkbox-wrapper-30"><div className="checkbox" style={{'--size':'0.9','--stroke':'#1a6b35'}}><input type="checkbox" className="subj-section-cb" value={`Section ${s}`} /><svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="3" className="cb-border"/><polyline points="20,6 9,17 4,12" className="cb-check"/></svg></div></div>
                      {s}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="form-group" style={{ marginTop: '14px' }}>
              <label>Student Enrollment Code</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input type="text" className="form-control" id="subj-enroll-code" placeholder="Auto-generated" maxLength={8} style={{ textTransform: 'uppercase', fontFamily: 'monospace', fontWeight: 600, letterSpacing: '2px', flex: 1 }} readOnly />
                <button type="button" className="btn btn-secondary" onClick={() => window.regenerateEnrollCode()}>Regenerate</button>
              </div>
              <p className="text-muted" style={{ fontSize: '12px', marginTop: '4px' }}>Share this code so students can self-enroll.</p>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => window.closeModal('modal-subject')}>Cancel</button>
            <button className="btn btn-primary" onClick={() => window.saveSubject()}>Save Course</button>
          </div>
        </div>
      </div>

      <div className="modal-backdrop hidden" id="modal-student">
        <div className="modal-dialog">
          <div className="modal-header"><span className="modal-title" id="modal-student-title">Add Student</span><button className="modal-close" onClick={() => window.closeModal('modal-student')}>&#10005;</button></div>
          <div className="modal-body">
            <input type="hidden" id="stu-id" />
            <div className="form-row cols-2">
              <div className="form-group"><label>Student ID *</label><input type="text" className="form-control" id="stu-student-id" placeholder="e.g. 23-00218" inputMode="numeric" maxLength={8} /></div>
              <div className="form-group"><label>Full Name *</label><input type="text" className="form-control" id="stu-name" placeholder="Last, First Middle" /></div>
            </div>
            <div className="form-row cols-2">
              <div className="form-group"><label>Year Level</label><select className="form-control" id="stu-year"><option value="">— Select Year Level —</option></select></div>
              <div className="form-group"><label>Section</label><select className="form-control" id="stu-section"><option value="">— Select Section —</option></select></div>
            </div>
            <div className="form-group"><label>Email</label><input type="email" className="form-control" id="stu-email" placeholder="student@school.edu" /></div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => window.closeModal('modal-student')}>Cancel</button>
            <button className="btn btn-primary" onClick={() => window.saveStudent()}>Save Student</button>
          </div>
        </div>
      </div>

      {/* modal-exam kept as empty shell so closeModal calls don't error */}
      <div className="modal-backdrop hidden" id="modal-exam" />

      <div className="modal-backdrop hidden" id="modal-exam-results">
        <div className="modal-dialog modal-xl">
          <div className="modal-header"><span className="modal-title" id="modal-results-title">Exam Results</span><button className="modal-close" onClick={() => window.closeModal('modal-exam-results')}>&#10005;</button></div>
          <div className="modal-body" id="modal-results-body" />
          <div className="modal-footer"><button className="btn btn-secondary" onClick={() => window.closeModal('modal-exam-results')}>Close</button></div>
        </div>
      </div>

      <div className="modal-backdrop hidden" id="modal-student-answers">
        <div className="modal-dialog modal-lg">
          <div className="modal-header"><span className="modal-title" id="modal-answers-title">Student Answers</span><button className="modal-close" onClick={() => window.closeModal('modal-student-answers')}>&#10005;</button></div>
          <div className="modal-body" id="modal-answers-body" />
          <div className="modal-footer"><button className="btn btn-secondary" onClick={() => window.closeModal('modal-student-answers')}>Close</button></div>
        </div>
      </div>

      <div className="modal-backdrop hidden" id="modal-confirm">
        <div className="modal-dialog modal-sm">
          <div className="modal-body confirm-dialog" id="confirm-body" />
        </div>
      </div>

      <div className="modal-backdrop hidden" id="modal-enrolled-students">
        <div className="modal-dialog modal-lg">
          <div className="modal-header">
            <div><span className="modal-title" id="modal-enrolled-title">Enrolled Students</span><div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '2px' }} id="modal-enrolled-sub" /></div>
            <button className="modal-close" onClick={() => window.closeModal('modal-enrolled-students')}>&#10005;</button>
          </div>
          <div className="modal-body" id="modal-enrolled-body" style={{ padding: 0 }} />
          <div className="modal-footer"><button className="btn btn-secondary" onClick={() => window.closeModal('modal-enrolled-students')}>Close</button></div>
        </div>
      </div>

      <div className="modal-backdrop hidden" id="modal-camera-snap">
        <div className="modal-dialog modal-sm">
          <div className="modal-header"><span className="modal-title" id="modal-cam-title">Student Camera</span><button className="modal-close" onClick={() => window.closeModal('modal-camera-snap')}>&#10005;</button></div>
          <div className="modal-body" style={{ textAlign: 'center' }}>
            <img id="modal-cam-img" src="/plp-logo.png" alt="Camera snapshot" style={{ maxWidth: '100%', borderRadius: '10px', border: '1px solid var(--border)', display: 'none' }} />
            <p id="modal-cam-time" className="text-muted" style={{ fontSize: '12px', marginTop: '8px' }} />
            <div id="modal-cam-empty" className="text-muted" style={{ padding: '24px', fontSize: '14px' }}>No camera snapshot available for this student.</div>
          </div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={() => window.closeModal('modal-camera-snap')}>Close</button></div>
        </div>
      </div>

      {/* AI Exam Generator */}
      <div className="modal-backdrop hidden" id="modal-ai-gen" style={{ alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) setDiffOpen(false); }}>
        <div style={{ background: '#fff', borderRadius: '20px', width: '96%', maxWidth: '780px', height: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.18)', overflow: 'hidden', animation: 'aiModalIn 0.28s cubic-bezier(0.34,1.56,0.64,1)' }}>

          {/* Header */}
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
            <div style={{ width: '38px', height: '38px', borderRadius: '12px', overflow: 'hidden', flexShrink: 0, background: '#f0f7f2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img src="/plp-logo.png" alt="PLP" style={{ width: '32px', height: '32px', objectFit: 'contain' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: '14px', color: '#0f2d1a' }}>TUKLAS AI</div>
              <div style={{ fontSize: '11px', color: '#16a34a', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '6px', height: '6px', background: '#16a34a', borderRadius: '50%', display: 'inline-block', animation: 'aiBlink 2s ease-in-out infinite' }} />
                Ready to generate
              </div>
            </div>
            <button onClick={() => window.closeAIGen()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '20px', lineHeight: 1, padding: '4px' }}>&#10005;</button>
          </div>

          {/* Hidden sync inputs for admin.js */}
          <select id="ai-difficulty" value={aiDiff} onChange={(e) => setAiDiff(e.target.value)} style={{ display:'none' }} />
          <input id="ai-count" type="number" value={aiCountValue} readOnly style={{ display:'none' }} />
          <input id="ai-mode" type="hidden" value={aiMode} readOnly />
          <div id="ai-drop-zone" style={{ display:'none' }} />
          <input type="file" id="ai-file-input" accept=".pdf,.docx,.pptx,.txt" multiple style={{ display:'none' }} onChange={(e) => window.handleAIFileSelect(e.target.files)} />

          {/* ── Unified scrollable content (#ai-chat-body scrolled by admin.js) ── */}
          <div id="ai-chat-body" style={{ flex:1, overflowY:'auto' }}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('ai-drag-over'); }}
            onDragLeave={(e) => e.currentTarget.classList.remove('ai-drag-over')}
            onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('ai-drag-over'); window.handleAIFileDrop(e.dataTransfer.files); }}
            onClick={() => setDiffOpen(false)}>

            {/* ── Mode-specific content (animated on switch) ── */}
            <div key={aiMode} style={{ animation: aiMode==='quick' ? 'quickModeIn 0.28s cubic-bezier(0.25,0.46,0.45,0.94)' : 'customModeIn 0.28s cubic-bezier(0.25,0.46,0.45,0.94)' }}>
              {aiMode === 'quick' ? (
                /* QUICK: form */
                <div style={{ padding:'32px 36px', display:'flex', flexDirection:'column', gap:'28px' }}>
                  <div>
                    <div style={{ fontSize:'11px', fontWeight:800, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:'10px' }}>Number of Questions</div>
                    <div style={{ display:'flex', alignItems:'center', background:'#fff', border:'1.5px solid #a3c4a8', borderRadius:'12px', padding:'10px 16px', width:'fit-content' }}>
                      <button type="button" onClick={() => setAiCountInput(String(Math.max(1, aiCountValue - 1)))} style={{ background:'none', border:'none', cursor:'pointer', color:'#1a4d2a', fontWeight:700, fontSize:'18px', lineHeight:1, padding:'0 8px 0 0' }}>−</button>
                      <input type="number" min="1" max="100" value={aiCountInput} onChange={(e) => handleAiCountChange(e.target.value)} onBlur={normalizeAiCountInput}
                        style={{ width:'52px', border:'none', outline:'none', fontWeight:800, fontSize:'22px', textAlign:'center', background:'transparent', color:'#0f2d1a' }} />
                      <button type="button" onClick={() => setAiCountInput(String(Math.min(100, aiCountValue + 1)))} style={{ background:'none', border:'none', cursor:'pointer', color:'#1a4d2a', fontWeight:700, fontSize:'18px', lineHeight:1, padding:'0 0 0 8px' }}>+</button>
                      <span style={{ fontSize:'12px', color:'#1a4d2a', fontWeight:700, marginLeft:'10px', paddingLeft:'10px', borderLeft:'1px solid #d1fae5' }}>questions</span>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize:'11px', fontWeight:800, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:'10px' }}>Difficulty</div>
                    <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
                      {[['mixed','Mixed'],['easy','Easy'],['medium','Medium'],['hard','Hard']].map(([v,l]) => (
                        <button key={v} type="button" onClick={() => setAiDiff(v)}
                          style={{ padding:'8px 20px', borderRadius:'10px', fontSize:'13px', fontWeight:700, border:'1.5px solid #1a4d2a', cursor:'pointer', transition:'all 0.15s', background:aiDiff===v?'#1a4d2a':'#fff', color:aiDiff===v?'#fff':'#1a4d2a' }}>
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize:'11px', fontWeight:800, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:'10px' }}>Question Types</div>
                    <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
                      {[['mcq','Multiple Choice',true],['tf','True / False',true],['identification','Identification',true],['enumeration','Enumeration',false],['matching','Matching',false],['essay','Essay',false],['coding','Coding',false]].map(([val,label,checked]) => (
                        <label key={val} style={{ cursor:'pointer', userSelect:'none' }}>
                          <input type="checkbox" className="ai-type-cb" value={val} defaultChecked={checked} style={{ display:'none' }} />
                          <span style={{ display:'inline-block', padding:'8px 16px', borderRadius:'10px', fontSize:'13px', fontWeight:700, border:'1.5px solid #1a4d2a', color:checked?'#fff':'#1a4d2a', background:checked?'#1a4d2a':'#fff', transition:'all 0.15s', userSelect:'none' }}
                            onClick={(e) => {
                              e.preventDefault(); e.stopPropagation();
                              const cb = e.currentTarget.closest('label').querySelector('input[type="checkbox"]');
                              if (!cb) return;
                              cb.checked = !cb.checked;
                              e.currentTarget.style.background = cb.checked?'#1a4d2a':'#fff';
                              e.currentTarget.style.color = cb.checked?'#fff':'#1a4d2a';
                            }}>{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                /* CUSTOM: welcome bubble only */
                <div style={{ padding:'24px 24px 0', display:'flex', gap:'10px', alignItems:'flex-end', animation:'aiBubbleIn 0.3s ease' }}>
                  <div style={{ width:'32px', height:'32px', borderRadius:'50%', flexShrink:0, background:'#f0f7f2', display:'flex', alignItems:'center', justifyContent:'center', border:'1px solid #d1fae5' }}>
                    <img src="/plp-logo.png" alt="PLP" style={{ width:'24px', height:'24px', objectFit:'contain' }} />
                  </div>
                  <div style={{ background:'#f3f4f6', borderRadius:'16px 16px 16px 4px', padding:'13px 17px', maxWidth:'82%', fontSize:'13px', color:'#374151', lineHeight:1.55 }}>
                    Attach your course materials, then describe exactly what you want — how many questions, types, and difficulty.
                  </div>
                </div>
              )}
            </div>

            {/* ── Always-present shared elements (always in DOM for admin.js) ── */}
            <div style={{ padding:'16px 24px', display:'flex', flexDirection:'column', gap:'14px' }}>

              {/* User bubble — only meaningful in Custom mode */}
              <div id="ai-user-bubble" style={{ display:'none', justifyContent:'flex-end', animation:'aiBubbleIn 0.3s ease' }}>
                <div style={{ background:'#1a4d2a', borderRadius:'16px 16px 4px 16px', padding:'11px 15px', maxWidth:'78%' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a7f3d0" strokeWidth="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                    <span id="ai-user-bubble-file" style={{ color:'#d1fae5', fontWeight:600, fontSize:'12px', wordBreak:'break-all' }} />
                  </div>
                  <div id="ai-user-bubble-prompt" style={{ display:'none', color:'#fff', fontSize:'13px', marginTop:'7px', lineHeight:1.45 }} />
                </div>
              </div>

              {/* Typing indicator */}
              <div id="ai-status" style={{ display:'none', gap:'10px', alignItems:'flex-end' }}>
                <div style={{ width:'32px', height:'32px', borderRadius:'50%', flexShrink:0, background:'#f0f7f2', display:'flex', alignItems:'center', justifyContent:'center', border:'1px solid #d1fae5' }}>
                  <img src="/plp-logo.png" alt="PLP" style={{ width:'24px', height:'24px', objectFit:'contain' }} />
                </div>
                <div style={{ background:'#f3f4f6', borderRadius:'16px 16px 16px 4px', padding:'12px 16px' }}>
                  <div style={{ display:'flex', gap:'5px', alignItems:'center', marginBottom:'4px' }}>
                    {[0,0.2,0.4].map((d,i) => (
                      <span key={i} style={{ width:'7px', height:'7px', background:'#9ca3af', borderRadius:'50%', display:'inline-block', animation:`typingDot 1.2s ease-in-out ${d}s infinite` }} />
                    ))}
                  </div>
                  <span id="ai-status-text" style={{ fontSize:'11px', color:'#9ca3af' }}>Working…</span>
                </div>
              </div>

              {/* Generated questions */}
              <div id="ai-preview" style={{ display:'none', gap:'10px', alignItems:'flex-start', animation:'aiBubbleIn 0.35s ease' }}>
                <div style={{ width:'32px', height:'32px', borderRadius:'50%', flexShrink:0, marginTop:'2px', background:'#f0f7f2', display:'flex', alignItems:'center', justifyContent:'center', border:'1px solid #d1fae5' }}>
                  <img src="/plp-logo.png" alt="PLP" style={{ width:'24px', height:'24px', objectFit:'contain' }} />
                </div>
                <div style={{ flex:1, background:'#f3f4f6', borderRadius:'16px 16px 16px 4px', padding:'14px 16px', overflow:'hidden' }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'10px' }}>
                    <span id="ai-preview-title" style={{ fontWeight:700, fontSize:'13px', color:'#0f2d1a' }} />
                    <label style={{ display:'flex', alignItems:'center', gap:'7px', fontSize:'12px', cursor:'pointer', color:'#374151', fontWeight:600, userSelect:'none' }}>
                      <div className="checkbox-wrapper-30">
                        <div className="checkbox" style={{'--size':'0.9','--stroke':'#1a6b35'}}>
                          <input type="checkbox" id="ai-select-all" defaultChecked onChange={(e) => window.toggleAllAIQuestions(e.target.checked)} />
                          <svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="3" className="cb-border"/><polyline points="20,6 9,17 4,12" className="cb-check"/></svg>
                        </div>
                      </div>
                      Select All
                    </label>
                  </div>
                  <div id="ai-questions-preview" style={{ display:'flex', flexDirection:'column', gap:'8px', maxHeight:'260px', overflowY:'auto', paddingRight:'4px' }} />
                </div>
              </div>

            </div>
          </div>

          {/* ── Mode toggle bar ── */}
          <div style={{ padding:'10px 20px', background:'#f8fdf9', borderTop:'1px solid #e8f5ec', display:'flex', alignItems:'center', gap:'8px', flexShrink:0 }}>
            {[['quick','Quick'],['custom','Custom']].map(([m,l]) => (
              <button key={m} type="button" onClick={() => { setAiMode(m); setDiffOpen(false); }}
                style={{ padding:'6px 18px', borderRadius:'20px', fontSize:'12px', fontWeight:700, border:'1.5px solid #1a4d2a', cursor:'pointer', transition:'all 0.2s', background: aiMode===m ? '#1a4d2a' : 'transparent', color: aiMode===m ? '#fff' : '#1a4d2a' }}>
                {l}
              </button>
            ))}
            <span style={{ fontSize:'11px', color:'#9ca3af' }}>
              {aiMode==='quick' ? 'Structured options' : 'Free-form instructions'}
            </span>
          </div>

          {/* ── Input bar ── */}
          <div style={{ borderTop:'1px solid #e8f5ec', background:'#fff', flexShrink:0 }}>
            {/* Hidden textarea kept for admin.js in quick mode */}
            <textarea id="ai-custom-prompt"
              placeholder={aiMode==='quick' ? '' : 'e.g. Generate 30 questions — 20 MCQ and 10 identification, medium difficulty, focus on Chapter 3…'}
              style={{ display: aiMode==='quick' ? 'none' : 'none', position:'absolute' }}
              onKeyDown={(e) => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); window.runAIGenerate(); } }}
            />

            {aiMode === 'quick' ? (
              /* Quick: file attach zone */
              <div style={{ padding:'12px 18px 16px' }}
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('ai-file-drop-hover'); }}
                onDragLeave={(e) => e.currentTarget.classList.remove('ai-file-drop-hover')}
                onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('ai-file-drop-hover'); window.handleAIFileDrop(e.dataTransfer.files); }}>
                <div style={{ display:'flex', gap:'10px', alignItems:'center' }}>
                  {/* File zone — expands to show chip when file attached */}
                  <div id="ai-file-info" style={{ display:'none', flex:1, alignItems:'center', gap:'8px', background:'#e8f5ec', border:'1.5px solid #a3c4a8', borderRadius:'12px', padding:'10px 14px' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1a4d2a" strokeWidth="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                    <span id="ai-file-name" style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:'13px', fontWeight:600, color:'#0f2d1a' }} />
                    <button onClick={() => window.clearAIFile()} style={{ background:'none', border:'none', cursor:'pointer', color:'#6b7280', fontSize:'15px', lineHeight:1, padding:0, flexShrink:0 }}>✕</button>
                  </div>
                  {/* Attach button — shown when no file */}
                  <label id="ai-attach-btn" htmlFor="ai-file-input"
                    style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', border:'1.5px dashed #a3c4a8', borderRadius:'12px', padding:'11px 14px', cursor:'pointer', background:'#fafffe', transition:'all 0.15s', color:'#1a4d2a', fontWeight:600, fontSize:'13px' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background='#f0f7f2'; e.currentTarget.style.borderColor='#1a4d2a'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background='#fafffe'; e.currentTarget.style.borderColor='#a3c4a8'; }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1a4d2a" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    Attach or drop files
                  </label>
                  <button id="ai-gen-btn" onClick={() => window.runAIGenerate()} title="Generate"
                    style={{ width:'42px', height:'42px', background:'#1a4d2a', border:'none', borderRadius:'10px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'opacity 0.15s' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                  </button>
                  <button id="ai-import-btn" onClick={() => window.importAIQuestions()}
                    style={{ display:'none', height:'42px', padding:'0 18px', background:'#1a4d2a', border:'none', borderRadius:'10px', cursor:'pointer', color:'#fff', fontWeight:700, fontSize:'13px', flexShrink:0, whiteSpace:'nowrap', alignItems:'center', justifyContent:'center' }}>
                    Import Selected
                  </button>
                </div>
                <div style={{ marginTop:'8px', fontSize:'11px', color:'#6b7280' }}>
                  Supports multiple PDF, DOCX, PPTX, and TXT files up to 100MB each.
                </div>
              </div>
            ) : (
              /* Custom: textarea + paperclip + send */
              <>
                <div id="ai-file-info" style={{ display:'none', padding:'8px 18px 0', alignItems:'center' }}>
                  <div style={{ display:'inline-flex', alignItems:'center', gap:'8px', background:'#e8f5ec', border:'1.5px solid #a3c4a8', borderRadius:'10px', padding:'6px 12px', fontSize:'12px', fontWeight:600, color:'#0f2d1a' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1a4d2a" strokeWidth="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                    <span id="ai-file-name" style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'340px' }} />
                    <button onClick={() => window.clearAIFile()} style={{ background:'none', border:'none', cursor:'pointer', color:'#1a4d2a', fontSize:'14px', lineHeight:1, padding:0 }}>✕</button>
                  </div>
                </div>
                <div style={{ padding:'8px 18px 14px', display:'flex', gap:'10px', alignItems:'flex-end' }}>
                  <label htmlFor="ai-file-input" title="Attach files"
                    style={{ width:'38px', height:'38px', background:'#f3f4f6', border:'1.5px solid #e5e7eb', borderRadius:'10px', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', flexShrink:0, transition:'all 0.15s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background='#f0f7f2'; e.currentTarget.style.borderColor='#a3c4a8'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background='#f3f4f6'; e.currentTarget.style.borderColor='#e5e7eb'; }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  </label>
                  <textarea id="ai-custom-prompt-custom" rows={1}
                    placeholder="e.g. Generate 30 questions — 20 MCQ and 10 identification, medium difficulty…"
                    style={{ flex:1, resize:'none', border:'1.5px solid #e5e7eb', borderRadius:'12px', padding:'9px 13px', fontSize:'13px', outline:'none', fontFamily:'inherit', lineHeight:1.5, maxHeight:'72px', overflowY:'auto', transition:'border-color 0.15s' }}
                    onFocus={(e) => { e.target.style.borderColor='#1a4d2a'; }}
                    onBlur={(e) => { e.target.style.borderColor='#e5e7eb'; }}
                    onInput={(e) => { e.target.style.height='auto'; e.target.style.height=Math.min(e.target.scrollHeight,72)+'px'; const hidden=document.getElementById('ai-custom-prompt'); if(hidden) hidden.value=e.target.value; }}
                    onKeyDown={(e) => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); window.runAIGenerate(); } }}
                  />
                  <button id="ai-gen-btn" onClick={() => window.runAIGenerate()} title="Generate (Enter)"
                    style={{ width:'38px', height:'38px', background:'#1a4d2a', border:'none', borderRadius:'10px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'opacity 0.15s' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                  </button>
                  <button id="ai-import-btn" onClick={() => window.importAIQuestions()}
                    style={{ display:'none', height:'38px', padding:'0 16px', background:'#1a4d2a', border:'none', borderRadius:'10px', cursor:'pointer', color:'#fff', fontWeight:700, fontSize:'13px', flexShrink:0, whiteSpace:'nowrap', alignItems:'center', justifyContent:'center' }}>
                    Import Selected
                  </button>
                </div>
              </>
            )}
          </div>

        </div>
      </div>

      {/* Color Picker Popup */}
      <div id="color-picker-popup" className="hidden" style={{ position:'fixed', zIndex:10001, background:'#fff', borderRadius:'16px', padding:'16px', boxShadow:'0 8px 32px rgba(0,0,0,0.2),0 0 0 1px rgba(0,0,0,0.06)' }}>
        <div style={{ fontSize:'10px', fontWeight:800, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'1px', marginBottom:'12px' }}>Card Color</div>
        <div id="color-swatches" style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'8px' }} />
      </div>

      <style>{`
        @keyframes spin { to { transform:rotate(360deg); } }
        @keyframes aiModalIn { from { opacity:0; transform:scale(0.93) translateY(20px); } to { opacity:1; transform:scale(1) translateY(0); } }
        @keyframes quickModeIn { from { opacity:0; transform:translateX(-16px); } to { opacity:1; transform:translateX(0); } }
        @keyframes customModeIn { from { opacity:0; transform:translateX(16px); } to { opacity:1; transform:translateX(0); } }
        @keyframes aiBubbleIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes aiBlink { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
        @keyframes typingDot { 0%,60%,100% { transform:translateY(0); opacity:0.4; } 30% { transform:translateY(-5px); opacity:1; } }
        #ai-chat-body.ai-drag-over { background:#f0fdf4; outline:2px dashed #1a4d2a; outline-offset:-6px; border-radius:8px; }
        #ai-chat-body { scrollbar-width:thin; scrollbar-color:#a3c4a8 transparent; }
        #ai-chat-body::-webkit-scrollbar { width:4px; } #ai-chat-body::-webkit-scrollbar-thumb { background:#a3c4a8; border-radius:4px; }
        #ai-questions-preview { scrollbar-width:thin; scrollbar-color:#e5e7eb transparent; }
        #ai-questions-preview::-webkit-scrollbar { width:4px; } #ai-questions-preview::-webkit-scrollbar-thumb { background:#e5e7eb; border-radius:4px; }
        #ai-questions-preview .ai-q-card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:10px 12px; animation:aiBubbleIn 0.2s ease; }
        #ai-questions-preview .ai-q-card:hover { border-color:#1a4d2a; background:#f0f7f2; }
        #ai-questions-preview .ai-q-card label { display:flex; gap:10px; cursor:pointer; }
        #ai-questions-preview .ai-q-card .ai-q-correct { font-size:11px; color:#16a34a; margin-top:4px; }
        #ai-status { flex-direction:row; }
        #ai-preview { flex-direction:row; }
        #ai-gen-btn:hover { opacity:0.85; }
        .ai-file-drop-hover label { background:#f0f7f2 !important; border-color:#1a4d2a !important; }
      `}</style>
    </>
  );
}
