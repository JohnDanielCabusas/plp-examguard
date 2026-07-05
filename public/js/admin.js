// ============================================================
// ADMIN SPA LOGIC
// ============================================================

// ---- Shared icon SVGs ----
const icArchiveFill = `<svg class="archive-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
const icEditFill = `<svg class="edit-icon" viewBox="0 0 512 512"><path d="M410.3 231l11.3-11.3-33.9-33.9-62.1-62.1L291.7 89.8l-11.3 11.3-22.6 22.6L58.6 322.9c-10.4 10.4-18 23.3-22.2 37.4L1 480.7c-2.5 8.4-.2 17.5 6.1 23.7s15.3 8.5 23.7 6.1l120.3-35.4c14.1-4.2 27-11.8 37.4-22.2L387.7 253.7 410.3 231zM160 399.4l-9.1 22.7c-4 3.1-8.5 5.4-13.3 6.9L59.4 452l23-78.1c1.4-4.9 3.8-9.4 6.9-13.3l22.7-9.1v32c0 8.8 7.2 16 16 16h32zM362.7 18.7L348.3 33.2 325.7 55.8 314.3 67.1l33.9 33.9 62.1 62.1 33.9 33.9 11.3-11.3 22.6-22.6 14.5-14.5c25-25 25-65.5 0-90.5L453.3 18.7c-25-25-65.5-25-90.5 0zm-47.4 168l-144 144c-6.2 6.2-16.4 6.2-22.6 0s-6.2-16.4 0-22.6l144-144c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6z"/></svg>`;

// ---- State ----
let currentSection = 'dashboard';
let monitorInterval = null;
let monitorExamId = null;
let currentQBuilderExamId = null;
let confirmResolve = null;
let adminBootstrapped = false;
let passwordPromptResolve = null;
const ADMIN_SECTIONS = new Set(['dashboard', 'subjects', 'students', 'exams', 'monitoring', 'reports', 'statistics', 'settings', 'archive']);

function readAdminSectionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const section = params.get('section');
  return ADMIN_SECTIONS.has(section) ? section : 'dashboard';
}

function writeAdminSectionToUrl(section) {
  const url = new URL(window.location.href);
  if (!section || section === 'dashboard') {
    url.searchParams.delete('section');
  } else {
    url.searchParams.set('section', section);
  }
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function getCurrentAdminRecord() {
  const session = Auth.getAdminSession();
  if (!session?.id) return session || null;
  return DB.getAdmins().find(a => a.id === session.id) || session;
}

function refreshAdminIdentity() {
  const admin = getCurrentAdminRecord();
  if (!admin) return;
  const displayName = admin.name || 'Administrator';
  const initial = displayName.charAt(0).toUpperCase() || 'A';

  const sidebarName = document.getElementById('sb-user-name');
  const sidebarAvatar = document.getElementById('sb-avatar');
  const topbarName = document.getElementById('topbar-admin-name');
  const topbarAvatar = document.getElementById('topbar-avatar');

  if (sidebarName) sidebarName.textContent = displayName;
  if (sidebarAvatar) sidebarAvatar.textContent = initial;
  if (topbarName) topbarName.textContent = displayName;
  if (topbarAvatar) topbarAvatar.textContent = initial;
}

function getSubmissionStatusText(session) {
  if (!session) return 'Pending';
  if (!session.submitted) return 'Pending';

  if (session.autoSubmitted) {
    if (session.warnings >= 3) return 'Auto-Submitted (Warnings)';
    return 'Auto-Submitted (Time Limit)';
  }

  return 'Submitted';
}

function getSubmissionStatusBadge(session) {
  const text = getSubmissionStatusText(session);
  if (text === 'Submitted') return '<span class="badge badge-success">Submitted</span>';
  if (text === 'Pending') return '<span class="badge badge-secondary">Pending</span>';
  return `<span class="badge badge-warning">${escHtml(text)}</span>`;
}

const BEHAVIOR_LABELS = {
  no_person: 'No Person Detected',
  window_blur: 'Window Blur',
  tab_switch: 'Tab Switch',
  fullscreen_exit: 'Fullscreen Exit',
  copy_attempt: 'Copy/Cut Attempt',
  paste_attempt: 'Paste Attempt',
  ctrl_c_attempt: 'Ctrl+C Attempt',
  ctrl_v_attempt: 'Ctrl+V Attempt',
  camera_denied: 'Camera Denied',
  auto_submit: 'Auto-Submitted',
  force_submit: 'Force Submitted',
  timeout: 'Time Expired',
};

function getBehaviorLabel(type) {
  return BEHAVIOR_LABELS[type] || String(type || 'unknown').replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function summarizeActivities(activities) {
  const counts = new Map();
  (activities || []).forEach(activity => {
    const type = activity?.type || 'unknown';
    counts.set(type, (counts.get(type) || 0) + 1);
  });

  return [...counts.entries()]
    .map(([type, count]) => ({ type, count, label: getBehaviorLabel(type) }))
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
}

function renderBehaviorSummary(activities) {
  const summary = summarizeActivities(activities);
  if (!summary.length) return '';

  return `
    <div class="behavior-summary">
      ${summary.map(item => `
        <div class="behavior-summary-card behavior-${item.type}">
          <div class="behavior-summary-count">${item.count}</div>
          <div class="behavior-summary-label">${escHtml(item.label)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

// Surface Supabase sync failures visibly
document.addEventListener('supabaseSyncError', (e) => {
  const msg = e.detail?.message || 'Unknown error';
  showToast('Sync error (' + e.detail?.table + '): ' + msg, 'error');
});

// ── Dark mode ────────────────────────────────────────────────
window.toggleDarkMode = function() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('acs_theme', next);
  const label = document.getElementById('dm-label');
  if (label) label.textContent = next === 'dark' ? '☾' : '☼';
};

// Apply saved theme on load
(function() {
  const saved = localStorage.getItem('acs_theme') || 'light';
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    const cb = document.getElementById('dm-checkbox');
    if (cb) cb.checked = true;
    const label = document.getElementById('dm-label');
    if (label) label.textContent = '☾';
  }
})();

// ---- Bootstrap ----
document.addEventListener('dbReady', function init() {
  if (!Auth.requireAdmin()) return;
  if (adminBootstrapped) {
    refreshAdminIdentity();
    loadSettings();
    return;
  }
  adminBootstrapped = true;

  const session = Auth.getAdminSession();
  const settings = DB.getSettings();

  // Sidebar and topbar user info
  refreshAdminIdentity();
  document.getElementById('sb-school-name').textContent = settings.schoolName || 'TUKLAS';
  document.title = 'TUKLAS - Admin Panel';
  const dashboardDeptTitle = document.getElementById('dashboard-department-title');
  if (dashboardDeptTitle) dashboardDeptTitle.textContent = session.department || '';

  if (settings.logoUrl) {
    const wrap = document.getElementById('sb-logo-wrap');
    wrap.innerHTML = `<img src="${settings.logoUrl}" style="width:40px;height:40px;object-fit:contain;border-radius:4px;" />`;
  }

  // Date in topbar
  document.getElementById('topbar-date').textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });

  requestAnimationFrame(() => {
    showSection(readAdminSectionFromUrl());

  // Student ID modal: digits only, auto-insert dash after 2nd digit (YY-NNNNN)
  const studentIdInput = document.getElementById('stu-student-id');
  if (studentIdInput && !studentIdInput.dataset.boundFormat) {
    studentIdInput.dataset.boundFormat = 'true';
    studentIdInput.addEventListener('input', function() {
    if (this.disabled) return;
    const cursor = this.selectionStart;
    const prev = this.value;
    let digits = prev.replace(/\D/g, '').slice(0, 7);
    this.value = digits.length > 2 ? digits.slice(0, 2) + '-' + digits.slice(2) : digits;
    const added = this.value.length - prev.length;
    this.setSelectionRange(cursor + added, cursor + added);
    });
  }
  });
});

// ============================================================
// NAVIGATION
// ============================================================
// ── Universal animated custom dropdown ───────────────────
function makeCustomDropdown(sel) {
  if (!sel || sel._cdDone || sel.closest('.qe-type-dd')) return;
  sel._cdDone = true;

  // Wrapper takes select's place in layout
  const wrap = document.createElement('div');
  const isFilter = sel.classList.contains('filter-select');
  wrap.className = 'sys-dd qe-type-dd' + (isFilter ? ' filter-dd' : '');
  const uid = 'sdd-' + Math.random().toString(36).slice(2);
  wrap.id = uid;
  sel.parentNode.insertBefore(wrap, sel);
  sel.style.display = 'none';
  wrap.appendChild(sel);

  // Trigger button
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'qe-type-trigger sys-dd-trigger';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'qtd-label';
  const chevron = document.createElementNS('http://www.w3.org/2000/svg','svg');
  chevron.setAttribute('class','qtd-chevron');
  chevron.setAttribute('width','13'); chevron.setAttribute('height','13');
  chevron.setAttribute('viewBox','0 0 24 24'); chevron.setAttribute('fill','none');
  chevron.setAttribute('stroke','currentColor'); chevron.setAttribute('stroke-width','2.5');
  const poly = document.createElementNS('http://www.w3.org/2000/svg','polyline');
  poly.setAttribute('points','6 9 12 15 18 9');
  chevron.appendChild(poly);
  trigger.appendChild(labelSpan);
  trigger.appendChild(chevron);
  wrap.appendChild(trigger);

  // Panel
  const panel = document.createElement('div');
  panel.className = 'qtd-panel sys-dd-panel';
  wrap.appendChild(panel);

  const syncLabel = () => {
    const opt = sel.options[sel.selectedIndex];
    labelSpan.textContent = opt ? opt.text : '';
  };
  const buildPanel = () => {
    panel.innerHTML = '';
    Array.from(sel.options).forEach((opt, i) => {
      const div = document.createElement('div');
      div.className = 'qtd-opt' + (sel.selectedIndex === i ? ' qtd-active' : '');
      div.textContent = opt.text;
      div.onclick = (e) => {
        e.stopPropagation();
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        buildPanel();
        wrap.classList.remove('open');
      };
      panel.appendChild(div);
    });
  };

  syncLabel();
  buildPanel();

  trigger.onclick = (e) => {
    e.stopPropagation();
    const isOpen = wrap.classList.contains('open');
    document.querySelectorAll('.qe-type-dd.open').forEach(d => d.classList.remove('open'));
    if (!isOpen) wrap.classList.add('open');
  };

  // Rebuild when options change (dynamic population)
  new MutationObserver(() => { syncLabel(); buildPanel(); }).observe(sel, { childList: true });

  // Sync when value is set programmatically
  sel.addEventListener('change', () => { syncLabel(); buildPanel(); });
}

function initCustomDropdowns(root) {
  const ctx = root || document;
  ctx.querySelectorAll('select.form-control, select.form-filter').forEach(makeCustomDropdown);
}

function showSection(name) {
  // Stop monitoring if leaving that section
  if (currentSection === 'monitoring' && name !== 'monitoring') stopMonitoring();

  document.querySelectorAll('.admin-section').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const sec = document.getElementById('section-' + name);
  if (sec) sec.classList.remove('hidden');

  const nav = document.getElementById('nav-' + name);
  if (nav) nav.classList.add('active');

  const titles = { dashboard: 'Dashboard', subjects: 'Courses', students: 'Students', exams: 'Exams', monitoring: 'Live Monitoring', reports: 'Reports', statistics: 'Statistics', settings: 'Settings', archive: 'Archive' };
  document.getElementById('topbar-title').textContent = titles[name] || name;

  currentSection = name;
  writeAdminSectionToUrl(name);

  switch (name) {
    case 'dashboard': renderDashboard(); break;
    case 'subjects': renderSubjects(); break;
    case 'students': renderStudents(); break;
    case 'exams': renderExams(); break;
    case 'monitoring': loadMonitoringExams(); startMonitoring(); break;
    case 'reports': loadReportExams(); break;
    case 'statistics': loadStatsExams(); break;
    case 'settings': loadSettings(); break;
    case 'archive': renderArchive(); break;
  }

  // Convert any new selects in the revealed section
  const secEl = document.getElementById('section-' + name);
  if (secEl) requestAnimationFrame(() => initCustomDropdowns(secEl));

  closeSidebar();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('visible');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

async function doLogout() {
  const ok = await showConfirm({
    title: 'Sign Out',
    message: 'Sign out of your professor admin panel? You will need to log in again to continue.',
    confirmLabel: 'Sign Out',
    confirmClass: 'btn btn-primary',
    icon: 'signout',
  });
  if (!ok) return;
  stopMonitoring();
  Auth.clearAdminSession();
  window.location.href = 'index.html';
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  const students = DB.getStudents();
  const subjects = DB.getSubjects();
  const exams = DB.getExams();
  const sessions = DB.getSessions();
  const activeExams = exams.filter(e => e.status === 'active');
  const submittedSessions = sessions.filter(s => s.submitted);

  const now = new Date();
  const refreshEl = document.getElementById('dash-refresh-time');
  if (refreshEl) refreshEl.textContent = 'Updated ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  document.getElementById('dash-stats').innerHTML = `
    <div class="stat-card"><div class="stat-icon blue"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div><div><div class="stat-value">${subjects.length}</div><div class="stat-label">Subjects</div></div></div>
    <div class="stat-card"><div class="stat-icon green"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><div><div class="stat-value">${students.length}</div><div class="stat-label">Students</div></div></div>
    <div class="stat-card"><div class="stat-icon orange"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></div><div><div class="stat-value">${exams.length}</div><div class="stat-label">Total Exams</div></div></div>
    <div class="stat-card"><div class="stat-icon red"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div><div><div class="stat-value">${activeExams.length}</div><div class="stat-label">Active Exams</div></div></div>
    <div class="stat-card"><div class="stat-icon purple"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div><div><div class="stat-value">${submittedSessions.length}</div><div class="stat-label">Submissions</div></div></div>
  `;

  renderAnalytics(exams, sessions, students);

  // Recent exams
  const recentExams = [...exams].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  const recentHtml = recentExams.length
    ? `<table style="width:100%;"><thead><tr><th>Title</th><th>Status</th><th>Questions</th></tr></thead><tbody>
        ${recentExams.map(e => `<tr><td>${escHtml(e.title)}</td><td>${statusBadge(e.status)}</td><td>${e.questions.length}</td></tr>`).join('')}
       </tbody></table>`
    : `<div class="empty-state"><p>No exams yet</p></div>`;
  document.getElementById('dash-recent-exams').innerHTML = recentHtml;

  // Active sessions
  const activeSessions = sessions.filter(s => !s.submitted);
  const sessHtml = activeSessions.length
    ? `<table style="width:100%;"><thead><tr><th>Student</th><th>Exam</th><th>Warnings</th></tr></thead><tbody>
        ${activeSessions.map(s => {
          const exam = DB.getExam(s.examId);
          return `<tr><td>${escHtml(s.studentName)}</td><td>${escHtml(exam ? exam.title : s.examCode)}</td><td>${s.warnings > 0 ? `<span class="badge badge-danger">${s.warnings}</span>` : '0'}</td></tr>`;
        }).join('')}
       </tbody></table>`
    : `<div class="empty-state"><p>No active sessions</p></div>`;
  document.getElementById('dash-active-sessions').innerHTML = sessHtml;
}

function renderAnalytics(exams, sessions, students) {
  const analyticsEl = document.getElementById('dash-analytics');
  if (!analyticsEl) return;

  const closedExams = exams.filter(e => ['closed','archived'].includes(e.status));
  const submitted = sessions.filter(s => s.submitted && s.maxScore > 0);

  // --- Card 1: Average Score Trend (sparkline) ---
  const examScores = closedExams.map(e => {
    const eSessions = sessions.filter(s => s.examId === e.id && s.submitted && s.maxScore > 0);
    if (!eSessions.length) return null;
    const avg = eSessions.reduce((sum, s) => sum + (s.score / s.maxScore) * 100, 0) / eSessions.length;
    return { title: e.title, avg: Math.round(avg), date: e.closedAt || e.createdAt };
  }).filter(Boolean).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-6);

  const avgPct = submitted.length
    ? Math.round(submitted.reduce((s, x) => s + (x.score / x.maxScore) * 100, 0) / submitted.length)
    : null;

  let trendClass = 'flat', trendArrow = '→', trendLabel = 'No trend';
  if (examScores.length >= 2) {
    const diff = examScores[examScores.length-1].avg - examScores[0].avg;
    trendClass = diff > 2 ? 'up' : diff < -2 ? 'down' : 'flat';
    trendArrow = diff > 2 ? '↑' : diff < -2 ? '↓' : '→';
    trendLabel = diff > 2 ? `+${Math.round(diff)}% vs first` : diff < -2 ? `${Math.round(diff)}% vs first` : 'Stable trend';
  }

  let sparkSvg = '';
  if (examScores.length >= 2) {
    const W = 200, H = 50;
    const vals = examScores.map(e => e.avg);
    const minV = Math.min(...vals) - 5, maxV = Math.max(...vals) + 5;
    const pts = vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - ((v - minV) / (maxV - minV)) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const areaPath = `M0,${H} L` + vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - ((v - minV) / (maxV - minV)) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' L') + ` L${W},${H} Z`;
    sparkSvg = `
      <svg class="sparkline-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs><linearGradient id="sg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0f2d1a" stop-opacity="0.2"/><stop offset="100%" stop-color="#0f2d1a" stop-opacity="0"/></linearGradient></defs>
        <path d="${areaPath}" fill="url(#sg1)"/>
        <polyline points="${pts}" fill="none" stroke="#0f2d1a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${vals.map((v, i) => { const x = (i / (vals.length-1)) * W; const y = H - ((v - minV) / (maxV - minV)) * H; return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#0f2d1a"/>`; }).join('')}
      </svg>`;
  } else {
    sparkSvg = `<div class="text-muted" style="font-size:12px;padding:12px 0;">Not enough data for trend. Complete at least 2 exams.</div>`;
  }

  // Dark sparkline
  let darkSparkSvg = sparkSvg;
  if (examScores.length >= 2) {
    const W = 200, H = 60;
    const vals = examScores.map(e => e.avg);
    const minV = Math.min(...vals) - 5, maxV = Math.max(...vals) + 5;
    const pts = vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - ((v - minV) / (maxV - minV)) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const areaPath = `M0,${H} L` + vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - ((v - minV) / (maxV - minV)) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' L') + ` L${W},${H} Z`;
    const lastPt = pts.split(' ').pop().split(',');
    darkSparkSvg = `
      <svg class="sparkline-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="dsg1" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4ade80" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="#4ade80" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#dsg1)"/>
        <polyline points="${pts}" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="4" fill="#4ade80" opacity="0.9"/>
        <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="7" fill="#4ade80" opacity="0.2"/>
      </svg>`;
  } else {
    darkSparkSvg = `<div style="font-size:11px;color:rgba(255,255,255,0.35);padding:10px 0;">Complete at least 2 exams to see trend.</div>`;
  }

  const card1 = `
    <div class="analytics-card ac-dark">
      <div class="ac-dark-label">SCORE TREND</div>
      <div class="ac-dark-value">${avgPct !== null ? avgPct + '%' : '—'}</div>
      <div class="ac-dark-sub">Avg Completion Rate</div>
      <span class="ac-trend-badge ac-trend-${trendClass}">${trendArrow} ${Math.abs(examScores.length >= 2 ? examScores[examScores.length-1].avg - examScores[0].avg : 0)}%</span>
      <div class="sparkline-wrap" style="margin-top:12px;">${darkSparkSvg}</div>
    </div>`;

  // --- Card 2: At-Risk Students ---
  const atRiskList = students
    .map(s => {
      const stSessions = sessions.filter(x => x.studentId === s.studentId && x.submitted);
      const totalWarnings = stSessions.reduce((sum, x) => sum + (x.warnings || 0), 0);
      const avgScore = stSessions.length ? stSessions.reduce((sum, x) => sum + (x.maxScore ? (x.score / x.maxScore) * 100 : 0), 0) / stSessions.length : null;
      let risk = null;
      if (totalWarnings >= 3 || (avgScore !== null && avgScore < 50)) risk = 'high';
      else if (totalWarnings >= 1 || (avgScore !== null && avgScore < 70)) risk = 'medium';
      return { name: s.name, risk, avgScore, totalWarnings };
    })
    .filter(x => x.risk)
    .sort((a, b) => (a.risk === 'high' ? -1 : 1) - (b.risk === 'high' ? -1 : 1))
    .slice(0, 5);

  const riskColors = ['#f87171','#60a5fa','#c084fc','#fb923c','#34d399'];
  const atRiskHtml = atRiskList.length
    ? atRiskList.map((s, i) => {
        const init = (s.name || '?').charAt(0).toUpperCase();
        return `<div class="risk-item-dark">
          <div class="risk-avatar-dark" style="background:${riskColors[i % riskColors.length]}22;color:${riskColors[i % riskColors.length]};border:1px solid ${riskColors[i % riskColors.length]}44;">${init}</div>
          <span class="risk-name-dark">${escHtml(formatCourseNameDisplay(s.name))}</span>
          ${s.avgScore !== null ? `<span class="risk-score-dark">${Math.round(s.avgScore)}%</span>` : ''}
          <span class="risk-badge-dark risk-badge-${s.risk}">${s.risk === 'high' ? 'High Risk' : 'Watch'}</span>
        </div>`;
      }).join('')
    : `<div style="color:rgba(255,255,255,0.3);font-size:12px;padding:12px 0;text-align:center;">No at-risk students detected</div>`;

  const card2 = `
    <div class="analytics-card ac-dark ac-dark-red">
      <div class="ac-dark-label">AT-RISK STUDENTS</div>
      <div class="ac-dark-value">${atRiskList.filter(s => s.risk === 'high').length}</div>
      <div class="ac-dark-sub">High risk flagged</div>
      <div class="risk-list-dark">${atRiskHtml}</div>
    </div>`;

  // --- Card 3: Score Distribution ---
  const ranges = [
    { label: '0–49', min: 0, max: 49 },
    { label: '50–59', min: 50, max: 59 },
    { label: '60–74', min: 60, max: 74 },
    { label: '75–84', min: 75, max: 84 },
    { label: '85–94', min: 85, max: 94 },
    { label: '95–100', min: 95, max: 100 },
  ];
  const maxCount = Math.max(1, ...ranges.map(r =>
    submitted.filter(s => { const p = s.maxScore ? Math.round(s.score / s.maxScore * 100) : 0; return p >= r.min && p <= r.max; }).length
  ));
  // Glowing gradient bar chart
  const barAccent = '#4ade80';
  const barW = 32, barGap = 9, chartH = 72, labelH = 20;
  const totalW = ranges.length * barW + (ranges.length - 1) * barGap;
  const counts = ranges.map(r => submitted.filter(s => { const p = s.maxScore ? Math.round(s.score / s.maxScore * 100) : 0; return p >= r.min && p <= r.max; }).length);
  const peak = Math.max(1, ...counts);

  const barsSvg = `<defs>
    <filter id="bglow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>` + ranges.map((r, i) => {
    const count = counts[i];
    const h = Math.max(4, Math.round((count / peak) * chartH));
    const x = i * (barW + barGap);
    const y = chartH - h;
    const hasData = count > 0;
    const gradId = `dg${i}`;
    return `
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${barAccent}" stop-opacity="${hasData ? 0.9 : 0.1}"/>
          <stop offset="100%" stop-color="${barAccent}" stop-opacity="${hasData ? 0.06 : 0.03}"/>
        </linearGradient>
      </defs>
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="6" fill="url(#${gradId})" ${hasData ? 'filter="url(#bglow)"' : ''}/>
      ${hasData ? `<rect x="${x+7}" y="${y}" width="${barW-14}" height="3" rx="2" fill="${barAccent}" opacity="1"/>` : ''}
      ${count > 0 ? `<text x="${x+barW/2}" y="${y-6}" text-anchor="middle" fill="${barAccent}" font-size="10" font-weight="800" font-family="'Plus Jakarta Sans',sans-serif">${count}</text>` : ''}
      <text x="${x+barW/2}" y="${chartH+labelH-2}" text-anchor="middle" fill="rgba(255,255,255,0.25)" font-size="8" font-family="sans-serif">${escHtml(r.label)}</text>`;
  }).join('');

  const distSvg = `<svg viewBox="0 0 ${totalW} ${chartH+labelH}" class="dist-bar-svg" preserveAspectRatio="xMidYMid meet" style="width:100%;overflow:visible;">${barsSvg}</svg>`;

  const card3 = `
    <div class="analytics-card ac-dark ac-dark-teal">
      <div class="ac-dark-label">SCORE DISTRIBUTION</div>
      <div class="ac-dark-value">${submitted.length}</div>
      <div class="ac-dark-sub">Total scored submissions</div>
      <div style="margin-top:12px;padding:0 4px;">${distSvg}</div>
    </div>`;

  // --- Card 4: Performance Forecast ---
  const completionRate = exams.length ? Math.round((exams.filter(e => e.status !== 'draft').length / exams.length) * 100) : 0;
  const highRisk = atRiskList.filter(s => s.risk === 'high').length;
  const predictedAvg = examScores.length >= 2
    ? (() => {
        const n = examScores.length;
        const vals = examScores.map(e => e.avg);
        const slope = (vals[n-1] - vals[0]) / (n - 1);
        return Math.min(100, Math.max(0, Math.round(vals[n-1] + slope)));
      })()
    : null;

  const passRate = submitted.length ? Math.round(submitted.filter(s => s.maxScore && s.score/s.maxScore >= 0.75).length / submitted.length * 100) : null;
  const card4 = `
    <div class="analytics-card ac-dark ac-dark-amber">
      <div class="ac-dark-label">FORECAST</div>
      <div class="ac-dark-value">${predictedAvg !== null ? predictedAvg + '%' : '—'}</div>
      <div class="ac-dark-sub">Predicted next exam avg</div>
      <div class="forecast-rows-dark">
        <div class="forecast-row-dark">
          <span class="frd-label">Completion Rate</span>
          <span class="frd-value">${completionRate}%</span>
        </div>
        <div class="forecast-row-dark">
          <span class="frd-label">At-Risk Students</span>
          <span class="frd-value ${highRisk > 0 ? 'frd-bad' : 'frd-good'}">${highRisk}</span>
        </div>
        <div class="forecast-row-dark">
          <span class="frd-label">Exams Analyzed</span>
          <span class="frd-value">${examScores.length}</span>
        </div>
        <div class="forecast-row-dark">
          <span class="frd-label">Pass Rate ≥75%</span>
          <span class="frd-value ${passRate !== null && passRate >= 70 ? 'frd-good' : 'frd-bad'}">${passRate !== null ? passRate + '%' : '—'}</span>
        </div>
      </div>
    </div>`;

  analyticsEl.innerHTML = card1 + card2 + card3 + card4;
}

// ============================================================
// SUBJECTS
// ============================================================
function generateEnrollmentCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function regenerateEnrollCode() {
  document.getElementById('subj-enroll-code').value = generateEnrollmentCode();
}

const COURSE_COLORS = [
  { name: 'Forest Green', c1: '#0f2d1a', c2: '#1a4d2a' },
  { name: 'Ocean Blue',   c1: '#1e3a8a', c2: '#2563eb' },
  { name: 'Violet',       c1: '#4c1d95', c2: '#7c3aed' },
  { name: 'Crimson',      c1: '#7f1d1d', c2: '#dc2626' },
  { name: 'Amber',        c1: '#78350f', c2: '#d97706' },
  { name: 'Teal',         c1: '#0f766e', c2: '#14b8a6' },
  { name: 'Rose',         c1: '#881337', c2: '#e11d48' },
  { name: 'Slate',        c1: '#1e293b', c2: '#475569' },
  { name: 'Indigo',       c1: '#312e81', c2: '#6366f1' },
  { name: 'Emerald',      c1: '#064e3b', c2: '#059669' },
  { name: 'Sky',          c1: '#0c4a6e', c2: '#0284c7' },
  { name: 'Fuchsia',      c1: '#701a75', c2: '#c026d3' },
];

let _colorPickerSubjectId = null;

function courseCardColor(subj) {
  if (typeof subj.courseColor === 'number' && COURSE_COLORS[subj.courseColor]) {
    const c = COURSE_COLORS[subj.courseColor];
    return [c.c1, c.c2];
  }
  // Hash-based fallback
  const palette = COURSE_COLORS.map(c => [c.c1, c.c2]);
  let h = 0;
  for (let i = 0; i < subj.id.length; i++) h = (h * 31 + subj.id.charCodeAt(i)) & 0xffffffff;
  return palette[Math.abs(h) % palette.length];
}

function openColorPicker(subjectId, event) {
  event.stopPropagation();
  _colorPickerSubjectId = subjectId;
  const subj = DB.getSubject(subjectId);
  const current = subj && subj.courseColor;
  const popup = document.getElementById('color-picker-popup');
  const swatchEl = document.getElementById('color-swatches');

  swatchEl.innerHTML = COURSE_COLORS.map((c, i) => `
    <div class="color-swatch ${current === i ? 'selected' : ''}"
         style="background:linear-gradient(135deg,${c.c1},${c.c2});"
         title="${c.name}"
         onclick="selectCourseColor(${i})"></div>`).join('');

  const rect = event.currentTarget.getBoundingClientRect();
  popup.style.top  = (rect.bottom + 8) + 'px';
  popup.style.left = Math.max(8, rect.right - 184) + 'px';
  popup.classList.remove('hidden');

  setTimeout(() => document.addEventListener('click', _closeColorPicker, { once: true }), 50);
}

function _closeColorPicker(e) {
  const popup = document.getElementById('color-picker-popup');
  if (popup && !popup.contains(e.target)) popup.classList.add('hidden');
}

function selectCourseColor(colorIndex) {
  if (_colorPickerSubjectId) {
    DB.updateSubject(_colorPickerSubjectId, { courseColor: colorIndex });
    document.getElementById('color-picker-popup').classList.add('hidden');
    renderSubjects();
  }
}

function viewEnrolledStudents(subjectId) {
  const subj = DB.getSubject(subjectId);
  if (!subj) return;
  const students = DB.getStudents().filter(s => (s.enrolledSubjects || []).includes(subjectId));
  const exams    = DB.getExams().filter(e => e.subjectId === subjectId);

  document.getElementById('modal-enrolled-title').textContent = formatCourseNameDisplay(subj.name);
  document.getElementById('modal-enrolled-sub').textContent =
    `${subj.code} · ${students.length} student${students.length !== 1 ? 's' : ''} · ${exams.length} exam${exams.length !== 1 ? 's' : ''}`;

  const studentsHtml = students.length
    ? `<div class="table-wrapper"><table>
        <thead><tr><th>Student ID</th><th>Name</th><th>Year Level</th><th>Section</th><th style="text-align:center;">Actions</th></tr></thead>
        <tbody>
          ${students.map(s => `
            <tr>
              <td><span class="code-tag">${escHtml(s.studentId)}</span></td>
              <td><strong>${escHtml(s.name)}</strong></td>
              <td>${escHtml(s.yearLevel || '—')}</td>
              <td>${escHtml(s.section || '—')}</td>
              <td style="text-align:center;">
                <button class="btn btn-danger btn-sm" onclick="removeStudentFromCourse('${s.id}','${subjectId}')">Remove</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>`
    : `<div class="empty-state"><p>No students enrolled yet. Share the enrollment code <strong>${escHtml(subj.enrollmentCode || '—')}</strong> with students.</p></div>`;

  const examsHtml = exams.length
    ? `<div class="table-wrapper"><table>
        <thead><tr><th>Title</th><th style="text-align:center;">Code</th><th style="text-align:center;">Questions</th><th style="text-align:center;">Time</th><th style="text-align:center;">Status</th></tr></thead>
        <tbody>
          ${exams.map(e => `
            <tr>
              <td><strong>${escHtml(e.title)}</strong><div class="text-muted" style="font-size:11px;">${formatDate(e.createdAt)}</div></td>
              <td style="text-align:center;">${e.code ? `<span class="code-tag">${escHtml(e.code)}</span>` : '—'}</td>
              <td style="text-align:center;">${e.questions.length}</td>
              <td style="text-align:center;">${e.timeLimit} min</td>
              <td style="text-align:center;">${statusBadge(e.status)}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>`
    : `<div class="empty-state"><p>No exams created for this course yet.</p></div>`;

  document.getElementById('modal-enrolled-body').innerHTML = `
    <div style="border-bottom:1.5px solid #e5e7eb;">
      <div style="display:flex;padding:0 8px;">
        <button class="exam-tab-btn active" id="etab-btn-students" onclick="switchEnrolledTab('students')" style="padding:12px 20px;">
          Students <span class="exam-q-badge" style="background:#0f2d1a;">${students.length}</span>
        </button>
        <button class="exam-tab-btn" id="etab-btn-exams" onclick="switchEnrolledTab('exams')" style="padding:12px 20px;">
          Exams <span class="exam-q-badge" style="background:#0f2d1a;">${exams.length}</span>
        </button>
      </div>
    </div>
    <div id="etab-students">${studentsHtml}</div>
    <div id="etab-exams" class="hidden">${examsHtml}</div>`;

  openModal('modal-enrolled-students');
}

function switchEnrolledTab(tab) {
  ['students','exams'].forEach(t => {
    document.getElementById('etab-' + t).classList.toggle('hidden', t !== tab);
    document.getElementById('etab-btn-' + t).classList.toggle('active', t === tab);
  });
}

async function removeStudentFromCourse(studentId, subjectId) {
  const student = DB.getStudentById(studentId);
  if (!student) return;
  const ok = await showConfirm(`Remove "${student.name}" from this course? They will no longer see this course's exams.`);
  if (!ok) return;
  const updated = (student.enrolledSubjects || []).filter(id => id !== subjectId);
  DB.updateStudent(student.id, { enrolledSubjects: updated });
  viewEnrolledStudents(subjectId); // refresh modal
  showToast(`${student.name} removed from course.`, 'success');
}

function renderSubjects() {
  const session = Auth.getAdminSession() || {};
  const settings = DB.getSettings();
  const deptTitle = document.getElementById('courses-department-title');
  if (deptTitle) deptTitle.textContent = session.department || settings.department || '';
  const subjects = DB.getSubjects().filter(s => !s.archived);
  const grid = document.getElementById('course-cards-grid');
  if (!subjects.length) {
    grid.innerHTML = `<div class="course-empty"><div class="course-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div><div class="course-empty-title">No Courses Yet</div><div class="course-empty-sub">Click "+ Add Course" to create your first course.</div></div>`;
    return;
  }
  const allExams = DB.getExams();
  const allStudents = DB.getStudents();

  grid.innerHTML = subjects.map(s => {
    const [c1, c2] = courseCardColor(s);
    const letter = (s.code || s.name || '?').charAt(0).toUpperCase();
    const years    = (Array.isArray(s.yearLevels) && s.yearLevels.length) ? s.yearLevels : (s.yearLevel ? [s.yearLevel] : []);
    const sections = s.sections   || [];
    const courseName = formatCourseNameDisplay(s.name);
    const yearSectionMeta = buildCourseYearSectionMeta(years, sections, c2);

    const examCount    = allExams.filter(e => e.subjectId === s.id && e.status !== 'archived').length;
    const studentCount = allStudents.filter(st => (st.enrolledSubjects || []).includes(s.id)).length;

    const yearPills = years.map(y => `<span class="course-meta-pill year">${escHtml(y)}</span>`).join('');
    const sectionPills = sections.map(sc => `<span class="course-meta-pill section">${escHtml(sc.replace('Section ','§'))}</span>`).join('');

    const enrollHtml = s.enrollmentCode
      ? `<button type="button" class="enroll-code-tag" title="Click to copy enrollment code" onclick="event.stopPropagation();copyEnrollCode('${s.enrollmentCode}','${escHtml(s.name)}')">
          ${s.enrollmentCode}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>`
      : `<span class="text-muted">—</span>`;

    return `
    <div class="course-card">
      <!-- Single clickable zone: header + meta + stats -->
      <div onclick="viewEnrolledStudents('${s.id}')" style="cursor:pointer;display:block;">
        <div class="course-card-header" style="background:linear-gradient(135deg,${c1} 0%,${c2} 100%);">
          <div class="course-card-deco"></div>
          <div class="course-card-letter">${letter}</div>
          <button class="course-color-btn" onclick="openColorPicker('${s.id}',event)" title="Change card color">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
          </button>
          <div style="position:relative;z-index:1;">
            <div class="course-card-code-label">${escHtml(s.code)}</div>
            <div class="course-card-name">${escHtml(courseName)}</div>
          </div>
        </div>
        <div style="padding:14px 18px 0;">
          <div class="course-card-stats">
            <div class="course-stat-cell">
              <div class="course-stat-num">${examCount}</div>
              <div class="course-stat-lab">Exams</div>
            </div>
            <div class="course-stat-cell">
              <div class="course-stat-num">${studentCount}</div>
              <div class="course-stat-lab">Students</div>
            </div>
          </div>
        </div>
      </div>
      <!-- Non-clickable zone: enroll code + actions -->
      <div class="course-card-body" style="padding-top:12px;">
        <div class="course-card-enroll">
          <div class="course-card-enroll-group">
            <span class="course-enroll-label">Enroll Code</span>
            ${enrollHtml}
          </div>
          ${yearSectionMeta}
        </div>
        <div class="course-card-actions">
          <button class="btn-action btn-action-ghost btn-edit-card" style="--card-color:${c1};--card-shadow:${c1}99;" onclick="openSubjectModal('${s.id}')">Edit${icEditFill}</button>
          <button class="tbl-btn tbl-btn-archive" onclick="archiveCourse('${s.id}')">Archive${icArchiveFill}</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function buildCourseYearSectionMeta(years, sections, accentColor) {
  const normalizedYears = (Array.isArray(years) ? years : [])
    .map(year => yearLabelToNumber(year))
    .map(year => String(year || '').trim())
    .filter(Boolean);
  const normalizedSections = (Array.isArray(sections) ? sections : [])
    .map(section => normalizeSectionValue(section))
    .map(section => String(section || '').trim())
    .filter(Boolean);

  let values = [];
  if (normalizedYears.length && normalizedSections.length) {
    if (normalizedYears.length === normalizedSections.length) {
      values = normalizedYears.map((year, index) => `${year}-${normalizedSections[index]}`);
    } else if (normalizedYears.length === 1) {
      values = normalizedSections.map(section => `${normalizedYears[0]}-${section}`);
    } else if (normalizedSections.length === 1) {
      values = normalizedYears.map(year => `${year}-${normalizedSections[0]}`);
    } else {
      values = normalizedYears.flatMap(year => normalizedSections.map(section => `${year}-${section}`));
    }
  } else if (normalizedYears.length) {
    values = normalizedYears;
  } else {
    values = normalizedSections;
  }

  const seen = new Set();
  const items = values
    .filter(value => {
      const key = value.toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(value => `<span class="course-meta-pill year-section" style="color:${accentColor};border-color:${accentColor}22;background:${accentColor}12;">${escHtml(value)}</span>`)
    .join('');

  if (!items) return '';

  return `
    <div class="course-year-section-wrap">
      <span class="course-enroll-divider" aria-hidden="true"></span>
      <span class="course-year-section-icon" style="color:${accentColor};">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      </span>
      <span class="course-year-section-pills">${items}</span>
    </div>
  `;
}

function copyEnrollCode(code, subjectName) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) {
    showToast('No enrollment code available.', 'error');
    return;
  }

  copyTextToClipboard(cleanCode, `Enrollment code copied: ${cleanCode}`);
}

function copyTextToClipboard(text, successMessage) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return false;

  const fallbackCopy = () => {
    const tmp = document.createElement('textarea');
    tmp.value = cleanText;
    tmp.setAttribute('readonly', '');
    tmp.style.position = 'fixed';
    tmp.style.opacity = '0';
    tmp.style.pointerEvents = 'none';
    document.body.appendChild(tmp);
    tmp.focus();
    tmp.select();
    tmp.setSelectionRange(0, cleanText.length);
    document.execCommand('copy');
    tmp.remove();
  };

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(cleanText)
      .then(() => showToast(successMessage, 'success'))
      .catch(() => {
        fallbackCopy();
        showToast(successMessage, 'success');
      });
  } else {
    fallbackCopy();
    showToast(successMessage, 'success');
  }
  return true;
}

function copyExamCode(code) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) {
    showToast('No exam code available.', 'error');
    return;
  }
  copyTextToClipboard(cleanCode, `Exam code copied: ${cleanCode}`);
}

function copyExamCodeFromField() {
  const codeField = document.getElementById('exam-code-field');
  copyExamCode(codeField ? codeField.value : '');
}

function normalizeCourseYearLevelsInput(rawValue) {
  const normalizedYear = yearLabelToNumber(rawValue);
  return normalizedYear ? [yearNumberToLabel(normalizedYear)] : [];
}

function bindYearLevelInput(input) {
  if (!input || input.dataset.yearLevelBound === 'true') return;
  input.dataset.yearLevelBound = 'true';
  input.inputMode = 'numeric';
  input.maxLength = 1;
  input.placeholder = 'Enter 1-5';
  input.setAttribute('pattern', '[1-5]');

  input.addEventListener('input', () => {
    const digits = String(input.value || '').replace(/\D/g, '');
    const nextValue = digits ? digits.charAt(0) : '';
    input.value = /^[1-5]$/.test(nextValue) ? nextValue : '';
  });
}

function normalizeCourseNameInput(rawValue) {
  const value = String(rawValue || '').trim().replace(/\s+/g, ' ');
  return formatCourseNameDisplay(value);
}

function formatCourseNameDisplay(rawValue) {
  const value = String(rawValue || '').trim().replace(/\s+/g, ' ');
  if (!/[A-Z]/.test(value) || value !== value.toUpperCase()) return value;

  const smallWords = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via']);
  return value
    .toLowerCase()
    .split(' ')
    .map((word, index) => {
      const bareWord = word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
      if (index > 0 && smallWords.has(bareWord)) return word;
      return word.replace(/[a-z]/, char => char.toUpperCase());
    })
    .join(' ');
}

function normalizeCourseSectionsInput(rawValue) {
  const seen = new Set();
  return String(rawValue || '')
    .split(/[,\n]/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(value => {
      if (/^section\s+/i.test(value)) {
        const suffix = value.replace(/^section\s+/i, '').trim();
        return suffix ? `Section ${suffix.toUpperCase()}` : '';
      }
      if (/^[A-Za-z]$/.test(value)) return `Section ${value.toUpperCase()}`;
      return value;
    })
    .filter(Boolean)
    .filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function formatCourseSectionsInputValue(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map(value => String(value || '').replace(/^section\s+/i, '').trim())
    .filter(Boolean)
    .join(', ');
}

function ensureSubjectModalTextFields() {
  const yearField = document.getElementById('subj-year-level');
  if (yearField && yearField.tagName === 'SELECT') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control';
    input.id = 'subj-year-level';
    yearField.replaceWith(input);
    bindYearLevelInput(input);
  } else if (yearField) {
    bindYearLevelInput(yearField);
  }

  if (!document.getElementById('subj-section')) {
    const sectionLabel = [...document.querySelectorAll('#modal-subject .form-group > label')]
      .find(label => label.textContent.trim() === 'Section');
    const sectionField = sectionLabel ? sectionLabel.nextElementSibling : null;
    if (sectionField) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-control';
      input.id = 'subj-section';
      input.placeholder = 'e.g. A, B, C or Section A';
      sectionField.replaceWith(input);
    }
  }
}

function openSubjectModal(id) {
  ensureSubjectModalTextFields();
  document.getElementById('subj-id').value = '';
  document.getElementById('subj-code').value = '';
  document.getElementById('subj-name').value = '';
  document.getElementById('subj-desc').value = '';
  document.getElementById('subj-year-level').value = '';
  document.getElementById('subj-section').value = '';
  document.getElementById('subj-enroll-code').value = generateEnrollmentCode();
  document.getElementById('modal-subject-title').textContent = 'Add Course';

  if (id) {
    const s = DB.getSubject(id);
    if (!s) return;
    document.getElementById('modal-subject-title').textContent = 'Edit Course';
    document.getElementById('subj-id').value = s.id;
    document.getElementById('subj-code').value = s.code;
    document.getElementById('subj-name').value = formatCourseNameDisplay(s.name);
    document.getElementById('subj-desc').value = s.description || '';
    document.getElementById('subj-enroll-code').value = s.enrollmentCode || generateEnrollmentCode();
    const savedYears = Array.isArray(s.yearLevels) && s.yearLevels.length ? s.yearLevels : (s.yearLevel ? [s.yearLevel] : []);
    document.getElementById('subj-year-level').value = yearLabelToNumber(savedYears[0] || '');
    document.getElementById('subj-section').value = formatCourseSectionsInputValue(s.sections || []);
  }
  openModal('modal-subject');
}

function saveSubject() {
  const id = document.getElementById('subj-id').value;
  const code = document.getElementById('subj-code').value.trim().toUpperCase();
  const name = normalizeCourseNameInput(document.getElementById('subj-name').value);
  const description = document.getElementById('subj-desc').value.trim();
  const enrollmentCode = document.getElementById('subj-enroll-code').value.trim().toUpperCase() || generateEnrollmentCode();
  const rawYearLevel = document.getElementById('subj-year-level').value.trim();
  const normalizedYear = yearLabelToNumber(rawYearLevel);
  if (rawYearLevel && !normalizedYear) { showToast('Year level must be a number from 1 to 5.', 'error'); return; }
  const yearLevels = normalizeCourseYearLevelsInput(rawYearLevel);
  const sections = normalizeCourseSectionsInput(document.getElementById('subj-section').value);
  const yearLevel = normalizedYear ? yearNumberToLabel(normalizedYear) : '';

  if (!code || !name) { showToast('Course code and name are required.', 'error'); return; }

  const activeWithCode = DB.getSubjects().filter(s => s.code === code && s.id !== id && !s.archived);
  const yearsOverlap = (a, b) => !a.length || !b.length || a.some(y => b.includes(y));
  const secsOverlap  = (a, b) => !a.length || !b.length || a.some(s => b.includes(s));
  const conflict = activeWithCode.find(s =>
    yearsOverlap(yearLevels, s.yearLevels || []) && secsOverlap(sections, Array.isArray(s.sections) ? s.sections : [])
  );
  if (conflict) {
    const label = [conflict.yearLevels?.join('/'), (conflict.sections||[]).join('/')].filter(Boolean).join(' ');
    showToast(`Course code "${code}" is already in use${label ? ` for ${label}` : ''}. Please use a different code or section.`, 'error');
    return;
  }

  if (id) {
    DB.updateSubject(id, { code, name, description, enrollmentCode, yearLevel, yearLevels, sections });
    showToast('Course updated successfully.', 'success');
  } else {
    DB.addSubject({ code, name, description, enrollmentCode, yearLevel, yearLevels, sections });
    showToast('Course added successfully.', 'success');
  }
  closeModal('modal-subject');
  renderSubjects();
}

async function deleteSubject(id) {
  const s = DB.getSubject(id);
  if (!s) return;
  const ok = await showConfirm(`Delete subject "${s.name}"? This cannot be undone.`);
  if (!ok) return;
  DB.deleteSubject(id);
  showToast('Subject deleted.', 'success');
  renderSubjects();
}

// ============================================================
// STUDENTS
// ============================================================
function computeYearLevel(studentId) {
  const match = studentId && studentId.match(/^(\d{2})-/);
  if (!match) return '—';
  const enrollYear = 2000 + parseInt(match[1]);
  const currentYear = new Date().getFullYear();
  const yr = currentYear - enrollYear;
  const ordinals = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year'];
  return ordinals[Math.max(0, Math.min(yr, 4))];
}

function yearNumberToLabel(value) {
  const normalized = String(value || '').trim();
  const map = { '1': '1st Year', '2': '2nd Year', '3': '3rd Year', '4': '4th Year', '5': '5th Year' };
  return map[normalized] || normalized;
}

function yearLabelToNumber(value) {
  const normalized = String(value || '').trim();
  if (/^[1-5]$/.test(normalized)) return normalized;
  const match = normalized.match(/^([1-5])(st|nd|rd|th)\s+year$/i);
  return match ? match[1] : '';
}

function normalizeSectionValue(value) {
  return String(value || '')
    .trim()
    .replace(/^section\s+/i, '')
    .toUpperCase();
}

function getStudentYearSectionParts(student) {
  const storedYearSection = String(student?.yearSection || '').trim().toUpperCase();
  const yearSectionMatch = storedYearSection.match(/^([1-5])-(.+)$/);
  if (yearSectionMatch) {
    return {
      year: yearSectionMatch[1],
      section: yearSectionMatch[2].trim(),
      yearSection: storedYearSection,
    };
  }

  const section = normalizeSectionValue(student?.section || '');
  const year = yearLabelToNumber(student?.yearLevel || '');
  if (year || section) {
    return {
      year,
      section,
      yearSection: year && section ? `${year}-${section}` : '',
    };
  }

  const computedYear = yearLabelToNumber(computeYearLevel(student?.studentId || ''));
  return {
    year: computedYear,
    section: '',
    yearSection: '',
  };
}

function getStudentYearLevelLabel(student) {
  const parts = getStudentYearSectionParts(student);
  if (parts.year) return yearNumberToLabel(parts.year);
  const stored = String(student?.yearLevel || '').trim();
  return stored || computeYearLevel(student?.studentId || '');
}

function getStudentYearLevelDisplay(student) {
  const parts = getStudentYearSectionParts(student);
  if (parts.year) return parts.year;
  const label = getStudentYearLevelLabel(student);
  return yearLabelToNumber(label) || label;
}

function getStudentSectionDisplay(student) {
  const parts = getStudentYearSectionParts(student);
  return parts.section || normalizeSectionValue(student?.section || '');
}

function ensureStudentModalForm() {
  const yearField = document.getElementById('stu-year');
  if (yearField && yearField.tagName === 'SELECT') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control';
    input.id = 'stu-year';
    input.autocomplete = 'off';
    yearField.replaceWith(input);
    bindYearLevelInput(input);
  } else if (!yearField) {
    return;
  } else {
    yearField.autocomplete = 'off';
    bindYearLevelInput(yearField);
  }

  const sectionField = document.getElementById('stu-section');
  if (sectionField && sectionField.tagName === 'SELECT') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control';
    input.id = 'stu-section';
    input.placeholder = 'e.g. B';
    input.autocomplete = 'off';
    sectionField.replaceWith(input);
  }

  if (!document.getElementById('stu-program')) {
    const emailGroup = document.getElementById('stu-email')?.closest('.form-group');
    if (!emailGroup) return;
    const emailRow = emailGroup.parentElement;
    if (emailRow?.classList.contains('form-row')) {
      const programGroup = document.createElement('div');
      programGroup.className = 'form-group';
      programGroup.innerHTML = '<label>Program</label><input type="text" class="form-control" id="stu-program" placeholder="e.g. BSCS" />';
      emailRow.appendChild(programGroup);
    } else {
      const row = document.createElement('div');
      row.className = 'form-row cols-2';
      const detachedEmailGroup = emailGroup.cloneNode(true);
      row.appendChild(detachedEmailGroup);
      emailGroup.replaceWith(row);
      const programGroup = document.createElement('div');
      programGroup.className = 'form-group';
      programGroup.innerHTML = '<label>Program</label><input type="text" class="form-control" id="stu-program" placeholder="e.g. BSCS" />';
      row.appendChild(programGroup);
    }
  }
}

function renderStudents(filter) {
  // Only show students enrolled in at least one of this professor's courses
  const mySubjectIds = new Set(DB.getSubjects().map(s => s.id));
  let students = DB.getStudents().filter(s =>
    (s.enrolledSubjects || []).some(id => mySubjectIds.has(id))
  );

  // Populate section filter dropdown
  const sections = [...new Set(students.map(s => getStudentSectionDisplay(s)).filter(Boolean))].sort();
  const secSel = document.getElementById('filter-section');
  const prevSec = secSel.value;
  secSel.innerHTML = '<option value="">All Sections</option>' +
    sections.map(s => `<option value="${escHtml(s)}" ${s === prevSec ? 'selected' : ''}>${escHtml(s)}</option>`).join('');

  const programs = [...new Set(students.map(s => s.program).filter(Boolean))].sort();
  const programSel = document.getElementById('filter-program');
  const prevProgram = programSel.value;
  programSel.innerHTML = '<option value="">All Programs</option>' +
    programs.map(p => `<option value="${escHtml(p)}" ${p === prevProgram ? 'selected' : ''}>${escHtml(p)}</option>`).join('');

  const courseSel = document.getElementById('filter-course');
  const prevCourse = courseSel ? courseSel.value : '';
  const myCourses = DB.getSubjects().filter(s => !s.archived).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (courseSel) {
    courseSel.innerHTML = '<option value="">All Courses</option>' +
      myCourses.map(c => `<option value="${escHtml(c.id)}" ${c.id === prevCourse ? 'selected' : ''}>${escHtml(c.name)}${c.code ? ' (' + escHtml(c.code) + ')' : ''}</option>`).join('');
  }

  const q = (filter || '').toLowerCase();
  const yearFilter = document.getElementById('filter-year-level').value;
  const sectionFilter = secSel.value;
  const programFilter = programSel.value;
  const courseFilter = courseSel ? courseSel.value : '';

  if (q) {
    students = students.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.studentId.toLowerCase().includes(q) ||
      (s.program || '').toLowerCase().includes(q) ||
      getStudentSectionDisplay(s).toLowerCase().includes(q) ||
      getStudentYearLevelLabel(s).toLowerCase().includes(q) ||
      (s.yearSection || '').toLowerCase().includes(q)
    );
  }
  if (yearFilter) students = students.filter(s => getStudentYearLevelLabel(s) === yearFilter);
  if (sectionFilter) students = students.filter(s => getStudentSectionDisplay(s) === sectionFilter);
  if (programFilter) students = students.filter(s => (s.program || '') === programFilter);
  if (courseFilter) students = students.filter(s => (s.enrolledSubjects || []).includes(courseFilter));

  const tbody = document.getElementById('students-tbody');
  if (!students.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>No students found.</p></div></td></tr>`;
    return;
  }
  const ylColors = { '1st Year':'yl-1','2nd Year':'yl-2','3rd Year':'yl-3','4th Year':'yl-4', '5th Year':'yl-5' };
  tbody.innerHTML = students.map(s => {
    const yl = getStudentYearLevelLabel(s);
    const ylDisplay = getStudentYearLevelDisplay(s) || 'â€”';
    const sectionDisplay = getStudentSectionDisplay(s) || 'â€”';
    const initials = (s.name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
    const ylClass = ylColors[yl] || 'yl-1';
    return `
    <tr>
      <td data-label="Student ID"><span class="student-id-badge">${escHtml(s.studentId)}</span></td>
      <td data-label="Name">
        <div class="student-name-cell">
          <div class="student-avatar">${initials}</div>
          <span class="student-name-text">${escHtml(s.name)}</span>
        </div>
      </td>
      <td data-label="Year Level"><span class="yl-badge ${ylClass}">${escHtml(yl)}</span></td>
      <td data-label="Section"><span class="section-text">${escHtml(s.section || '—')}</span></td>
      <td data-label="Email" class="email-cell">${escHtml(s.email || '—')}</td>
      <td data-label="Program"><span class="section-text">${escHtml(s.program || '—')}</span></td>
      <td data-label="">
        <div class="table-actions">
          <button class="btn-action btn-action-ghost" onclick="openStudentModal('${s.id}')">Edit${icEditFill}</button>
          <button class="tbl-btn tbl-btn-archive" onclick="archiveStudent('${s.id}')">Archive${icArchiveFill}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

let studentFilterFrame = 0;
function filterStudents() {
  const q = document.getElementById('student-search').value;
  if (studentFilterFrame) cancelAnimationFrame(studentFilterFrame);
  studentFilterFrame = requestAnimationFrame(() => {
    studentFilterFrame = 0;
    renderStudents(q);
  });
}

function populateStudentDropdowns(savedYear, savedSection) {
  const subjects = DB.getSubjects();
  const yearOrder = ['1st Year','2nd Year','3rd Year','4th Year','5th Year'];

  const allYears = [...new Set(subjects.flatMap(s => s.yearLevels || []))]
    .sort((a, b) => yearOrder.indexOf(a) - yearOrder.indexOf(b));

  // Fixed section order A-E
  const sectionOrder = ['Section A','Section B','Section C','Section D','Section E'];
  const allSections = [...new Set(subjects.flatMap(s => s.sections || []))]
    .sort((a, b) => sectionOrder.indexOf(a) - sectionOrder.indexOf(b));

  const yearSel = document.getElementById('stu-year');
  yearSel.innerHTML = '<option value="">— Select Year Level —</option>' +
    allYears.map(y => `<option value="${escHtml(y)}" ${savedYear === y ? 'selected' : ''}>${escHtml(y)}</option>`).join('');
  if (savedYear && !allYears.includes(savedYear)) {
    yearSel.innerHTML += `<option value="${escHtml(savedYear)}" selected>${escHtml(savedYear)}</option>`;
  }

  const secSel = document.getElementById('stu-section');
  secSel.innerHTML = '<option value="">— Select Section —</option>' +
    allSections.map(s => `<option value="${escHtml(s)}" ${savedSection === s ? 'selected' : ''}>${escHtml(s)}</option>`).join('');
  if (savedSection && !allSections.includes(savedSection)) {
    secSel.innerHTML += `<option value="${escHtml(savedSection)}" selected>${escHtml(savedSection)}</option>`;
  }
}

function openStudentModal(id) {
  document.getElementById('stu-id').value = '';
  document.getElementById('stu-student-id').value = '';
  document.getElementById('stu-name').value = '';
  document.getElementById('stu-email').value = '';
  document.getElementById('modal-student-title').textContent = 'Add Student';
  document.getElementById('stu-student-id').disabled = false;

  if (id) {
    const s = DB.getStudentById(id);
    if (!s) return;
    document.getElementById('modal-student-title').textContent = 'Edit Student';
    document.getElementById('stu-id').value = s.id;
    document.getElementById('stu-student-id').value = s.studentId;
    document.getElementById('stu-student-id').disabled = true;
    document.getElementById('stu-name').value = s.name;
    document.getElementById('stu-email').value = s.email || '';
    populateStudentDropdowns(s.yearLevel || '', s.section || '');
  } else {
    populateStudentDropdowns('', '');
  }
  openModal('modal-student');
}

function saveStudent() {
  const id = document.getElementById('stu-id').value;
  const studentId = document.getElementById('stu-student-id').value.trim().toUpperCase();
  const name = document.getElementById('stu-name').value.trim();
  const yearLevel = document.getElementById('stu-year').value.trim();
  const section = document.getElementById('stu-section').value.trim();
  const email = document.getElementById('stu-email').value.trim().toLowerCase();

  if (!studentId || !name) { showToast('Student ID and name are required.', 'error'); return; }
  const idMatch = studentId.match(/^(\d{2})-\d{5}$/);
  if (!idMatch) { showToast('Student ID must be in YY-NNNNN format (e.g. 23-00218).', 'error'); return; }
  const yr = parseInt(idMatch[1]);
  if (yr < 18 || yr > 26) { showToast('Student ID year must be between 2018 (18) and 2026 (26).', 'error'); return; }

  try {
    if (id) {
      DB.updateStudent(id, { name, yearLevel, section, email });
      showToast('Student updated.', 'success');
    } else {
      DB.addStudent({ studentId, name, yearLevel, section, email });
      showToast('Student added.', 'success');
    }
  } catch (error) {
    showToast(error?.message || 'Unable to save student right now.', 'error');
    return;
  }
  closeModal('modal-student');
  renderStudents();
}

function yearNumberToLabel(value) {
  const normalized = String(value || '').trim();
  const map = { '1': '1st Year', '2': '2nd Year', '3': '3rd Year', '4': '4th Year', '5': '5th Year' };
  return map[normalized] || normalized;
}

function yearLabelToNumber(value) {
  const normalized = String(value || '').trim();
  if (/^[1-5]$/.test(normalized)) return normalized;
  const match = normalized.match(/^([1-5])(st|nd|rd|th)\s+year$/i);
  return match ? match[1] : '';
}

function normalizeSectionValue(value) {
  return String(value || '')
    .trim()
    .replace(/^section\s+/i, '')
    .toUpperCase();
}

function getStudentYearSectionParts(student) {
  const storedYearSection = String(student?.yearSection || '').trim().toUpperCase();
  const yearSectionMatch = storedYearSection.match(/^([1-5])-(.+)$/);
  if (yearSectionMatch) {
    return {
      year: yearSectionMatch[1],
      section: yearSectionMatch[2].trim(),
      yearSection: storedYearSection,
    };
  }

  const section = normalizeSectionValue(student?.section || '');
  const year = yearLabelToNumber(student?.yearLevel || '');
  if (year || section) {
    return {
      year,
      section,
      yearSection: year && section ? `${year}-${section}` : '',
    };
  }

  const computedYear = yearLabelToNumber(computeYearLevel(student?.studentId || ''));
  return {
    year: computedYear,
    section: '',
    yearSection: '',
  };
}

function getStudentYearLevelLabel(student) {
  const parts = getStudentYearSectionParts(student);
  if (parts.year) return yearNumberToLabel(parts.year);
  const stored = String(student?.yearLevel || '').trim();
  return stored || computeYearLevel(student?.studentId || '');
}

function getStudentYearLevelDisplay(student) {
  const parts = getStudentYearSectionParts(student);
  if (parts.year) return parts.year;
  const label = getStudentYearLevelLabel(student);
  return yearLabelToNumber(label) || label;
}

function getStudentSectionDisplay(student) {
  const parts = getStudentYearSectionParts(student);
  return parts.section || normalizeSectionValue(student?.section || '');
}

function renderStudents(filter) {
  // Only show students enrolled in at least one of this professor's courses
  const mySubjectIds = new Set(DB.getSubjects().map(s => s.id));
  let students = DB.getStudents().filter(s =>
    (s.enrolledSubjects || []).some(id => mySubjectIds.has(id))
  );

  const sections = [...new Set(students.map(s => getStudentSectionDisplay(s)).filter(Boolean))].sort();
  const secSel = document.getElementById('filter-section');
  const prevSec = secSel.value;
  secSel.innerHTML = '<option value="">All Sections</option>' +
    sections.map(s => `<option value="${escHtml(s)}" ${s === prevSec ? 'selected' : ''}>${escHtml(s)}</option>`).join('');

  const programs = [...new Set(students.map(s => s.program).filter(Boolean))].sort();
  const programSel = document.getElementById('filter-program');
  const prevProgram = programSel.value;
  programSel.innerHTML = '<option value="">All Programs</option>' +
    programs.map(p => `<option value="${escHtml(p)}" ${p === prevProgram ? 'selected' : ''}>${escHtml(p)}</option>`).join('');

  const courseSel = document.getElementById('filter-course');
  const prevCourse = courseSel ? courseSel.value : '';
  const myCourses = DB.getSubjects().filter(s => !s.archived).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (courseSel) {
    courseSel.innerHTML = '<option value="">All Courses</option>' +
      myCourses.map(c => `<option value="${escHtml(c.id)}" ${c.id === prevCourse ? 'selected' : ''}>${escHtml(c.name)}${c.code ? ' (' + escHtml(c.code) + ')' : ''}</option>`).join('');
  }

  const q = (filter || '').toLowerCase();
  const yearFilter = document.getElementById('filter-year-level').value;
  const sectionFilter = secSel.value;
  const programFilter = programSel.value;
  const courseFilter = courseSel ? courseSel.value : '';

  if (q) {
    students = students.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.studentId.toLowerCase().includes(q) ||
      (s.program || '').toLowerCase().includes(q) ||
      getStudentSectionDisplay(s).toLowerCase().includes(q) ||
      getStudentYearLevelLabel(s).toLowerCase().includes(q) ||
      (s.yearSection || '').toLowerCase().includes(q)
    );
  }
  if (yearFilter) students = students.filter(s => getStudentYearLevelLabel(s) === yearFilter);
  if (sectionFilter) students = students.filter(s => getStudentSectionDisplay(s) === sectionFilter);
  if (programFilter) students = students.filter(s => (s.program || '') === programFilter);
  if (courseFilter) students = students.filter(s => (s.enrolledSubjects || []).includes(courseFilter));

  const tbody = document.getElementById('students-tbody');
  if (!students.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>No students found.</p></div></td></tr>`;
    return;
  }

  const ylColors = { '1st Year':'yl-1','2nd Year':'yl-2','3rd Year':'yl-3','4th Year':'yl-4', '5th Year':'yl-5' };
  tbody.innerHTML = students.map(s => {
    const yl = getStudentYearLevelLabel(s);
    const ylDisplay = getStudentYearLevelDisplay(s) || '-';
    const sectionDisplay = getStudentSectionDisplay(s) || '-';
    const initials = (s.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const ylClass = ylColors[yl] || 'yl-1';
    return `
    <tr>
      <td data-label="Student ID"><span class="student-id-badge">${escHtml(s.studentId)}</span></td>
      <td data-label="Name">
        <div class="student-name-cell">
          <div class="student-avatar">${initials}</div>
          <span class="student-name-text">${escHtml(s.name)}</span>
        </div>
      </td>
      <td data-label="Year Level"><span class="yl-badge ${ylClass}">${escHtml(ylDisplay)}</span></td>
      <td data-label="Section"><span class="section-text">${escHtml(sectionDisplay)}</span></td>
      <td data-label="Email" class="email-cell">${escHtml(s.email || 'â€”')}</td>
      <td data-label="Program"><span class="section-text">${escHtml(s.program || 'â€”')}</span></td>
      <td data-label="">
        <div class="table-actions">
          <button class="btn-action btn-action-ghost" onclick="openStudentModal('${s.id}')">Edit${icEditFill}</button>
          <button class="tbl-btn tbl-btn-archive" onclick="archiveStudent('${s.id}')">Archive${icArchiveFill}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openStudentModal(id) {
  ensureStudentModalForm();
  document.getElementById('stu-id').value = '';
  document.getElementById('stu-student-id').value = '';
  document.getElementById('stu-name').value = '';
  document.getElementById('stu-year').value = '';
  document.getElementById('stu-section').value = '';
  document.getElementById('stu-email').value = '';
  document.getElementById('stu-program').value = '';
  document.getElementById('modal-student-title').textContent = 'Add Student';

  if (id) {
    const s = DB.getStudentById(id);
    if (!s) return;
    document.getElementById('modal-student-title').textContent = 'Edit Student';
    document.getElementById('stu-id').value = s.id;
    document.getElementById('stu-student-id').value = s.studentId;
    document.getElementById('stu-name').value = s.name;
    document.getElementById('stu-year').value = getStudentYearLevelDisplay(s) || '';
    document.getElementById('stu-section').value = getStudentSectionDisplay(s) || '';
    document.getElementById('stu-email').value = s.email || '';
    document.getElementById('stu-program').value = s.program || '';
  }
  openModal('modal-student');
}

function saveStudent() {
  ensureStudentModalForm();
  const id = document.getElementById('stu-id').value;
  const studentId = document.getElementById('stu-student-id').value.trim().toUpperCase();
  const name = document.getElementById('stu-name').value.trim();
  const yearInput = document.getElementById('stu-year').value.trim();
  const sectionInput = document.getElementById('stu-section').value.trim();
  const email = document.getElementById('stu-email').value.trim().toLowerCase();
  const program = document.getElementById('stu-program').value.trim().toUpperCase();

  if (!studentId || !name) { showToast('Student ID and name are required.', 'error'); return; }
  const idMatch = studentId.match(/^(\d{2})-\d{5}$/);
  if (!idMatch) { showToast('Student ID must be in YY-NNNNN format (e.g. 23-00218).', 'error'); return; }
  const yr = parseInt(idMatch[1]);
  if (yr < 18 || yr > 26) { showToast('Student ID year must be between 2018 (18) and 2026 (26).', 'error'); return; }

  const normalizedYear = yearLabelToNumber(yearInput);
  if (yearInput && !normalizedYear) { showToast('Year level must be a number from 1 to 5.', 'error'); return; }
  const normalizedSection = normalizeSectionValue(sectionInput);
  const yearLevel = normalizedYear ? yearNumberToLabel(normalizedYear) : '';
  const section = normalizedSection || sectionInput;
  const yearSection = normalizedYear && normalizedSection ? `${normalizedYear}-${normalizedSection}` : '';
  const existingStudent = id ? DB.getStudentById(id) : null;

  try {
    if (id) {
      DB.updateStudent(id, { studentId, name, yearLevel, section, yearSection, email, program });
      if (existingStudent) {
        DB.syncStudentReferences(existingStudent.studentId, {
          ...existingStudent,
          studentId,
          name,
          yearLevel,
          section,
          yearSection,
          email,
          program,
        });
      }
      showToast('Student updated.', 'success');
    } else {
      DB.addStudent({ studentId, name, yearLevel, section, yearSection, email, program });
      showToast('Student added.', 'success');
    }
  } catch (error) {
    showToast(error?.message || 'Unable to save student right now.', 'error');
    return;
  }
  closeModal('modal-student');
  renderStudents();
}

function renderStudents(filter) {
  // Only show students enrolled in at least one of this professor's courses
  const mySubjectIds = new Set(DB.getSubjects().map(s => s.id));
  let students = DB.getStudents().filter(s =>
    (s.enrolledSubjects || []).some(id => mySubjectIds.has(id))
  );

  const sections = [...new Set(students.map(s => getStudentSectionDisplay(s)).filter(Boolean))].sort();
  const secSel = document.getElementById('filter-section');
  const prevSec = secSel.value;
  secSel.innerHTML = '<option value="">All Sections</option>' +
    sections.map(s => `<option value="${escHtml(s)}" ${s === prevSec ? 'selected' : ''}>${escHtml(s)}</option>`).join('');

  const programs = [...new Set(students.map(s => s.program).filter(Boolean))].sort();
  const programSel = document.getElementById('filter-program');
  const prevProgram = programSel.value;
  programSel.innerHTML = '<option value="">All Programs</option>' +
    programs.map(p => `<option value="${escHtml(p)}" ${p === prevProgram ? 'selected' : ''}>${escHtml(p)}</option>`).join('');

  const courseSel = document.getElementById('filter-course');
  const prevCourse = courseSel ? courseSel.value : '';
  const myCourses = DB.getSubjects().filter(s => !s.archived).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (courseSel) {
    courseSel.innerHTML = '<option value="">All Courses</option>' +
      myCourses.map(c => `<option value="${escHtml(c.id)}" ${c.id === prevCourse ? 'selected' : ''}>${escHtml(c.name)}${c.code ? ' (' + escHtml(c.code) + ')' : ''}</option>`).join('');
  }

  const q = (filter || '').toLowerCase();
  const yearFilter = document.getElementById('filter-year-level').value;
  const sectionFilter = secSel.value;
  const programFilter = programSel.value;
  const courseFilter = courseSel ? courseSel.value : '';

  if (q) {
    students = students.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.studentId.toLowerCase().includes(q) ||
      (s.program || '').toLowerCase().includes(q) ||
      getStudentSectionDisplay(s).toLowerCase().includes(q) ||
      getStudentYearLevelLabel(s).toLowerCase().includes(q) ||
      (s.yearSection || '').toLowerCase().includes(q)
    );
  }
  if (yearFilter) students = students.filter(s => getStudentYearLevelLabel(s) === yearFilter);
  if (sectionFilter) students = students.filter(s => getStudentSectionDisplay(s) === sectionFilter);
  if (programFilter) students = students.filter(s => (s.program || '') === programFilter);
  if (courseFilter) students = students.filter(s => (s.enrolledSubjects || []).includes(courseFilter));

  const tbody = document.getElementById('students-tbody');
  if (!students.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>No students found.</p></div></td></tr>`;
    return;
  }

  const ylColors = { '1st Year':'yl-1','2nd Year':'yl-2','3rd Year':'yl-3','4th Year':'yl-4', '5th Year':'yl-5' };
  tbody.innerHTML = students.map(s => {
    const yl = getStudentYearLevelLabel(s);
    const ylDisplay = getStudentYearLevelDisplay(s) || '-';
    const sectionDisplay = getStudentSectionDisplay(s) || '-';
    const emailDisplay = s.email || '-';
    const programDisplay = s.program || '-';
    const initials = (s.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const ylClass = ylColors[yl] || 'yl-1';
    return `
    <tr>
      <td data-label="Student ID"><span class="student-id-badge">${escHtml(s.studentId)}</span></td>
      <td data-label="Name">
        <div class="student-name-cell">
          <div class="student-avatar">${initials}</div>
          <span class="student-name-text">${escHtml(s.name)}</span>
        </div>
      </td>
      <td data-label="Year Level"><span class="yl-badge ${ylClass}">${escHtml(ylDisplay)}</span></td>
      <td data-label="Section"><span class="section-text">${escHtml(sectionDisplay)}</span></td>
      <td data-label="Email" class="email-cell">${escHtml(emailDisplay)}</td>
      <td data-label="Program"><span class="section-text">${escHtml(programDisplay)}</span></td>
      <td data-label="">
        <div class="table-actions">
          <button class="btn-action btn-action-ghost" onclick="openStudentModal('${s.id}')">Edit${icEditFill}</button>
          <button class="tbl-btn tbl-btn-archive" onclick="archiveStudent('${s.id}')">Archive${icArchiveFill}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function archiveStudent(id) {
  const s = DB.getStudentById(id);
  if (!s) return;
  const ok = await showConfirm(`Archive student "${s.name}" (${s.studentId})? They can be restored from the Archive section.`);
  if (!ok) return;
  DB.archiveStudent(id);
  showToast('Student archived.', 'success');
  renderStudents();
}

// ============================================================
// EXAMS
// ============================================================
function renderExams() {
  const exams = DB.getExams();
  const subjects = DB.getSubjects();
  const container = document.getElementById('exams-grid');
  if (!container) return;
  const active = exams.filter(e => e.status !== 'archived');
  if (!active.length) {
    container.innerHTML = `<div class="empty-state"><p>No exams yet. Click "+ Create Exam" to get started.</p></div>`;
    return;
  }
  const statusHeaderColor = {
    draft:  { bg:'linear-gradient(135deg,#6b7280,#9ca3af)', text:'rgba(255,255,255,0.7)' },
    ready:  { bg:'linear-gradient(135deg,#1d4ed8,#3b82f6)', text:'rgba(255,255,255,0.7)' },
    active: { bg:'linear-gradient(135deg,#15803d,#22c55e)', text:'rgba(255,255,255,0.7)' },
    closed: { bg:'linear-gradient(135deg,#991b1b,#ef4444)', text:'rgba(255,255,255,0.7)' },
  };
  container.innerHTML = active.map(e => {
    const subject = subjects.find(s => s.id === e.subjectId);
    const subjectName = subject ? escHtml(formatCourseNameDisplay(subject.name)) : 'No subject';
    const hdr = statusHeaderColor[e.status] || statusHeaderColor.draft;
    const qCount = (e.questions || []).length;
    const actions = buildExamActions(e);
    return `
    <div class="exam-card" onclick="openExamModal('${e.id}')">
      <!-- Colored header like course card -->
      <div class="exam-card-header" style="background:${hdr.bg};">
        <div class="exam-card-header-deco"></div>
        <div class="exam-card-letter">${(e.title||'?').charAt(0).toUpperCase()}</div>
        <div style="position:relative;z-index:1;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            ${statusBadge(e.status)}
            ${e.code ? `<button type="button" class="exam-card-code-btn" title="Copy exam code" onclick="event.stopPropagation();copyExamCode('${escHtml(e.code)}')">${escHtml(e.code)}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` : ''}
          </div>
          <div class="exam-card-title">${escHtml(e.title)}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:2px;">${subjectName}</div>
        </div>
      </div>
      <!-- Stats cells -->
      <div class="exam-card-body">
        <div class="exam-card-stats-cells">
          <div class="exam-stat-cell">
            <div class="exam-stat-num">${qCount}</div>
            <div class="exam-stat-lab">Questions</div>
          </div>
          <div class="exam-stat-cell">
            <div class="exam-stat-num">${e.timeLimit}</div>
            <div class="exam-stat-lab">Minutes</div>
          </div>
        </div>
        <div class="exam-card-date">${formatDate(e.createdAt)}</div>
      </div>
      <div class="exam-card-footer" onclick="event.stopPropagation()">
        ${actions}
      </div>
    </div>`;
  }).join('');
}

function buildMoreItems(e) {
  let items = '';
  if (e.status === 'draft') {
    items += `<button class="action-dd-item" onclick="openQuestionBuilder('${e.id}');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Questions</button>`;
    items += `<button class="action-dd-item" onclick="setExamStatus('${e.id}','ready');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Set Ready</button>`;
  }
  if (e.status === 'ready') {
    items += `<button class="action-dd-item" onclick="openQuestionBuilder('${e.id}');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Questions</button>`;
    items += `<button class="action-dd-item" onclick="setExamStatus('${e.id}','active');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Activate</button>`;
  }
  if (e.status === 'active') {
    items += `<button class="action-dd-item action-dd-item-danger" onclick="setExamStatus('${e.id}','closed');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg> Close Exam</button>`;
  }
  if (e.status === 'closed') {
    items += `<button class="action-dd-item" onclick="reopenExam('${e.id}');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg> Reopen Exam</button>`;
  }
  if (['active','closed'].includes(e.status)) {
    items += `<button class="action-dd-item" onclick="viewExamResults('${e.id}');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> Results</button>`;
    if (e.scoringReleased) {
      items += `<button class="action-dd-item" onclick="hideScoreByExam('${e.id}');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg> Hide Scores</button>`;
    } else {
      items += `<button class="action-dd-item" onclick="releaseScoreByExam('${e.id}');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Release Scores</button>`;
    }
  }
  items += `<div class="action-dd-sep"></div>`;
  items += `<button class="action-dd-item action-dd-item-danger" onclick="deleteExam('${e.id}');closeModal('modal-more-actions')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Delete</button>`;
  return items;
}

function buildExamActions(e) {
  const icEdit    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const icArchive = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
  const icMore    = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>`;

  const pb = (label, icon, onclick, variant = 'white') =>
    `<button class="pushable pushable-${variant}" onclick="${onclick}">
      <span class="pushable-shadow"></span>
      <span class="pushable-edge"></span>
      <span class="pushable-front">${icon} ${label}</span>
    </button>`;

  let btns = '';
  // Edit: same slide-icon animation as course/table edit buttons
  if (['draft','ready','active','closed'].includes(e.status)) {
    btns += `<button class="btn-action btn-action-ghost" onclick="openExamModal('${e.id}')">Edit${icEditFill}</button>`;
  }
  if (['ready','active','closed'].includes(e.status)) {
    btns += `<button class="tbl-btn tbl-btn-archive" onclick="setExamStatus('${e.id}','archived')">Archive${icArchiveFill}</button>`;
  }
  btns += pb('More', icMore, `openMoreModal('${e.id}')`, 'white');
  return btns;
}

function openMoreModal(examId) {
  const e = DB.getExams().find(x => x.id === examId);
  if (!e) return;
  document.getElementById('modal-more-title').textContent = e.title;
  document.getElementById('modal-more-body').innerHTML = buildMoreItems(e);
  openModal('modal-more-actions');
}

async function releaseScoreByExam(examId) {
  const exam = DB.getExam(examId);
  const ok = await showConfirm(`Release scores for "${exam.title}"? Students will be able to see their results.`);
  if (!ok) return;
  DB.getSessionsByExam(examId).forEach(s => DB.updateSession(s.id, { scoreReleased: true }));
  DB.updateExam(examId, { scoringReleased: true });
  showToast('Scores released to students.', 'success');
  renderExams();
}

async function hideScoreByExam(examId) {
  const exam = DB.getExam(examId);
  const ok = await showConfirm(`Hide scores for "${exam.title}"? Students will no longer see their results.`);
  if (!ok) return;
  DB.getSessionsByExam(examId).forEach(s => DB.updateSession(s.id, { scoreReleased: false }));
  DB.updateExam(examId, { scoringReleased: false });
  showToast('Scores hidden from students.', 'success');
  renderExams();
}

function renderArchive(tab) {
  const activeTab = tab || document.getElementById('archive-active-tab')?.value || 'exams';
  document.getElementById('archive-active-tab').value = activeTab;

  ['exams','students','courses'].forEach(t => {
    const btn = document.getElementById('archive-tab-' + t);
    if (btn) btn.classList.toggle('active', t === activeTab);
  });

  if (activeTab === 'students') renderArchivedStudents();
  else if (activeTab === 'courses') renderArchivedCourses();
  else renderArchivedExams();
}

function renderArchivedExams() {
  document.getElementById('archive-exams-table').classList.remove('hidden');
  document.getElementById('archive-students-table').classList.add('hidden');
  document.getElementById('archive-courses-table').classList.add('hidden');

  const exams = DB.getExams().filter(e => e.status === 'archived');
  const subjects = DB.getSubjects();
  const tbody = document.getElementById('archive-tbody');
  if (!exams.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>No archived exams.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = exams.map(e => {
    const subject = subjects.find(s => s.id === e.subjectId);
    return `
      <tr>
        <td data-label="Title"><strong>${escHtml(e.title)}</strong><br/><span class="text-muted" style="font-size:11px;">${formatDate(e.createdAt)}</span></td>
        <td data-label="Subject">${subject ? escHtml(formatCourseNameDisplay(subject.name)) : '<span class="text-muted">N/A</span>'}</td>
        <td data-label="Code" style="text-align:center;">${e.code ? `<span class="code-tag">${e.code}</span>` : '—'}</td>
        <td data-label="Questions" style="text-align:center;">${e.questions.length}</td>
        <td data-label="Time" style="text-align:center;">${e.timeLimit} min</td>
        <td data-label="Archived" style="text-align:center;"><span class="text-muted" style="font-size:12px;">${formatDate(e.updatedAt || e.createdAt)}</span></td>
        <td data-label="">
          <div class="table-actions" style="justify-content:center;">
            <button class="btn-action btn-action-primary" onclick="recoverExam('${e.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg> Recover
            </button>
            <button class="btn-action btn-action-danger" onclick="permanentDeleteExam('${e.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Delete Permanently
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderArchivedStudents() {
  document.getElementById('archive-exams-table').classList.add('hidden');
  document.getElementById('archive-students-table').classList.remove('hidden');
  document.getElementById('archive-courses-table').classList.add('hidden');

  const students = DB.getArchivedStudents();
  const tbody = document.getElementById('archive-students-tbody');
  if (!students.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><p>No archived students.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = students.map(s => `
    <tr>
      <td data-label="Student ID"><span class="code-tag">${escHtml(s.studentId)}</span></td>
      <td data-label="Name"><strong>${escHtml(formatCourseNameDisplay(s.name))}</strong></td>
      <td data-label="Year Level" style="text-align:center;">${escHtml(s.yearLevel || '—')}</td>
      <td data-label="Section" style="text-align:center;">${escHtml(s.section || '—')}</td>
      <td data-label="Archived" style="text-align:center;"><span class="text-muted" style="font-size:12px;">${formatDate(s.archivedAt)}</span></td>
      <td data-label="">
        <div class="table-actions" style="justify-content:center;">
          <button class="btn-action btn-action-primary" onclick="restoreStudent('${s.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg> Restore
          </button>
          <button class="btn-action btn-action-danger" onclick="permanentDeleteStudent('${s.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Delete Permanently
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function recoverExam(id) {
  const exam = DB.getExam(id);
  const ok = await showConfirm(`Recover "${exam.title}"? It will be moved back to draft status.`);
  if (!ok) return;
  DB.updateExam(id, { status: 'draft' });
  renderArchive('exams');
  showToast('Exam recovered and moved to draft.', 'success');
}

async function permanentDeleteExam(id) {
  const exam = DB.getExam(id);
  const ok = await showConfirm(`Permanently delete "${exam.title}"? This cannot be undone.`);
  if (!ok) return;
  DB.deleteExam(id);
  renderArchive('exams');
  showToast('Exam permanently deleted.', 'success');
}

function renderArchivedCourses() {
  document.getElementById('archive-exams-table').classList.add('hidden');
  document.getElementById('archive-students-table').classList.add('hidden');
  document.getElementById('archive-courses-table').classList.remove('hidden');

  const courses = DB.getSubjects().filter(s => s.archived);
  const tbody = document.getElementById('archive-courses-tbody');
  if (!courses.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><p>No archived courses.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = courses.map(s => {
    const years    = (s.yearLevels || []).join(', ') || 'All';
    const sections = (s.sections   || []).join(', ') || 'All';
    return `
      <tr>
        <td><span class="code-tag">${escHtml(s.code)}</span></td>
        <td><strong>${escHtml(formatCourseNameDisplay(s.name))}</strong></td>
        <td>${escHtml(years)}</td>
        <td>${escHtml(sections)}</td>
        <td style="text-align:center;" class="text-muted" style="font-size:12px;">${formatDate(s.archivedAt || s.createdAt)}</td>
        <td>
          <div class="table-actions" style="justify-content:center;">
            <button class="btn-action btn-action-primary" onclick="recoverCourse('${s.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg> Recover
            </button>
            <button class="btn-action btn-action-danger" onclick="permanentDeleteCourse('${s.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Delete Permanently
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

async function archiveCourse(id) {
  const s = DB.getSubject(id);
  if (!s) return;
  const ok = await showConfirm(`Archive course "${s.name}"? It can be restored from the Archive section.`);
  if (!ok) return;
  DB.updateSubject(id, { archived: true, archivedAt: new Date().toISOString() });
  showToast('Course archived.', 'success');
  renderSubjects();
}

async function recoverCourse(id) {
  const s = DB.getSubject(id);
  if (!s) return;
  const ok = await showConfirm(`Recover course "${s.name}"? It will be restored to the Courses section.`);
  if (!ok) return;
  DB.updateSubject(id, { archived: false, archivedAt: null });
  showToast('Course recovered.', 'success');
  renderArchive('courses');
}

async function permanentDeleteCourse(id) {
  const s = DB.getSubject(id);
  if (!s) return;
  const ok = await showConfirm(`Permanently delete "${s.name}"? This cannot be undone.`);
  if (!ok) return;
  DB.deleteSubject(id);
  showToast('Course permanently deleted.', 'success');
  renderArchive('courses');
}

async function restoreStudent(id) {
  const s = DB.getStudentById(id);
  if (!s) return;
  const ok = await showConfirm(`Restore student "${s.name}" (${s.studentId})?`);
  if (!ok) return;
  DB.restoreStudent(id);
  renderArchive('students');
  showToast('Student restored.', 'success');
}

async function permanentDeleteStudent(id) {
  const s = DB.getStudentById(id);
  if (!s) return;
  const ok = await showConfirm(`Permanently delete "${s.name}" (${s.studentId})? This cannot be undone.`);
  if (!ok) return;
  DB.deleteStudent(id);
  renderArchive('students');
  showToast('Student permanently deleted.', 'success');
}

// ── Inline exam editor (Google Forms style) ──────────────

function openExamEditor(id) {
  const subjects = DB.getSubjects();
  const sel = document.getElementById('exam-subject-field');
  sel.innerHTML = subjects.map(s => `<option value="${s.id}">${escHtml(s.code)} - ${escHtml(formatCourseNameDisplay(s.name))}</option>`).join('');

  // Wire subject change → repopulate audience
  if (!sel._audienceWired) {
    sel._audienceWired = true;
    sel.addEventListener('change', function() { populateAudienceSelectors(this.value, [], []); });
  }

  // Reset form
  document.getElementById('exam-id').value = '';
  document.getElementById('exam-title-field').value = '';
  document.getElementById('exam-desc-field').value = '';
  document.getElementById('exam-timelimit-field').value = '60';
  document.getElementById('exam-code-field').value = '';
  document.getElementById('exam-shuffle-q').checked = false;
  document.getElementById('exam-shuffle-a').checked = false;
  document.getElementById('exam-require-camera').checked = false;
  document.getElementById('exam-ai-detect').checked = false;
  document.getElementById('exam-allow-review').checked = false;

  const titleDisplay = document.getElementById('exam-editor-title-display');
  const statusBadgeEl = document.getElementById('exam-editor-status-badge');
  const statusBtn = document.getElementById('exam-editor-status-btn');
  const readyBtn = document.getElementById('exam-editor-ready-btn');
  const qCard = document.getElementById('exam-editor-questions-card');

  if (id) {
    const e = DB.getExam(id);
    if (!e) return;
    document.getElementById('exam-id').value = e.id;
    document.getElementById('exam-title-field').value = e.title;
    document.getElementById('exam-desc-field').value = e.description || '';
    document.getElementById('exam-timelimit-field').value = e.timeLimit;
    document.getElementById('exam-code-field').value = e.code || '';
    document.getElementById('exam-shuffle-q').checked = e.shuffleQuestions || false;
    document.getElementById('exam-shuffle-a').checked = e.shuffleAnswers || false;
    document.getElementById('exam-require-camera').checked = e.requireCamera || false;
    document.getElementById('exam-ai-detect').checked = e.requireAIDetection || false;
    document.getElementById('exam-allow-review').checked = e.allowReview || false;
    sel.value = e.subjectId;
    populateAudienceSelectors(e.subjectId, e.targetYearLevels || [], e.targetSections || []);
    if (titleDisplay) titleDisplay.textContent = e.title;
    if (statusBadgeEl) statusBadgeEl.innerHTML = statusBadge(e.status);
    currentQBuilderExamId = id;
    updateQBadge(id);
    if (qCard) qCard.style.display = '';
    if (readyBtn) readyBtn.style.display = '';
    // Status action button
    const statusActions = { draft:'Set Ready', ready:'Activate', active:'Close Exam', closed:'Reopen' };
    if (statusBtn && statusActions[e.status]) {
      statusBtn.textContent = statusActions[e.status];
      statusBtn.style.display = '';
      statusBtn._examId = id;
      statusBtn._examStatus = e.status;
    } else if (statusBtn) { statusBtn.style.display = 'none'; }
  } else {
    populateAudienceSelectors();
    if (titleDisplay) titleDisplay.textContent = 'New Exam';
    if (statusBadgeEl) statusBadgeEl.innerHTML = statusBadge('draft');
    if (qCard) qCard.style.display = '';
    if (statusBtn) statusBtn.style.display = 'none';
    if (readyBtn) readyBtn.style.display = 'none';
  }

  // Switch views
  document.getElementById('exams-list-view').classList.add('hidden');
  document.getElementById('exam-editor-view').classList.remove('hidden');
  requestAnimationFrame(() => {
    if (id) renderQuestionsList(id);
    initExamEditorDrag();
    initCustomDropdowns(document.getElementById('exam-editor-view'));
  });
}

function closeExamEditor() {
  document.getElementById('exam-editor-view').classList.add('hidden');
  document.getElementById('exams-list-view').classList.remove('hidden');
  renderExams();
}

function saveExamFromEditor() {
  const id = document.getElementById('exam-id').value;
  const title = document.getElementById('exam-title-field').value.trim();
  const subjectId = document.getElementById('exam-subject-field').value;
  const description = document.getElementById('exam-desc-field').value.trim();
  const timeLimit = parseInt(document.getElementById('exam-timelimit-field').value);
  const code = document.getElementById('exam-code-field').value.trim().toUpperCase();
  const shuffleQuestions = document.getElementById('exam-shuffle-q').checked;
  const shuffleAnswers = document.getElementById('exam-shuffle-a').checked;
  const requireCamera = document.getElementById('exam-require-camera').checked;
  const requireAIDetection = document.getElementById('exam-ai-detect').checked;
  const allowReview = document.getElementById('exam-allow-review').checked;
  const targetYearLevels = [...document.querySelectorAll('.exam-year-cb:checked')].map(cb => cb.value);
  const targetSections   = [...document.querySelectorAll('.exam-section-cb:checked')].map(cb => cb.value);

  if (!title) { showToast('Exam title is required.', 'error'); return; }
  if (!subjectId) { showToast('Please select a subject.', 'error'); return; }
  if (!timeLimit || timeLimit < 1) { showToast('Please enter a valid time limit.', 'error'); return; }

  const data = { title, subjectId, description, timeLimit, code, shuffleQuestions, shuffleAnswers, requireCamera, requireAIDetection, allowReview, targetYearLevels, targetSections };

  let examId = id;
  if (id) {
    DB.updateExam(id, data);
    showToast('Exam saved.', 'success');
  } else {
    const exam = DB.addExam({ ...data, status: 'draft', scoringReleased: false, questions: [] });
    examId = exam.id;
    document.getElementById('exam-id').value = examId;
    showToast('Exam created.', 'success');
  }
  currentQBuilderExamId = examId;
  const qCard = document.getElementById('exam-editor-questions-card');
  if (qCard) qCard.style.display = '';
  const readyBtnSave = document.getElementById('exam-editor-ready-btn');
  if (readyBtnSave) readyBtnSave.style.display = '';
  renderQuestionsList(examId);
  updateQBadge(examId);
  const titleDisplay = document.getElementById('exam-editor-title-display');
  if (titleDisplay) titleDisplay.textContent = title;
  const statusBadgeEl = document.getElementById('exam-editor-status-badge');
  const e2 = DB.getExam(examId);
  if (statusBadgeEl && e2) statusBadgeEl.innerHTML = statusBadge(e2.status);
}

async function saveAndActivateExam() {
  // Save first
  saveExamFromEditor();
  const examId = document.getElementById('exam-id').value;
  if (!examId) return;

  const exam = DB.getExam(examId);
  if (!exam) return;

  // Generate code if missing
  if (!exam.code) {
    const code = Math.random().toString(36).substr(2, 6).toUpperCase();
    DB.updateExam(examId, { code });
    const codeField = document.getElementById('exam-code-field');
    if (codeField) codeField.value = code;
  }

  // Require at least one question
  if (!exam.questions || exam.questions.length === 0) {
    showToast('Add at least one question before activating.', 'error');
    return;
  }

  const ok = await showConfirm(`Set "${exam.title}" to Ready? Students will be able to enter the waiting room.`);
  if (!ok) return;

  DB.updateExam(examId, { status: 'ready' });

  // Update status badge in editor
  const statusBadgeEl = document.getElementById('exam-editor-status-badge');
  if (statusBadgeEl) statusBadgeEl.innerHTML = statusBadge('ready');

  showToast('Exam is now Ready — students can join.', 'success');
  renderExams();
}

function handleExamEditorStatusAction() {
  const btn = document.getElementById('exam-editor-status-btn');
  if (!btn) return;
  const examId = btn._examId;
  const status = btn._examStatus;
  const nextStatus = { draft:'ready', ready:'active', active:'closed', closed:'ready' };
  if (examId && nextStatus[status]) {
    setExamStatus(examId, nextStatus[status]);
    // refresh editor topbar
    const e = DB.getExam(examId);
    if (e) {
      const statusBadgeEl = document.getElementById('exam-editor-status-badge');
      if (statusBadgeEl) statusBadgeEl.innerHTML = statusBadge(e.status);
      const statusActions = { draft:'Set Ready', ready:'Activate', active:'Close Exam', closed:'Reopen' };
      btn.textContent = statusActions[e.status] || '';
      btn._examStatus = e.status;
    }
  }
}

// Keep openExamModal as alias for compatibility (More modal, archive, etc.)
function openExamModal(id, startTab) { openExamEditor(id); }

function switchExamTab(tab) {
  document.getElementById('exam-tab-details').classList.toggle('hidden', tab !== 'details');
  document.getElementById('exam-tab-questions').classList.toggle('hidden', tab !== 'questions');
  document.getElementById('exam-tab-btn-details').classList.toggle('active', tab === 'details');
  document.getElementById('exam-tab-btn-questions').classList.toggle('active', tab === 'questions');

  const footer = document.getElementById('exam-modal-footer');
  const isEdit = !!document.getElementById('exam-id').value;
  if (tab === 'questions') {
    footer.innerHTML = `<button class="btn btn-secondary" onclick="switchExamTab('details')">&#8592; Back to Details</button><button class="btn btn-primary" onclick="closeModal('modal-exam')">Done</button>`;
  } else {
    footer.innerHTML = `<button class="btn btn-secondary" onclick="closeModal('modal-exam')">Cancel</button><button class="btn btn-primary" id="exam-save-btn" onclick="saveExam()">${isEdit ? 'Save Details' : 'Save &amp; Continue to Questions'}</button>`;
  }
}

function updateQBadge(examId) {
  const e = DB.getExam(examId);
  const badge = document.getElementById('exam-q-count');
  if (badge && e) badge.textContent = e.questions.length || '';
}

function saveExam() {
  const id = document.getElementById('exam-id').value;
  const title = document.getElementById('exam-title-field').value.trim();
  const subjectId = document.getElementById('exam-subject-field').value;
  const description = document.getElementById('exam-desc-field').value.trim();
  const timeLimit = parseInt(document.getElementById('exam-timelimit-field').value);
  const code = document.getElementById('exam-code-field').value.trim().toUpperCase();
  const shuffleQuestions = document.getElementById('exam-shuffle-q').checked;
  const shuffleAnswers = document.getElementById('exam-shuffle-a').checked;
  const requireCamera = document.getElementById('exam-require-camera').checked;
  const requireAIDetection = document.getElementById('exam-ai-detect').checked;
  const targetYearLevels = [...document.querySelectorAll('.exam-year-cb:checked')].map(cb => cb.value);
  const targetSections   = [...document.querySelectorAll('.exam-section-cb:checked')].map(cb => cb.value);

  if (!title) { showToast('Exam title is required.', 'error'); return; }
  if (!subjectId) { showToast('Please select a subject.', 'error'); return; }
  if (!timeLimit || timeLimit < 1) { showToast('Please enter a valid time limit.', 'error'); return; }

  const allowReview  = document.getElementById('exam-allow-review').checked;
  const audienceData = { targetYearLevels, targetSections };

  let examId = id;
  if (id) {
    DB.updateExam(id, { title, subjectId, description, timeLimit, code, shuffleQuestions, shuffleAnswers, requireCamera, requireAIDetection, allowReview, ...audienceData });
    showToast('Exam updated.', 'success');
  } else {
    const exam = DB.addExam({ title, subjectId, description, timeLimit, code, shuffleQuestions, shuffleAnswers, requireCamera, requireAIDetection, allowReview, ...audienceData, status: 'draft', scoringReleased: false, questions: [] });
    examId = exam.id;
    document.getElementById('exam-id').value = examId;
    showToast('Exam created.', 'success');
  }
  renderExams();
  currentQBuilderExamId = examId;
  renderQuestionsList(examId);
  updateQBadge(examId);
  document.getElementById('exam-modal-tabs').classList.remove('hidden');
  switchExamTab('questions');
}

function populateAudienceSelectors(savedYears = [], savedSections = []) {
  const students = DB.getStudents();

  // Collect unique year levels
  const allYears = [...new Set(
    students.map(s => s.yearLevel).filter(Boolean)
  )].sort((a, b) => {
    const order = ['1st Year','2nd Year','3rd Year','4th Year','5th Year'];
    return order.indexOf(a) - order.indexOf(b);
  });

  // Collect unique sections
  const allSections = [...new Set(
    students.map(s => s.section).filter(Boolean)
  )].sort();

  const cbStyle = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:500;color:#374151;';

  const yearEl = document.getElementById('exam-year-checks');
  if (yearEl) {
    yearEl.innerHTML = allYears.length
      ? allYears.map(y => `
          <label style="${cbStyle}">
            <input type="checkbox" class="exam-year-cb" value="${escHtml(y)}"
              ${savedYears.includes(y) ? 'checked' : ''}
              style="accent-color:#0f2d1a;width:15px;height:15px;cursor:pointer;" />
            ${escHtml(y)}
          </label>`).join('')
      : `<span style="font-size:12px;color:#9ca3af;font-style:italic;">No students in the system yet</span>`;
  }

  const secEl = document.getElementById('exam-section-checks');
  if (secEl) {
    secEl.innerHTML = allSections.length
      ? allSections.map(s => `
          <label style="${cbStyle}">
            <input type="checkbox" class="exam-section-cb" value="${escHtml(s)}"
              ${savedSections.includes(s) ? 'checked' : ''}
              style="accent-color:#0f2d1a;width:15px;height:15px;cursor:pointer;" />
            ${escHtml(s)}
          </label>`).join('')
      : `<span style="font-size:12px;color:#9ca3af;font-style:italic;">No sections in the system yet</span>`;
  }
}

function populateAudienceSelectors(subjectId, savedYears, savedSections) {
  const subj = DB.getSubject(subjectId);
  const availYears    = (subj && subj.yearLevels) ? subj.yearLevels : [];
  const availSections = (subj && subj.sections)   ? subj.sections   : [];
  const cbStyle = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:500;color:#374151;';

  const yearEl = document.getElementById('exam-year-checks');
  if (yearEl) {
    yearEl.innerHTML = availYears.length
      ? availYears.map(y => `<label style="${cbStyle}"><input type="checkbox" class="exam-year-cb" value="${escHtml(y)}" ${(savedYears||[]).includes(y) ? 'checked' : ''} style="accent-color:#0f2d1a;width:15px;height:15px;cursor:pointer;" />${escHtml(y)}</label>`).join('')
      : `<span style="font-size:12px;color:#9ca3af;font-style:italic;">No year levels defined for this course</span>`;
  }

  const secEl = document.getElementById('exam-section-checks');
  if (secEl) {
    secEl.innerHTML = availSections.length
      ? availSections.map(s => `<label style="${cbStyle}"><input type="checkbox" class="exam-section-cb" value="${escHtml(s)}" ${(savedSections||[]).includes(s) ? 'checked' : ''} style="accent-color:#0f2d1a;width:15px;height:15px;cursor:pointer;" />${escHtml(s)}</label>`).join('')
      : `<span style="font-size:12px;color:#9ca3af;font-style:italic;">No sections defined for this course</span>`;
  }
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateAndSetCode() {
  document.getElementById('exam-code-field').value = generateCode();
}

async function setExamStatus(id, status) {
  const exam = DB.getExam(id);
  if (!exam) return;

  if (status === 'ready') {
    if (exam.questions.length === 0) { showToast('Add at least one question before setting exam to Ready.', 'error'); return; }
    const code = exam.code || generateCode();
    DB.updateExam(id, { status: 'ready', code });
    showToast(`Exam set to Ready. Code: ${code}`, 'success');
  } else if (status === 'active') {
    const ok = await showConfirm(`Activate exam "${exam.title}"? Students can now enter with code ${exam.code}.`);
    if (!ok) return;
    DB.updateExam(id, { status: 'active', startedAt: new Date().toISOString() });
    showToast('Exam is now ACTIVE.', 'success');
  } else if (status === 'closed') {
    const ok = await showConfirm(`Close exam "${exam.title}"? No new submissions will be accepted.`);
    if (!ok) return;
    // Auto-submit all active sessions
    const sessions = DB.getSessionsByExam(id).filter(s => !s.submitted);
    sessions.forEach(s => {
      DB.updateSession(s.id, { submitted: true, autoSubmitted: true, endTime: new Date().toISOString() });
    });
    DB.updateExam(id, { status: 'closed', closedAt: new Date().toISOString() });
    showToast('Exam closed.', 'success');
  } else if (status === 'archived') {
    DB.updateExam(id, { status: 'archived' });
    showToast('Exam archived.', 'success');
  }
  renderExams();
}

async function reopenExam(id) {
  const exam = DB.getExam(id);
  if (!exam) return;

  const choice = await showReopenDialog(exam);
  if (!choice) return;

  if (choice === 'all') {
    // Reset all submitted sessions so everyone can retake
    const sessions = DB.getSessionsByExam(id).filter(s => s.submitted);
    sessions.forEach(s => {
      DB.updateSession(s.id, {
        submitted: false,
        autoSubmitted: false,
        startTime: null,
        endTime: null,
        score: null,
        scoreReleased: false,
        answers: {},
        warnings: 0,
        activities: [],
      });
    });
    DB.updateExam(id, { status: 'active', reopenedAt: new Date().toISOString(), scoringReleased: false });
    showToast('Exam reopened. All students can retake the exam.', 'success');
  } else {
    // Just reopen for new/unsubmitted students; keep existing submissions
    DB.updateExam(id, { status: 'active', reopenedAt: new Date().toISOString() });
    showToast('Exam reopened. Students who haven\'t submitted can now take the exam.', 'success');
  }
  renderExams();
}

function showReopenDialog(exam) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-dialog modal-sm">
        <div class="modal-body confirm-dialog">
          <div class="confirm-icon" style="background:#dbeafe;">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#1d4ed8" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
          </div>
          <div class="confirm-title">Reopen Exam</div>
          <div class="confirm-message" style="margin-bottom:16px;">
            <strong>${escHtml(exam.title)}</strong><br/>
            How do you want to reopen this exam?
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <button class="btn btn-primary btn-block" id="reopen-new-btn">
              New students only
              <span style="display:block;font-size:11px;font-weight:400;opacity:0.85;margin-top:2px;">Already-submitted answers are kept</span>
            </button>
            <button class="btn btn-warning btn-block" id="reopen-all-btn">
              Allow everyone to retake
              <span style="display:block;font-size:11px;font-weight:400;opacity:0.85;margin-top:2px;">Resets all submissions — students start fresh</span>
            </button>
            <button class="btn btn-secondary btn-block" id="reopen-cancel-btn">Cancel</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#reopen-new-btn').onclick  = () => { modal.remove(); resolve('new'); };
    modal.querySelector('#reopen-all-btn').onclick  = () => { modal.remove(); resolve('all'); };
    modal.querySelector('#reopen-cancel-btn').onclick = () => { modal.remove(); resolve(null); };
  });
}

async function deleteExam(id) {
  const exam = DB.getExam(id);
  if (!exam) return;
  const ok = await showConfirm(`Delete exam "${exam.title}"? This will also delete all related sessions.`);
  if (!ok) return;
  DB.deleteExam(id);
  showToast('Exam deleted.', 'success');
  renderExams();
}

// ============================================================
// QUESTION BUILDER
// ============================================================
function openQuestionBuilder(examId) {
  openExamModal(examId, 'questions');
}

function renderQuestionsList(examId) {
  const exam = DB.getExam(examId);
  if (!exam) return;
  const container = document.getElementById('questions-list');

  if (!exam.questions.length) {
    container.innerHTML = `<div class="empty-state" style="padding:20px;"><p>No questions yet. Use the buttons below to add questions.</p></div>`;
  } else {
    container.innerHTML = exam.questions.map((q, idx) => buildQuestionBlock(q, idx)).join('');
    // Auto-size all textareas after render
    requestAnimationFrame(() => {
      container.querySelectorAll('.q-textarea').forEach(ta => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });
    });
  }
  updateQBadge(examId);
}

// ── Enumeration helpers ──────────────────────────────────
function updateEnumAnswer(qIdx, aIdx, val) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => {
    if (i !== qIdx) return q;
    const answers = [...(q.answers || [])];
    answers[aIdx] = val;
    return { ...q, answers };
  });
  DB.updateExam(currentQBuilderExamId, { questions });
}
function addEnumAnswer(qIdx) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => i !== qIdx ? q : { ...q, answers: [...(q.answers||[]), ''] });
  DB.updateExam(currentQBuilderExamId, { questions });
  renderQuestionsList(currentQBuilderExamId);
}
function removeEnumAnswer(qIdx, aIdx) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => {
    if (i !== qIdx) return q;
    const answers = (q.answers || []).filter((_, ai) => ai !== aIdx);
    return { ...q, answers };
  });
  DB.updateExam(currentQBuilderExamId, { questions });
  renderQuestionsList(currentQBuilderExamId);
}

// ── Matching Type helpers ─────────────────────────────────
function updateMatchPair(qIdx, pIdx, field, val) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => {
    if (i !== qIdx) return q;
    const pairs = (q.pairs || []).map((p, pi) => pi !== pIdx ? p : { ...p, [field]: val });
    return { ...q, pairs };
  });
  DB.updateExam(currentQBuilderExamId, { questions });
}
function addMatchPair(qIdx) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => i !== qIdx ? q : { ...q, pairs: [...(q.pairs||[]), {term:'',match:''}] });
  DB.updateExam(currentQBuilderExamId, { questions });
  renderQuestionsList(currentQBuilderExamId);
}
function removeMatchPair(qIdx, pIdx) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => {
    if (i !== qIdx) return q;
    const pairs = (q.pairs || []).filter((_, pi) => pi !== pIdx);
    return { ...q, pairs };
  });
  DB.updateExam(currentQBuilderExamId, { questions });
  renderQuestionsList(currentQBuilderExamId);
}

// ── Custom question-type dropdown ────────────────────────
function toggleTypeDD(idx) {
  const dd = document.getElementById(`qtd-${idx}`);
  if (!dd) return;
  const isOpen = dd.classList.contains('open');
  document.querySelectorAll('.qe-type-dd.open').forEach(d => d.classList.remove('open'));
  if (!isOpen) dd.classList.add('open');
}

function pickQuestionType(idx, type) {
  document.querySelectorAll('.qe-type-dd.open').forEach(d => d.classList.remove('open'));
  changeQuestionType(idx, type);
}

// Close on outside click
document.addEventListener('click', () => {
  document.querySelectorAll('.qe-type-dd.open').forEach(d => d.classList.remove('open'));
});

function setTFAnswer(qIdx, answer) {
  updateQField(qIdx, 'correctAnswer', answer);
  // In-place update — no re-render
  const grp = document.getElementById(`tf-group-${qIdx}`);
  if (!grp) return;
  grp.querySelectorAll('.tf-option').forEach(label => {
    const isNow = label.dataset.val === answer;
    label.classList.toggle('tf-selected', isNow);
    const radio = label.querySelector('.anim-radio');
    if (radio) radio.classList.toggle('anim-radio-on', isNow);
  });
}

function pickEnumScoring(qIdx, partial) {
  document.querySelectorAll('.qe-type-dd.open').forEach(d => d.classList.remove('open'));
  updateQField(qIdx, 'partialScoring', partial);
  // Update label in-place
  const dd = document.getElementById(`qtd-score-${qIdx}`);
  if (dd) {
    const label = dd.querySelector('.qtd-label');
    if (label) label.textContent = partial ? 'Partial scoring' : 'All-or-nothing';
    dd.querySelectorAll('.qtd-opt').forEach((opt, i) => opt.classList.toggle('qtd-active', partial ? i===0 : i===1));
  }
}

function changeQuestionType(idx, newType) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const defaults = {
    mcq:           { options: ['','','',''], correctAnswer: '', points: 1 },
    checkbox:      { options: ['','','',''], correctAnswerIndices: [], points: 1 },
    tf:            { options: ['True','False'], correctAnswer: 'True', points: 1 },
    identification:{ options: [], correctAnswer: '', points: 1 },
    essay:         { options: [], correctAnswer: '', points: 10, rubric: '', minWords: 0 },
    enumeration:   { options: [], correctAnswer: '', points: 5, answers: ['','',''], partialScoring: true },
    matching:      { options: [], correctAnswer: '', points: 5, pairs: [{term:'',match:''},{term:'',match:''}], partialScoring: true },
  };
  const questions = exam.questions.map((q, i) => i !== idx ? q : { ...q, type: newType, ...(defaults[newType] || {}) });
  DB.updateExam(currentQBuilderExamId, { questions });
  renderQuestionsList(currentQBuilderExamId);
}

function buildQuestionBlock(q, idx) {
  const PLP = '#166534';
  const typeColors = { mcq: PLP, checkbox: PLP, tf: PLP, identification: PLP, enumeration: PLP, matching: PLP, essay: PLP, coding: PLP };
  const typeColor  = typeColors[q.type] || '#6b7280';
  let optionsHtml  = '';

  if (q.type === 'enumeration') {
    const answers = Array.isArray(q.answers) ? q.answers : [''];
    optionsHtml = `
      <div class="form-group">
        <label>Expected Answers <span class="text-muted" style="font-weight:400;">(each item students must list)</span></label>
        <div id="enum-list-${idx}" style="display:flex;flex-direction:column;gap:6px;">
          ${answers.map((a, ai) => `
            <div style="display:flex;gap:8px;align-items:center;">
              <span style="font-size:12px;color:#9ca3af;font-weight:700;min-width:22px;">${ai+1}.</span>
              <input type="text" class="form-control" value="${escHtml(a)}" placeholder="Expected answer ${ai+1}" onchange="updateEnumAnswer(${idx},${ai},this.value)" style="flex:1;" />
              <button class="btn btn-danger btn-sm" onclick="removeEnumAnswer(${idx},${ai})" ${answers.length<=1?'disabled':''}>✕</button>
            </div>`).join('')}
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="addEnumAnswer(${idx})">+ Add Answer</button>
      </div>
      <div class="form-group">
        <label>Scoring</label>
        <div class="qe-type-dd" id="qtd-score-${idx}" style="display:inline-block;">
          <button class="qe-type-trigger" onclick="event.stopPropagation();toggleTypeDD('score-${idx}')">
            <span class="qtd-label">${q.partialScoring!==false?'Partial scoring':'All-or-nothing'}</span>
            <svg class="qtd-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="qtd-panel">
            <div class="qtd-opt${q.partialScoring!==false?' qtd-active':''}" onclick="event.stopPropagation();pickEnumScoring(${idx},true)">Partial (per correct item)</div>
            <div class="qtd-opt${q.partialScoring===false?' qtd-active':''}" onclick="event.stopPropagation();pickEnumScoring(${idx},false)">All-or-nothing</div>
          </div>
        </div>
      </div>`;
  } else if (q.type === 'matching') {
    const pairs = Array.isArray(q.pairs) ? q.pairs : [{term:'',match:''}];
    optionsHtml = `
      <div class="form-group">
        <label>Matching Pairs <span class="text-muted" style="font-weight:400;">(term → correct match)</span></label>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px 12px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #f3f4f6;">
          <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Term / Question</div>
          <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Correct Match</div>
          <div></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${pairs.map((p, pi) => `
            <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:center;">
              <input type="text" class="form-control" value="${escHtml(p.term||'')}" placeholder="Term ${pi+1}" onchange="updateMatchPair(${idx},${pi},'term',this.value)" />
              <input type="text" class="form-control" value="${escHtml(p.match||'')}" placeholder="Match ${pi+1}" onchange="updateMatchPair(${idx},${pi},'match',this.value)" />
              <button class="btn btn-danger btn-sm" onclick="removeMatchPair(${idx},${pi})" ${pairs.length<=2?'disabled':''}>✕</button>
            </div>`).join('')}
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:10px;" onclick="addMatchPair(${idx})">+ Add Pair</button>
        <p class="text-muted" style="font-size:11px;margin-top:6px;">Partial scoring: each correct pair = ${q.points} ÷ ${pairs.length} pts</p>
      </div>`;
  } else if (q.type === 'essay') {
    optionsHtml = `
      <div class="form-group">
        <label>Grading Rubric / Notes <span class="text-muted" style="font-weight:400;">(optional — shown to admin when grading)</span></label>
        <textarea class="form-control" rows="2" placeholder="e.g. Mention 3 key concepts, min 100 words..." onchange="updateQField(${idx},'rubric',this.value)">${escHtml(q.rubric || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Min Words Required</label>
        <input type="number" class="form-control" style="width:120px;" value="${q.minWords || 0}" min="0" max="1000" onchange="updateQField(${idx},'minWords',parseInt(this.value)||0)" />
      </div>
      <div class="essay-note">
        <strong>Note:</strong> Essay answers are manually graded by the instructor. Students' scores for essay questions start at 0 until you grade them in Reports.
      </div>`;
  } else if (q.type === 'coding') {
    const langOptions = [
      ['python','Python'],['javascript','JavaScript'],['java','Java'],
      ['cpp','C++'],['c','C'],['php','PHP'],
    ].map(([v,l]) => `<option value="${v}"${q.language===v?' selected':''}>${l}</option>`).join('');
    optionsHtml = `
      <div class="form-row cols-2">
        <div class="form-group">
          <label>Programming Language</label>
          <select class="form-control" onchange="updateQField(${idx},'language',this.value)">${langOptions}</select>
        </div>
        <div class="form-group">
          <label>Grading Rubric <span class="text-muted" style="font-weight:400;">(optional)</span></label>
          <input type="text" class="form-control" value="${escHtml(q.rubric||'')}" placeholder="e.g. Check logic, correct output, clean code" onchange="updateQField(${idx},'rubric',this.value)" />
        </div>
      </div>
      <div class="form-group">
        <label>Starter Code <span class="text-muted" style="font-weight:400;">(shown to students — leave blank for empty editor)</span></label>
        <textarea class="form-control q-textarea" rows="5" placeholder="# Write starter code here..." style="font-family:monospace;font-size:13px;" onchange="updateQField(${idx},'starterCode',this.value)">${escHtml(q.starterCode||'')}</textarea>
      </div>
      <div class="form-group">
        <label>Expected Output <span class="text-muted" style="font-weight:400;">(shown to students as reference)</span></label>
        <textarea class="form-control q-textarea" rows="3" placeholder="Expected program output..." style="font-family:monospace;font-size:13px;" onchange="updateQField(${idx},'expectedOutput',this.value)">${escHtml(q.expectedOutput||'')}</textarea>
      </div>
      <div style="font-size:12px;color:#6b7280;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
        <strong>Note:</strong> Students write their solution in a code editor. Answers are manually graded — scores start at 0 until you review them in Reports.
      </div>`;
  } else if (q.type === 'checkbox') {
    // correctAnswerIndices stores INDICES so empty-string options don't collide
    const correctIndices = Array.isArray(q.correctAnswerIndices) ? q.correctAnswerIndices : [];
    optionsHtml = `<div id="opts-${idx}" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;">` +
      q.options.map((opt, oi) => {
        const on = correctIndices.includes(oi);
        // Simple SVG indicator — no animated checkbox here (re-render replaces DOM, so animations don't fire anyway)
        const cbIcon = on
          ? `<svg class="qe-cb-icon qe-cb-on" width="20" height="20" viewBox="0 0 20 20" fill="none"><rect width="20" height="20" rx="4" fill="#1a6b35"/><polyline points="15,6 8,14 4,10" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
          : `<svg class="qe-cb-icon" width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="0.75" y="0.75" width="18.5" height="18.5" rx="3.5" stroke="#d1d5db" stroke-width="1.5"/></svg>`;
        return `<div class="qe-opt-row${on ? ' qe-opt-correct' : ''}" onclick="toggleCheckboxAnswer(${idx},${oi})">
          ${cbIcon}
          <input type="text" class="qe-opt-input" value="${escHtml(opt)}" placeholder="Option ${oi+1}" onchange="updateOption(${idx},${oi},this.value)" onclick="event.stopPropagation()" />
          <button class="qe-opt-del" onclick="event.stopPropagation();removeOption(${idx},${oi})" title="Remove"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>`;
      }).join('') +
      `</div>
      <button class="qe-add-opt" onclick="addOption(${idx})">+ Add option</button>
      <div class="qe-hint"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 11 12 14 22 4"/></svg> Multiple correct answers — tap each correct option</div>`;
  } else if (q.type === 'mcq') {
    const isCorrect = (opt) => q.correctAnswer === opt;
    optionsHtml = `<div id="opts-${idx}" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;">` +
      q.options.map((opt, oi) => `
        <div class="qe-opt-row${isCorrect(opt) ? ' qe-opt-correct' : ''}" onclick="setCorrectOption(${idx},${oi})">
          <div class="anim-radio${isCorrect(opt) ? ' anim-radio-on' : ''}"><div class="anim-radio-inner"></div></div>
          <input type="text" class="qe-opt-input" value="${escHtml(opt)}" placeholder="Option ${oi+1}" onchange="updateOption(${idx},${oi},this.value)" onclick="event.stopPropagation()" />
          <button class="qe-opt-del" onclick="event.stopPropagation();removeOption(${idx},${oi})" title="Remove"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>`).join('') +
      `</div>
      <button class="qe-add-opt" onclick="addOption(${idx})">+ Add option</button>
      <div class="qe-hint"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg> Single correct answer — tap an option to mark it</div>`;
  } else if (q.type === 'tf') {
    optionsHtml = `
      <div class="tf-group" id="tf-group-${idx}">
        <div class="tf-label">Correct Answer</div>
        <div class="tf-options">
          ${['True','False'].map(val => `
            <label class="tf-option${q.correctAnswer===val?' tf-selected':''}" data-val="${val}" onclick="setTFAnswer(${idx},'${val}')">
              <div class="anim-radio${q.correctAnswer===val?' anim-radio-on':''}">
                <div class="anim-radio-inner"></div>
              </div>
              <span>${val}</span>
            </label>`).join('')}
        </div>
      </div>`;
  } else if (q.type === 'identification') {
    optionsHtml = `
      <div class="form-group">
        <label>Correct Answer (case-insensitive)</label>
        <input type="text" class="form-control" value="${escHtml(q.correctAnswer)}" placeholder="Enter correct answer" onchange="updateQField(${idx},'correctAnswer',this.value.toUpperCase())" style="text-transform:uppercase;" />
      </div>`;
  }

  const imgPreview = q.imageUrl
    ? `<img src="${escHtml(q.imageUrl)}" alt="Question image" class="q-img-preview" onerror="this.style.display='none'" />`
    : '';

  return `
    <div class="qe-card" id="qblock-${idx}" data-qidx="${idx}" draggable="true" style="--q-accent:${typeColor}">
      <div class="qe-card-header">
        <div class="qe-header-left">
          <div style="display:flex;flex-direction:column;align-items:center;gap:3px;" onclick="event.stopPropagation()">
            <div class="checkbox-wrapper-30">
              <div class="checkbox" style="--size:0.78;--stroke:#1a6b35">
                <input type="checkbox" ${q.required !== false ? 'checked' : ''} onchange="updateQField(${idx},'required',this.checked)" />
                <svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="3" class="cb-border"/><polyline points="20,6 9,17 4,12" class="cb-check"/></svg>
              </div>
            </div>
            <span style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;line-height:1;user-select:none;">Required</span>
          </div>
          <span class="qe-badge" style="background:${typeColor}">Q${idx+1}</span>
          <div class="qe-type-dd" id="qtd-${idx}">
            <button class="qe-type-trigger" onclick="event.stopPropagation();toggleTypeDD(${idx})">
              <span class="qtd-label">${{mcq:'Multiple choice',checkbox:'Checkboxes',tf:'True / False',identification:'Identification',enumeration:'Enumeration',matching:'Matching Type',essay:'Essay'}[q.type]||q.type}</span>
              <svg class="qtd-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="qtd-panel">
              ${[['mcq','Multiple choice'],['checkbox','Checkboxes'],['tf','True / False'],['identification','Identification'],['enumeration','Enumeration'],['matching','Matching Type'],['essay','Essay']].map(([t,l])=>`<div class="qtd-opt${q.type===t?' qtd-active':''}" onclick="event.stopPropagation();pickQuestionType(${idx},'${t}')">${l}</div>`).join('')}
            </div>
          </div>
        </div>
        <div class="qe-header-right">
          <span class="qe-pts-label">Pts</span>
          <input type="number" class="qe-pts-input" value="${q.points}" min="1" onchange="updateQField(${idx},'points',parseInt(this.value)||1)" />
          <button class="qe-del-btn" onclick="removeQuestion(${idx})" title="Delete question">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </div>
      <div class="qe-card-body">
        <textarea class="qe-q-textarea" rows="1" placeholder="Question text" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'" onchange="updateQField(${idx},'content',this.value)">${escHtml(q.content)}</textarea>
        ${imgPreview ? `<div class="q-img-preview-wrap" id="qimg-preview-${idx}" style="margin-bottom:10px;">${imgPreview}</div>` : `<div id="qimg-preview-${idx}" style="display:none;"></div>`}
        <div class="qe-img-row">
          <label class="qe-img-btn" for="qimg-input-${idx}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Image</label>
          <input type="file" id="qimg-input-${idx}" accept="image/*" style="display:none;" onchange="handleQImageUpload(${idx}, this)" />
          ${q.imageUrl ? `<button class="qe-img-remove" onclick="clearQImage(${idx})">Remove</button>` : ''}
        </div>
        ${optionsHtml}
      </div>
    </div>
  `;
}

// ── Drag-and-drop question reordering ────────────────────
let _dragQIdx = null;

function initExamEditorDrag() {
  const container = document.getElementById('questions-list');
  if (!container || container._dragInited) return;
  container._dragInited = true;

  container.addEventListener('dragstart', e => {
    const block = e.target.closest('.qe-card');
    if (!block) return;
    _dragQIdx = parseInt(block.dataset.qidx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(_dragQIdx));
    setTimeout(() => block.classList.add('q-dragging'), 0);
  });

  container.addEventListener('dragend', () => {
    container.querySelectorAll('.question-block').forEach(b =>
      b.classList.remove('q-dragging', 'q-drag-over'));
    _dragQIdx = null;
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const block = e.target.closest('.qe-card');
    if (!block) return;
    const overIdx = parseInt(block.dataset.qidx);
    if (overIdx === _dragQIdx) return;
    container.querySelectorAll('.question-block').forEach(b => b.classList.remove('q-drag-over'));
    block.classList.add('q-drag-over');
  });

  container.addEventListener('dragleave', e => {
    if (!container.contains(e.relatedTarget)) {
      container.querySelectorAll('.question-block').forEach(b => b.classList.remove('q-drag-over'));
    }
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    const block = e.target.closest('.qe-card');
    if (!block || _dragQIdx === null) return;
    const dropIdx = parseInt(block.dataset.qidx);
    if (dropIdx === _dragQIdx) return;
    const exam = DB.getExam(currentQBuilderExamId);
    if (!exam) return;
    const questions = [...exam.questions];
    const [moved] = questions.splice(_dragQIdx, 1);
    questions.splice(dropIdx, 0, moved);
    DB.updateExam(currentQBuilderExamId, { questions });
    renderQuestionsList(currentQBuilderExamId);
  });
}

function toggleCheckboxAnswer(qIdx, optIdx) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const q = exam.questions[qIdx];
  if (!q) return;

  // Compute new state
  const correctAnswerIndices = Array.isArray(q.correctAnswerIndices) ? [...q.correctAnswerIndices] : [];
  const pos = correctAnswerIndices.indexOf(optIdx);
  const nowCorrect = pos < 0;
  if (pos >= 0) correctAnswerIndices.splice(pos, 1);
  else correctAnswerIndices.push(optIdx);

  // Persist to DB
  const questions = exam.questions.map((q2, i) => i !== qIdx ? q2 : { ...q2, correctAnswerIndices });
  DB.updateExam(currentQBuilderExamId, { questions });

  // Update ONLY the clicked row in-place — no full re-render
  const container = document.getElementById(`opts-${qIdx}`);
  if (!container) return;
  const rows = container.querySelectorAll('.qe-opt-row');
  const row = rows[optIdx];
  if (!row) return;

  row.classList.toggle('qe-opt-correct', nowCorrect);

  const on = nowCorrect;
  const newIcon = on
    ? `<svg class="qe-cb-icon qe-cb-on" width="20" height="20" viewBox="0 0 20 20" fill="none"><rect width="20" height="20" rx="4" fill="#1a6b35"/><polyline points="15,6 8,14 4,10" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg class="qe-cb-icon" width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="0.75" y="0.75" width="18.5" height="18.5" rx="3.5" stroke="#d1d5db" stroke-width="1.5"/></svg>`;

  const icon = row.querySelector('.qe-cb-icon');
  if (icon) {
    const tmp = document.createElement('div');
    tmp.innerHTML = newIcon;
    icon.replaceWith(tmp.firstChild);
  }
}

function addQuestion(type) {
  if (!currentQBuilderExamId) {
    saveExamFromEditor();
    if (!currentQBuilderExamId) return; // validation failed
  }
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const defaults = {
    mcq:           { options: ['','','',''], correctAnswer: '', points: 1 },
    checkbox:      { options: ['','','',''], correctAnswerIndices: [], points: 1 },
    tf:            { options: ['True','False'], correctAnswer: 'True', points: 1 },
    identification:{ options: [], correctAnswer: '', points: 1 },
    essay:         { options: [], correctAnswer: '', points: 10, rubric: '', minWords: 0 },
    enumeration:   { options: [], correctAnswer: '', points: 5, answers: ['','',''], partialScoring: true },
    matching:      { options: [], correctAnswer: '', points: 5, pairs: [{term:'',match:''},{term:'',match:''}], partialScoring: true },
    coding:        { options: [], correctAnswer: '', points: 20, language: 'python', starterCode: '', expectedOutput: '', rubric: '' },
  };
  const newQ = {
    id: DB.generateId(),
    type,
    content: '',
    imageUrl: '',
    required: true,
    ...(defaults[type] || { options: [], correctAnswer: '', points: 1 }),
  };
  const questions = [...exam.questions, newQ];
  DB.updateExam(currentQBuilderExamId, { questions });
  renderQuestionsList(currentQBuilderExamId);
  // Animate + scroll the new question into view
  const container = document.getElementById('questions-list');
  const last = container.lastElementChild;
  if (last) {
    last.classList.add('qe-new');
    last.scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => last.classList.remove('qe-new'), 300);
  }
}

function removeQuestion(idx) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.filter((_, i) => i !== idx);
  DB.updateExam(currentQBuilderExamId, { questions });
  renderQuestionsList(currentQBuilderExamId);
}

function updateQField(idx, field, value) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => i === idx ? { ...q, [field]: value } : q);
  DB.updateExam(currentQBuilderExamId, { questions });
}

function updateOption(qIdx, oIdx, value) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => {
    if (i !== qIdx) return q;
    const options = q.options.map((o, oi) => oi === oIdx ? value : o);
    // Update correctAnswer if it was this option
    const correctAnswer = q.correctAnswer === q.options[oIdx] ? value : q.correctAnswer;
    return { ...q, options, correctAnswer };
  });
  DB.updateExam(currentQBuilderExamId, { questions });
}

function setCorrectOption(qIdx, oIdx) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const q = exam.questions[qIdx];
  const correctAnswer = q.options[oIdx];
  const questions = exam.questions.map((q2, i) => i === qIdx ? { ...q2, correctAnswer } : q2);
  DB.updateExam(currentQBuilderExamId, { questions });

  // Update only this question's option rows in-place
  const container = document.getElementById(`opts-${qIdx}`);
  if (!container) { renderQuestionsList(currentQBuilderExamId); return; }
  container.querySelectorAll('.qe-opt-row').forEach((row, i) => {
    const nowCorrect = i === oIdx;
    row.classList.toggle('qe-opt-correct', nowCorrect);
    // Animated radio
    const radio = row.querySelector('.anim-radio');
    if (radio) radio.classList.toggle('anim-radio-on', nowCorrect);
    // Legacy selectors (fallback)
    const inp = row.querySelector('.option-input, .qe-opt-input');
    if (inp) inp.classList.toggle('option-input-correct', nowCorrect);
    const btn = row.querySelector('.option-correct');
    if (btn) btn.classList.toggle('selected', nowCorrect);
  });
}

function addOption(qIdx) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => i === qIdx ? { ...q, options: [...q.options, ''] } : q);
  DB.updateExam(currentQBuilderExamId, { questions });
  renderQuestionsList(currentQBuilderExamId);
}

function removeOption(qIdx, oIdx) {
  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;
  const questions = exam.questions.map((q, i) => {
    if (i !== qIdx) return q;
    const options = q.options.filter((_, oi) => oi !== oIdx);
    return { ...q, options };
  });
  DB.updateExam(currentQBuilderExamId, { questions });
  renderQuestionsList(currentQBuilderExamId);
}

function handleQImageUpload(idx, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    updateQField(idx, 'imageUrl', dataUrl);
    const wrap = document.getElementById('qimg-preview-' + idx);
    if (wrap) wrap.innerHTML = `<img src="${dataUrl}" alt="Question image" class="q-img-preview" />`;
    // Show remove button if not already there
    renderQuestionsList(currentQBuilderExamId);
  };
  reader.readAsDataURL(file);
}

function clearQImage(idx) {
  updateQField(idx, 'imageUrl', '');
  renderQuestionsList(currentQBuilderExamId);
}

function viewExamResults(examId) {
  const exam = DB.getExam(examId);
  if (!exam) return;
  const sessions = DB.getSessionsByExam(examId).filter(s => s.submitted);

  document.getElementById('modal-results-title').textContent = `Results - ${exam.title}`;

  if (!sessions.length) {
    document.getElementById('modal-results-body').innerHTML = `<div class="empty-state"><p>No submissions for this exam.</p></div>`;
    openModal('modal-exam-results');
    return;
  }

  const sorted = [...sessions].sort((a, b) => (b.score || 0) - (a.score || 0));
  const total = sorted.length;
  const avgScore = total ? (sorted.reduce((sum, s) => sum + (s.score || 0), 0) / total).toFixed(1) : 0;

  document.getElementById('modal-results-body').innerHTML = `
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
      <span class="badge badge-info">${total} submission${total !== 1 ? 's' : ''}</span>
      <span class="badge badge-success">Avg: ${avgScore}/${sessions[0]?.maxScore || '?'}</span>
    </div>
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Rank</th><th>Name</th><th>Student ID</th><th>Score</th><th>%</th><th>Warnings</th><th>Submit Type</th><th>Actions</th></tr></thead>
        <tbody>
          ${sorted.map((s, i) => {
            const pct = s.maxScore ? Math.round((s.score / s.maxScore) * 100) : 0;
            return `<tr>
              <td><div class="rank-badge rank-${i < 3 ? i+1 : 'other'}">${i+1}</div></td>
              <td><strong>${escHtml(s.studentName)}</strong></td>
              <td>${escHtml(s.studentId)}</td>
              <td>${s.score !== null ? s.score : '—'}/${s.maxScore}</td>
              <td>${s.maxScore ? pct + '%' : '—'}</td>
              <td>${s.warnings > 0 ? `<span class="badge badge-danger">${s.warnings}</span>` : '0'}</td>
              <td>${s.autoSubmitted ? '<span class="badge badge-warning">Auto</span>' : '<span class="badge badge-success">Manual</span>'}</td>
              <td><button class="btn btn-secondary btn-sm" onclick="viewStudentAnswers('${s.id}')">Review</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
  openModal('modal-exam-results');
}

function viewStudentAnswers(sessionId) {
  const session = DB.getSession(sessionId);
  if (!session) return;
  const exam = DB.getExam(session.examId);
  if (!exam) return;
  const aiScanJobs = [];

  let html = `
    <div class="student-info-box" style="margin-bottom:16px;">
      <div class="info-row"><span class="info-label">Student</span><span class="info-value">${escHtml(session.studentName)}</span></div>
      <div class="info-row"><span class="info-label">Student ID</span><span class="info-value">${escHtml(session.studentId)}</span></div>
      <div class="info-row"><span class="info-label">Score</span><span class="info-value">${session.score}/${session.maxScore} (${session.maxScore ? Math.round(session.score/session.maxScore*100) : 0}%)</span></div>
      <div class="info-row"><span class="info-label">Warnings</span><span class="info-value">${session.warnings}</span></div>
    </div>
  `;

  const exam_ = DB.getExam(session.examId);
  const requireAI = exam_ && exam_.requireAIDetection;

  exam.questions.forEach((q, idx) => {
    const studentAns = (session.answers || {})[q.id] || '';

    if (q.type === 'essay') {
      const aiId = `ai-badge-${session.id}-${q.id}`;
      const wordCount = studentAns ? studentAns.split(/\s+/).filter(Boolean).length : 0;
      const cachedAIDetection = requireAI && studentAns
        ? getCachedEssayAIDetection(session.id, q.id, studentAns)
        : null;
      if (requireAI && studentAns && !cachedAIDetection) {
        aiScanJobs.push({ badgeId: aiId, questionId: q.id, text: studentAns });
      }
      html += `
        <div class="answer-row" style="border-color:#e2e8f0;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <strong style="font-size:14px;">Q${idx+1} (Essay): ${escHtml(q.content)}</strong>
          </div>
          ${q.rubric ? `<div style="font-size:11px;color:#6b7280;background:#f9fafb;border-radius:6px;padding:6px 10px;margin-bottom:8px;"><strong>Rubric:</strong> ${escHtml(q.rubric)}</div>` : ''}
          <div style="font-size:13px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;white-space:pre-wrap;line-height:1.6;min-height:60px;margin-bottom:10px;" id="essay-text-${session.id}-${q.id}">${escHtml(studentAns || '(no answer)')}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <span style="font-size:12px;color:#9ca3af;">${wordCount} words &nbsp;·&nbsp; max ${q.points} pts</span>
            ${requireAI && studentAns ? `
              <div style="display:flex;align-items:center;gap:8px;">
                <div id="${aiId}-bar-wrap" style="width:120px;height:8px;background:#f3f4f6;border-radius:99px;overflow:hidden;">
                  <div id="${aiId}-bar" style="height:100%;width:${cachedAIDetection ? cachedAIDetection.score : 0}%;border-radius:99px;background:${cachedAIDetection ? getAIDetectionBarColor(cachedAIDetection.label) : '#9ca3af'};transition:width 0.4s;"></div>
                </div>
                <span id="${aiId}" class="ai-badge ${cachedAIDetection ? `ai-badge-${cachedAIDetection.label}` : 'ai-badge-scanning'}" style="cursor:pointer;" title="${escHtml(cachedAIDetection?.reason || 'Auto-scanning essay answer')}" onclick="detectAIContentDetailed(document.getElementById('essay-text-${session.id}-${q.id}').textContent,'${aiId}','${session.id}','${q.id}', true)">
                  ${cachedAIDetection ? `AI: <strong>${cachedAIDetection.score}%</strong> <span style="font-weight:400;">(${cachedAIDetection.label})</span>` : 'Scanning...'}
                </span>
              </div>` : requireAI ? '<span style="font-size:12px;color:#9ca3af;">No answer to scan</span>' : ''}
          </div>
        </div>`;
    } else {
      const isCorrect = studentAns.trim().toUpperCase() === q.correctAnswer.trim().toUpperCase();
      const rowClass = studentAns ? (isCorrect ? 'correct' : 'wrong') : '';
      html += `
        <div class="answer-row ${rowClass}">
          <div style="font-weight:600;margin-bottom:4px;">Q${idx+1}: ${escHtml(q.content)}</div>
          <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:12px;">
            <span>Student: <span class="student-ans">${escHtml(studentAns || '(no answer)')}</span></span>
            <span>Correct: <span class="correct-ans">${escHtml(q.correctAnswer)}</span></span>
            <span>${isCorrect ? '✓ +' + q.points : (studentAns ? '✗ 0' : '— 0')} pts</span>
          </div>
        </div>`;
    }
  });

  // Activity log
  if (session.activities && session.activities.length) {
    html += `<hr class="divider" /><div style="font-weight:600;margin-bottom:8px;font-size:13px;">Suspicious Behavior Counter</div>`;
    html += renderBehaviorSummary(session.activities);
    html += `<div style="font-weight:600;margin:14px 0 8px;font-size:13px;">Anti-Cheat Activity Timeline</div>`;
    session.activities.forEach(a => {
      html += `<div class="log-item"><div class="log-type ${a.type}">${escHtml(getBehaviorLabel(a.type))}</div><div class="log-detail">${escHtml(a.detail)}</div><div class="log-time">${formatDateTime(a.timestamp)}</div></div>`;
    });
  }

  document.getElementById('modal-answers-title').textContent = `Answers - ${session.studentName}`;
  document.getElementById('modal-answers-body').innerHTML = html;
  openModal('modal-student-answers');
  aiScanJobs.forEach(job => {
    detectAIContentDetailed(job.text, job.badgeId, session.id, job.questionId);
  });
}

// ============================================================
// MONITORING
// ============================================================
function loadMonitoringExams() {
  const exams = DB.getExams().filter(e => e.status === 'active' || e.status === 'closed');
  const sel = document.getElementById('monitor-exam-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select an exam to monitor</option>' +
    exams.map(e => `<option value="${e.id}" ${e.id === cur ? 'selected' : ''}>${escHtml(e.title)} [${e.status.toUpperCase()}]</option>`).join('');
  if (cur) sel.value = cur;
}

let _monitorView = 'table'; // 'table' | 'camera'

function setMonitorView(view) {
  _monitorView = view;
  const tableView = document.getElementById('monitoring-grid');
  const camView = document.getElementById('camera-grid-view');
  const btnTable = document.getElementById('monitor-view-table');
  const btnCam = document.getElementById('monitor-view-camera');

  const activeStyle = { background: '#1a4d2a', color: '#fff' };
  const inactiveStyle = { background: 'transparent', color: '#6b7280' };

  const statsStrip = document.getElementById('monitor-stats-strip');

  if (view === 'camera') {
    if (tableView) tableView.style.display = 'none';
    if (camView) camView.style.display = '';
    if (statsStrip) statsStrip.style.display = 'none';
    if (btnTable) Object.assign(btnTable.style, inactiveStyle);
    if (btnCam) Object.assign(btnCam.style, activeStyle);
    renderCameraGrid(monitorExamId);
  } else {
    if (tableView) tableView.style.display = '';
    if (camView) camView.style.display = 'none';
    if (statsStrip) statsStrip.style.display = '';
    if (btnTable) Object.assign(btnTable.style, activeStyle);
    if (btnCam) Object.assign(btnCam.style, inactiveStyle);
  }
}

function renderCameraGrid(examId) {
  const container = document.getElementById('camera-grid-container');
  const empty = document.getElementById('camera-grid-empty');
  if (!container) return;

  if (!examId) {
    container.innerHTML = '';
    if (empty) { empty.style.display = ''; container.style.display = 'none'; }
    return;
  }

  // Only show ACTIVE (not yet submitted) students with camera snapshots
  const sessions = DB.getSessionsByExam(examId).filter(s => !s.submitted && s.cameraSnapshots?.length > 0);

  if (!sessions.length) {
    container.innerHTML = '';
    container.style.display = 'none';
    if (empty) {
      empty.style.display = '';
      empty.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5" style="margin-bottom:12px;"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
        <div style="font-size:14px;font-weight:600;color:#6b7280;">No active camera feeds</div>
        <div style="font-size:12px;margin-top:4px;color:#4b5563;">Feeds appear here for students currently taking the exam</div>`;
    }
    return;
  }

  if (empty) empty.style.display = 'none';
  container.style.display = 'grid';

  container.innerHTML = sessions.map(s => {
    const snap = s.cameraSnapshots[0];
    const warnColor = s.warnings >= 3 ? '#dc2626' : s.warnings >= 2 ? '#f59e0b' : s.warnings >= 1 ? '#eab308' : '#22c55e';

    const warnBadge = s.warnings > 0
      ? `<div style="position:absolute;top:10px;right:10px;background:${warnColor};color:#fff;font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;backdrop-filter:blur(4px);">⚠ ${s.warnings}/3</div>`
      : `<div style="position:absolute;top:10px;left:10px;background:rgba(34,197,94,0.9);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;display:flex;align-items:center;gap:4px;"><span style="width:6px;height:6px;border-radius:50%;background:#fff;animation:camPulse 1.5s infinite;display:inline-block;"></span>LIVE</div>`;

    const timeAgo = snap?.timestamp ? (() => {
      const secs = Math.floor((Date.now() - new Date(snap.timestamp).getTime()) / 1000);
      if (secs < 60) return secs + 's ago';
      return Math.floor(secs/60) + 'm ago';
    })() : '';

    const initial = (s.studentName || '?').charAt(0).toUpperCase();

    return `<div style="position:relative;aspect-ratio:16/9;background:#111827;overflow:hidden;border-radius:4px;">
      <img src="${escHtml(snap.imageData)}" alt="${escHtml(s.studentName)}"
        style="width:100%;height:100%;object-fit:cover;display:block;"
        onerror="this.style.display='none'" />
      ${warnBadge}
      <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.9));padding:10px 12px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="width:26px;height:26px;border-radius:50%;background:#1a4d2a;color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:2px solid rgba(255,255,255,0.3);">${initial}</div>
          <div style="min-width:0;">
            <div style="color:#fff;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(s.studentName)}</div>
            <div style="color:rgba(255,255,255,0.5);font-size:10px;">${escHtml(s.studentId)} · ${escHtml(timeAgo)}</div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function onMonitorExamChange() {
  monitorExamId = document.getElementById('monitor-exam-select').value;
  document.getElementById('log-body').innerHTML = `<div class="empty-state"><p>Select a student to view activity</p></div>`;
  document.getElementById('log-student-name').textContent = '';
  renderMonitoringTable(monitorExamId);
  // Re-apply view mode (renderMonitoringTable may have re-shown the stats strip)
  setMonitorView(_monitorView);
}

function startMonitoring() {
  stopMonitoring();
  monitorInterval = setInterval(() => {
    loadMonitoringExams();
    if (monitorExamId) {
      renderMonitoringTable(monitorExamId);
      if (_monitorView === 'camera') {
        renderCameraGrid(monitorExamId);
        // Re-hide stats strip after renderMonitoringTable re-shows it
        const strip = document.getElementById('monitor-stats-strip');
        if (strip) strip.style.display = 'none';
      }
    }
  }, 3000);
  document.getElementById('monitor-live-badge').classList.remove('hidden');
}

function stopMonitoring() {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  const badge = document.getElementById('monitor-live-badge');
  if (badge) badge.classList.add('hidden');
}

function renderMonitoringTable(examId) {
  const countEl = document.getElementById('monitor-count');
  const grid = document.getElementById('monitoring-grid');

  if (!examId) {
    countEl.textContent = '0 students';
    document.getElementById('monitor-tbody').innerHTML =
      `<tr><td colspan="6"><div class="empty-state"><p>Select an active exam above to start monitoring.</p></div></td></tr>`;
    // Clear stats strip if exists
    const strip = document.getElementById('monitor-stats-strip');
    if (strip) strip.remove();
    return;
  }

  const exam = DB.getExam(examId);
  const sessions = DB.getSessionsByExam(examId);
  const totalQs = exam ? exam.questions.length : 1;

  countEl.textContent = sessions.length + ' student' + (sessions.length !== 1 ? 's' : '');

  // ── Stats strip ──────────────────────────────────────────
  const inProgress = sessions.filter(s => !s.submitted).length;
  const submitted  = sessions.filter(s => s.submitted).length;
  const flagged    = sessions.filter(s => s.warnings >= 2).length;

  const stats = [
    { accent:'#166534', bg:'#dcfce7', value: sessions.length, label:'Total',
      icon:`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#166534" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>` },
    { accent:'#d97706', bg:'#fef3c7', value: inProgress, label:'In Progress',
      icon:`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>` },
    { accent:'#166534', bg:'#dcfce7', value: submitted,  label:'Submitted',
      icon:`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#166534" stroke-width="2.2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>` },
    { accent:'#dc2626', bg:'#fee2e2', value: flagged,    label:'Flagged',
      icon:`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>` },
  ];

  let strip = document.getElementById('monitor-stats-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'monitor-stats-strip';
    strip.className = 'monitor-stats-strip';
    grid.parentNode.insertBefore(strip, grid);
  }
  strip.innerHTML = stats.map(c => `
    <div class="monitor-stat-card" style="border-left-color:${c.accent}">
      <div class="msc-icon" style="background:${c.bg};">${c.icon}</div>
      <div class="msc-body">
        <div class="msc-value" style="color:${c.accent}">${c.value}</div>
        <div class="msc-label">${c.label}</div>
      </div>
    </div>`).join('');

  if (!sessions.length) {
    document.getElementById('monitor-tbody').innerHTML =
      `<tr><td colspan="6"><div class="empty-state"><p>No students have joined this exam yet.</p></div></td></tr>`;
    return;
  }

  // ── Student rows ─────────────────────────────────────────
  const chipColors = ['#0f2d1a','#1d4ed8','#7c3aed','#b45309','#0d9488','#be185d','#dc2626','#065f46'];
  const chipColor = (str) => {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
    return chipColors[Math.abs(h) % chipColors.length];
  };

  document.getElementById('monitor-tbody').innerHTML = sessions.map(s => {
    const answered = Object.keys(s.answers || {}).length;
    const pct = totalQs > 0 ? Math.round((answered / totalQs) * 100) : 0;
    const initial = (s.studentName || s.studentId).charAt(0).toUpperCase();
    const color   = chipColor(s.studentId);

    const statusBadgeHtml = s.submitted
      ? (s.autoSubmitted
          ? '<span class="ms-badge ms-badge-amber">Auto-Submitted</span>'
          : '<span class="ms-badge ms-badge-green">Submitted</span>')
      : '<span class="ms-badge ms-badge-blue">In Progress</span>';

    const warnHtml = s.warnings > 0
      ? `<span class="ms-warn-pill">${s.warnings}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>`
      : `<span style="color:#d1d5db;font-size:13px;">—</span>`;

    const activityCount = (s.activities || []).length;
    const eyeOpen   = `<svg class="ms-eye" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const eyeClosed = `<svg class="ms-eye ms-eye-closed" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    const logsHtml = `<button class="ms-log-btn" id="ms-log-btn-${s.id}" onclick="showStudentLog('${s.id}')">
      ${eyeClosed}
      ${activityCount > 0 ? `<span class="ms-log-count">${activityCount}</span>` : '<span style="color:#d1d5db;font-size:12px;">—</span>'}
    </button>`;

    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="monitor-avatar" style="background:${color};">${initial}</div>
          <div>
            <div style="font-weight:700;font-size:13px;">${escHtml(s.studentName)}</div>
            <div style="font-size:11px;color:#9ca3af;">${escHtml(s.studentId)} · ${escHtml(s.yearLevel || '')} ${escHtml(s.section || '')}</div>
          </div>
        </div>
      </td>
      <td style="text-align:center;">
        <div class="monitor-progress-wrap">
          <div class="monitor-progress-bar"><div class="monitor-progress-fill" style="width:${pct}%;"></div></div>
          <div class="monitor-progress-label">${answered}/${totalQs} answered (${pct}%)</div>
        </div>
      </td>
      <td style="text-align:center;">${warnHtml}</td>
      <td style="text-align:center;">${statusBadgeHtml}</td>
      <td style="text-align:center;">${logsHtml}</td>
      <td style="text-align:center;">
        <div class="table-actions" style="justify-content:center;">
          ${!s.submitted ? `<button class="tbl-btn tbl-btn-archive" onclick="forceSubmitStudent('${s.id}')">Force Submit</button>` : '<span style="font-size:12px;color:#9ca3af;">Submitted</span>'}
        </div>
      </td>
    </tr>`;
  }).join('');
}

const EYE_OPEN   = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
const EYE_CLOSED = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`;

function _setEye(sessionId, open) {
  const btn = document.getElementById(`ms-log-btn-${sessionId}`);
  if (!btn) return;
  const eye = btn.querySelector('.ms-eye');
  if (!eye) return;
  eye.innerHTML = open ? EYE_OPEN : EYE_CLOSED;
  eye.classList.toggle('ms-eye-closed', !open);
}

let _activeLogSessionId = null;
function showStudentLog(sessionId) {
  // Toggle: if already open for this student, close it
  if (_activeLogSessionId === sessionId) {
    _setEye(sessionId, false);
    _activeLogSessionId = null;
    document.getElementById('log-student-name').textContent = '';
    document.getElementById('log-body').innerHTML = `<div class="empty-state"><p>Select a student to view activity</p></div>`;
    return;
  }

  // Close previously active eye
  if (_activeLogSessionId) _setEye(_activeLogSessionId, false);

  // Open new
  _activeLogSessionId = sessionId;
  _setEye(sessionId, true);

  const session = DB.getSession(sessionId);
  if (!session) return;
  document.getElementById('log-student-name').textContent = ' — ' + session.studentName;
  const activities = session.activities || [];
  if (!activities.length) {
    document.getElementById('log-body').innerHTML = `<div class="empty-state"><p>No suspicious activity recorded.</p></div>`;
    return;
  }
  document.getElementById('log-body').innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;font-size:13px;">Suspicious Behavior Counter</div>
    ${renderBehaviorSummary(activities)}
    <div style="font-weight:600;margin:14px 0 8px;font-size:13px;">Activity Timeline</div>
    ${activities.map(a => `
      <div class="log-item">
        <div class="log-type ${a.type}">${escHtml(getBehaviorLabel(a.type))}</div>
        <div class="log-detail">${escHtml(a.detail)}</div>
        <div class="log-time">${formatDateTime(a.timestamp)}</div>
      </div>
    `).join('')}
  `;
}

function exportActivityLog() {
  const examId = monitorExamId;
  const exam   = examId ? DB.getExam(examId) : null;
  const sessions = DB.getSessions().filter(s => (!examId || s.examId === examId));

  if (!sessions.length) {
    showToast('No sessions to export.', 'warning');
    return;
  }

  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fmtDate = ts => ts ? new Date(ts).toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const rows = [];

  // ── Header ──────────────────────────────────────────────────
  rows.push(['=== PLP ExamGuard — Activity Log Export ===']);
  rows.push([`Exam: ${exam ? exam.title : 'All Exams'}`, `Exported: ${fmtDate(new Date().toISOString())}`]);
  rows.push([]);

  // ── Summary table ────────────────────────────────────────────
  rows.push(['--- STUDENT SUMMARY ---']);

  const violationTypes = ['tab_switch', 'window_blur', 'fullscreen_exit', 'no_person', 'low_brightness', 'copy_attempt', 'screenshot'];
  const summaryHeader = [
    'Student Name', 'Student ID', 'Warnings', 'Score', 'Max Score', 'Status',
    ...violationTypes.map(t => getBehaviorLabel(t)),
    'Total Activities',
  ];
  rows.push(summaryHeader);

  sessions.forEach(s => {
    const activities = s.activities || [];
    const counts = Object.fromEntries(violationTypes.map(t => [t, 0]));
    activities.forEach(a => { if (a.type in counts) counts[a.type]++; });
    const status = s.submitted ? (s.autoSubmitted ? 'Auto-Submitted' : 'Submitted') : 'In Progress';
    const scoreStr = s.submitted && s.maxScore ? `${s.score ?? 0}` : '';
    rows.push([
      s.studentName || s.studentId,
      s.studentId,
      s.warnings ?? 0,
      scoreStr,
      s.maxScore ?? '',
      status,
      ...violationTypes.map(t => counts[t] || 0),
      activities.length,
    ]);
  });

  // ── Timeline ─────────────────────────────────────────────────
  rows.push([]);
  rows.push(['--- ACTIVITY TIMELINE ---']);
  rows.push(['Timestamp', 'Student Name', 'Student ID', 'Violation Type', 'Detail']);

  sessions.forEach(s => {
    const activities = s.activities || [];
    activities.forEach(a => {
      rows.push([
        fmtDate(a.timestamp),
        s.studentName || s.studentId,
        s.studentId,
        getBehaviorLabel(a.type),
        a.detail || '',
      ]);
    });
  });

  // ── Build CSV ────────────────────────────────────────────────
  const csv = rows.map(r => Array.isArray(r) ? r.map(esc).join(',') : esc(r)).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const filename = `activity-log${exam ? '-' + exam.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() : ''}-${new Date().toISOString().slice(0,10)}.csv`;
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast('Activity log exported.', 'success');
}

async function forceSubmitStudent(sessionId) {
  const ok = await showConfirm('Force submit this student\'s exam? Their current answers will be saved and scored.');
  if (!ok) return;
  const session = DB.getSession(sessionId);
  if (!session) return;
  const exam = DB.getExam(session.examId);
  let score = 0, max = 0;
  if (exam) {
    exam.questions.forEach(q => {
      max += q.points;
      if (q.type === 'essay') return; // manual grading
      const ans = (session.answers || {})[q.id];
      if (ans && ans.trim().toUpperCase() === q.correctAnswer.trim().toUpperCase()) score += q.points;
    });
  }
  DB.updateSession(sessionId, { submitted: true, autoSubmitted: true, endTime: new Date().toISOString(), score, maxScore: max });
  DB.addLog({ sessionId, studentId: session.studentId, examId: session.examId, type: 'force_submit', details: 'Force submitted by admin' });
  showToast('Student force-submitted.', 'success');
  renderMonitoringTable(monitorExamId);
}

// ============================================================
// ============================================================
// STATISTICS (full page per exam)
// ============================================================
function loadStatsExams() {
  const exams = DB.getExams().filter(e => ['active','closed','archived'].includes(e.status));
  const sel = document.getElementById('stats-exam-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select an exam to explore analytics</option>' +
    exams.map(e => `<option value="${e.id}">${escHtml(e.title)} [${e.status}]</option>`).join('');
}

function renderExamStats() {
  const examId = document.getElementById('stats-exam-select').value;
  const content = document.getElementById('stats-content');
  if (!examId) {
    content.innerHTML = `<div class="dash-empty"><div class="dash-empty-title">No exam selected</div><div class="dash-empty-sub">Pick an exam above to view performance trends, scores, and question insights.</div></div>`;
    return;
  }

  const exam = DB.getExam(examId);
  const sessions = DB.getSessionsByExam(examId).filter(s => s.submitted);
  const subject = DB.getSubject(exam.subjectId);

  if (!sessions.length) {
    content.innerHTML = `<div class="dash-empty"><div class="dash-empty-title">No Submissions Yet</div><div class="dash-empty-sub">No students have submitted this exam.</div></div>`;
    return;
  }

  const scores = sessions.map(s => s.maxScore ? Math.round(s.score / s.maxScore * 100) : 0);
  const avg    = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const max    = Math.max(...scores);
  const min    = Math.min(...scores);
  const sorted = [...scores].sort((a,b)=>a-b);
  const median = sorted.length%2 ? sorted[Math.floor(sorted.length/2)] : Math.round((sorted[sorted.length/2-1]+sorted[sorted.length/2])/2);
  const passing = sessions.filter(s => s.maxScore && s.score/s.maxScore >= 0.75).length;
  const autoSub = sessions.filter(s => s.autoSubmitted).length;
  const flagged = sessions.filter(s => s.warnings >= 2).length;

  // Score distribution
  const ranges = [{l:'0–49',mn:0,mx:49},{l:'50–59',mn:50,mx:59},{l:'60–74',mn:60,mx:74},{l:'75–84',mn:75,mx:84},{l:'85–94',mn:85,mx:94},{l:'95–100',mn:95,mx:100}];
  const maxCount = Math.max(1, ...ranges.map(r => scores.filter(s => s>=r.mn && s<=r.mx).length));
  const distBars = ranges.map(r => {
    const cnt = scores.filter(s => s>=r.mn && s<=r.mx).length;
    const h = Math.max(4, Math.round(cnt/maxCount*80));
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;">
      <div style="font-size:11px;font-weight:700;color:#0f2d1a;">${cnt||''}</div>
      <div style="width:100%;height:${h}px;background:#0f2d1a;opacity:0.8;border-radius:4px 4px 0 0;min-height:4px;"></div>
      <div style="font-size:9px;color:#9ca3af;">${r.l}</div>
    </div>`;
  }).join('');

  // Per-question analysis
  const qStats = exam.questions.map((q, qi) => {
    if (q.type === 'essay') return null;
    let correct = 0;
    sessions.forEach(s => {
      const ans = (s.answers||{})[q.id];
      if (ans && ans.toString().trim().toUpperCase() === (q.correctAnswer||'').toString().trim().toUpperCase()) correct++;
    });
    const pct = sessions.length ? Math.round(correct/sessions.length*100) : 0;
    return { qi, q, correct, pct };
  }).filter(Boolean);

  // Top & bottom performers
  const ranked = [...sessions].sort((a,b)=>(b.score||0)-(a.score||0));

  content.innerHTML = `
    <!-- Overview Strip -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-bottom:24px;">
      ${[
        {label:'Average',value:avg+'%',color:'#0f2d1a'},
        {label:'Median',value:median+'%',color:'#1d4ed8'},
        {label:'Highest',value:max+'%',color:'#15803d'},
        {label:'Lowest',value:min+'%',color:'#dc2626'},
        {label:'Pass Rate (≥75%)',value:Math.round(passing/sessions.length*100)+'%',color:'#0d9488'},
        {label:'Auto-Submitted',value:autoSub,color:'#d97706'},
        {label:'Flagged (≥2 warn)',value:flagged,color:'#dc2626'},
        {label:'Total Submitted',value:sessions.length,color:'#374151'},
      ].map(c=>`<div style="background:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 1px 4px rgba(0,0,0,0.07);">
        <div style="font-size:28px;font-weight:900;color:${c.color};font-family:'Plus Jakarta Sans',sans-serif;letter-spacing:-1px;">${c.value}</div>
        <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.7px;margin-top:4px;">${c.label}</div>
      </div>`).join('')}
    </div>

    <!-- Two column: Distribution + Question Analysis -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <!-- Score Distribution -->
      <div style="background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.07);">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Score Distribution</div>
        <div style="display:flex;align-items:flex-end;gap:6px;height:100px;">${distBars}</div>
      </div>

      <!-- Question Difficulty -->
      <div style="background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.07);overflow-y:auto;max-height:220px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:14px;">Question Difficulty</div>
        ${qStats.length ? qStats.map(({qi,q,correct,pct})=>`
          <div style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
              <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%;">Q${qi+1}: ${escHtml(q.content.substring(0,40))}${q.content.length>40?'…':''}</span>
              <span style="font-weight:700;color:${pct>=75?'#15803d':pct>=50?'#d97706':'#dc2626'};">${pct}%</span>
            </div>
            <div style="height:5px;background:#f3f4f6;border-radius:99px;overflow:hidden;">
              <div style="width:${pct}%;height:100%;background:${pct>=75?'#15803d':pct>=50?'#d97706':'#dc2626'};border-radius:99px;"></div>
            </div>
          </div>`).join('') : '<div style="color:#9ca3af;font-size:13px;">No auto-graded questions.</div>'}
      </div>
    </div>

    <!-- Leaderboard -->
    <div style="background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.07);">
      <div style="font-size:14px;font-weight:700;margin-bottom:14px;">Student Results</div>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Rank</th><th>Student</th><th>Score</th><th>%</th><th>Warnings</th><th>Submit</th><th>Actions</th></tr></thead>
          <tbody>
            ${ranked.map((s,i)=>{
              const pct = s.maxScore?Math.round(s.score/s.maxScore*100):0;
              return `<tr>
                <td><div class="rank-badge rank-${i<3?i+1:'other'}">${i+1}</div></td>
                <td><strong>${escHtml(s.studentName)}</strong><br/><span class="text-muted" style="font-size:11px;">${escHtml(s.studentId)}</span></td>
                <td>${s.score}/${s.maxScore}</td>
                <td><span style="font-weight:700;color:${pct>=75?'#15803d':pct>=50?'#d97706':'#dc2626'};">${pct}%</span></td>
                <td>${s.warnings>0?`<span class="badge badge-danger">${s.warnings}</span>`:'0'}</td>
                <td>${s.autoSubmitted?'<span class="badge badge-warning">Auto</span>':'<span class="badge badge-success">Manual</span>'}</td>
                <td><button class="btn btn-secondary btn-sm" onclick="viewStudentAnswers('${s.id}')">Review</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ============================================================
// REPORTS
// ============================================================
function loadReportExams() {
  const exams = DB.getExams().filter(e => e.status === 'closed' || e.status === 'archived' || e.status === 'active');
  const sel = document.getElementById('report-exam-select');
  sel.innerHTML = '<option value="">Select an exam to review results</option>' +
    exams.map(e => `<option value="${e.id}">${escHtml(e.title)} [${e.status}]</option>`).join('');
  renderReportTable();
}

function renderReportTable() {
  const examId = document.getElementById('report-exam-select').value;
  const pdfBtn = document.getElementById('btn-generate-pdf');
  const releaseBtn = document.getElementById('btn-release-scores');
  pdfBtn.disabled = false;
  releaseBtn.disabled = !examId;

  if (!examId) {
    document.getElementById('report-exam-title').textContent = 'Choose an exam to load results and rankings';
    document.getElementById('report-summary').classList.add('hidden');
    document.getElementById('report-tbody').innerHTML = '';
    releaseBtn.textContent = 'Release Scores';
    releaseBtn.className = 'btn btn-success';
    releaseBtn.onclick = releaseScores;
    return;
  }

  const exam = DB.getExam(examId);
  if (!exam) return;
  document.getElementById('report-exam-title').textContent = exam.title;

  // Toggle release/hide button based on current state
  if (exam.scoringReleased) {
    releaseBtn.textContent = '✓ Scores Released — Hide from Students';
    releaseBtn.className = 'btn btn-warning';
    releaseBtn.onclick = hideScores;
  } else {
    releaseBtn.textContent = 'Release Scores to Students';
    releaseBtn.className = 'btn btn-success';
    releaseBtn.onclick = releaseScores;
  }

  const sessions = DB.getSessionsByExam(examId).filter(s => s.submitted);
  const sorted = [...sessions].sort((a, b) => (b.score || 0) - (a.score || 0));

  const summaryEl = document.getElementById('report-summary');
  summaryEl.classList.remove('hidden');
  document.getElementById('report-submitted-count').textContent = `${sessions.length} submitted`;

  const avgScore = sessions.length ? (sessions.reduce((s, x) => s + (x.score || 0), 0) / sessions.length).toFixed(1) : 'N/A';
  const maxScore = sessions[0]?.maxScore || '?';
  document.getElementById('report-avg-score').textContent = `Avg: ${avgScore}/${maxScore}`;

  if (!sorted.length) {
    document.getElementById('report-tbody').innerHTML = `<tr><td colspan="8"><div class="empty-state"><p>No submissions yet.</p></div></td></tr>`;
    return;
  }

  document.getElementById('report-tbody').innerHTML = sorted.map((s, i) => {
    const pct = s.maxScore ? Math.round((s.score / s.maxScore) * 100) : 0;
    const submissionStatus = getSubmissionStatusBadge(s);
    return `<tr>
      <td><div class="rank-badge rank-${i < 3 ? i+1 : 'other'}">${i+1}</div></td>
      <td><strong>${escHtml(s.studentName)}</strong></td>
      <td>${escHtml(s.studentId)}</td>
      <td>${escHtml(s.yearLevel || '')} ${escHtml(s.section || '')}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <span>${s.score !== null ? s.score : '—'}/${s.maxScore}</span>
          <div class="score-bar-wrap"><div class="score-bar-fill" style="width:${pct}%;"></div></div>
        </div>
      </td>
      <td>${pct}%</td>
      <td>${submissionStatus}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-secondary btn-sm" onclick="viewStudentAnswers('${s.id}')">Review</button>
        <button class="btn btn-warning btn-sm" onclick="allowStudentRetake('${s.id}')" title="Reset this student's submission so they can retake">Allow Retake</button>
      </td>
    </tr>`;
  }).join('');
}

function generatePDF() {
  const examId = document.getElementById('report-exam-select').value;
  if (!examId) return;
  const exam = DB.getExam(examId);
  if (!exam) return;
  const sessions = DB.getSessionsByExam(examId).filter(s => s.submitted);
  const sorted = [...sessions].sort((a, b) => (b.score || 0) - (a.score || 0));
  const settings = DB.getSettings();
  const adminSession = Auth.getAdminSession();
  const now = new Date();

  const { jsPDF } = window.jspdf;
  if (!jsPDF) { showToast('PDF library not loaded. Check internet connection.', 'error'); return; }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // Header
  doc.setFillColor(2, 83, 10);
  doc.rect(0, 0, 210, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(settings.schoolName || 'Pamantasan ng Lungsod ng Pasig', 14, 12);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Examination Results Report', 14, 20);
  doc.setFontSize(8);
  doc.text(`Generated by: ${adminSession ? adminSession.name : 'Admin'} | ${now.toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})} ${now.toLocaleTimeString('en-US')}`, 14, 26);

  doc.setTextColor(26, 26, 26);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(exam.title, 14, 40);

  const subject = DB.getSubject(exam.subjectId);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text(`Subject: ${subject ? formatCourseNameDisplay(subject.name) : 'N/A'} | Time Limit: ${exam.timeLimit} mins | Total Submissions: ${sorted.length}`, 14, 48);

  if (sorted.length === 0) {
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text('No submissions recorded for this exam.', 14, 60);
    doc.save(`${exam.title.replace(/[^a-z0-9]/gi,'_')}_report.pdf`);
    showToast('PDF exported.', 'success');
    return;
  }

  const tableData = sorted.map((s, i) => {
    const pct = s.maxScore ? Math.round((s.score / s.maxScore) * 100) : 0;
    return [i + 1, s.studentName, s.studentId, s.yearLevel || '', s.section || '', `${s.score !== null ? s.score : '—'}/${s.maxScore}`, `${pct}%`];
  });

  doc.autoTable({
    startY: 54,
    head: [['Rank', 'Student Name', 'Student ID', 'Year Level', 'Section', 'Score', 'Percentage']],
    body: tableData,
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [2, 83, 10], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [240, 247, 240] },
    columnStyles: { 0: { halign: 'center', cellWidth: 12 }, 5: { halign: 'center' }, 6: { halign: 'center' } },
    margin: { left: 14, right: 14 },
  });

  // Footer
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Page ${i} of ${pageCount} - ${settings.schoolName || 'Pamantasan ng Lungsod ng Pasig'} - TUKLAS`, 14, 290);
  }

  doc.save(`${exam.title.replace(/[^a-z0-9]/gi,'_')}_report.pdf`);
  showToast('PDF exported successfully.', 'success');
}

let reportHeaderImagePromise = null;

function formatReportDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function slugifyReportName(value) {
  return String(value || 'exam_report')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '') || 'exam_report';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Unable to read file.'));
    reader.readAsDataURL(blob);
  });
}

async function getReportHeaderImage() {
  if (!reportHeaderImagePromise) {
    reportHeaderImagePromise = fetch('/plpasig_header.png')
      .then(response => {
        if (!response.ok) throw new Error('Header image not found.');
        return response.blob();
      })
      .then(blobToDataUrl)
      .catch(error => {
        console.warn('[PDF] Unable to load report header image:', error.message || error);
        return null;
      });
  }
  return reportHeaderImagePromise;
}

function drawPdfPageHeader(doc, examTitle, headerImage) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginLeft = 14;
  let cursorY = 10;

  if (headerImage) {
    const headerProps = doc.getImageProperties(headerImage);
    const maxHeaderWidth = pageWidth - (marginLeft * 2);
    const maxHeaderHeight = 24;
    let headerWidth = maxHeaderWidth;
    let headerHeight = (headerProps.height * headerWidth) / headerProps.width;
    if (headerHeight > maxHeaderHeight) {
      headerHeight = maxHeaderHeight;
      headerWidth = (headerProps.width * headerHeight) / headerProps.height;
    }
    const headerX = (pageWidth - headerWidth) / 2;
    doc.addImage(headerImage, 'PNG', headerX, cursorY, headerWidth, headerHeight);
    cursorY += headerHeight + 4;
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(22, 62, 34);
    doc.text('Pamantasan ng Lungsod ng Pasig', marginLeft, cursorY + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text('TUKLAS Official Report', marginLeft, cursorY + 11);
    cursorY += 16;
  }

  doc.setDrawColor(22, 62, 34);
  doc.setLineWidth(0.5);
  doc.line(marginLeft, cursorY, pageWidth - marginLeft, cursorY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(22, 62, 34);
  doc.text(examTitle, marginLeft, cursorY + 6);

  return cursorY + 10;
}

function drawPdfPageFooter(doc, settings) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 14;
  const pageNumber = doc.internal.getCurrentPageInfo().pageNumber;
  const totalPages = doc.internal.getNumberOfPages();

  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.25);
  doc.line(marginLeft, pageHeight - 14, pageWidth - marginLeft, pageHeight - 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(settings.schoolName || 'Pamantasan ng Lungsod ng Pasig', marginLeft, pageHeight - 9);
  doc.text(`Page ${pageNumber} of ${totalPages}`, pageWidth - marginLeft, pageHeight - 9, { align: 'right' });
}

function drawPdfSummaryCard(doc, x, y, width, label, value, accentColor) {
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(x, y, width, 18, 2.5, 2.5, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(label, x + 4, y + 6);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(accentColor[0], accentColor[1], accentColor[2]);
  doc.text(String(value), x + 4, y + 13);
}

async function exportExamReportPdf() {
  const examId = document.getElementById('report-exam-select').value;
  if (!examId) {
    window.alert('Please select an exam before exporting the PDF report.');
    return;
  }
  const exam = DB.getExam(examId);
  if (!exam) return;

  const { jsPDF } = window.jspdf;
  if (!jsPDF) {
    showToast('PDF library not loaded. Check internet connection.', 'error');
    return;
  }

  const sessions = DB.getSessionsByExam(examId).filter(s => s.submitted);
  const sorted = [...sessions].sort((a, b) => (b.score || 0) - (a.score || 0));
  const settings = DB.getSettings();
  const adminSession = Auth.getAdminSession();
  const subject = DB.getSubject(exam.subjectId);
  const now = new Date();
  const headerImage = await getReportHeaderImage();
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const averagePercent = sorted.length
    ? Math.round(sorted.reduce((sum, session) => sum + (session.maxScore ? (session.score / session.maxScore) * 100 : 0), 0) / sorted.length)
    : 0;
  const passCount = sorted.filter(session => session.maxScore && (session.score / session.maxScore) >= 0.75).length;
  const topPerformer = sorted[0] || null;
  const generatedBy = adminSession?.name || 'Professor';
  const reportStamp = formatReportDateTime(now);
  const pageHeaderBottomY = drawPdfPageHeader(doc, exam.title, headerImage);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  doc.text('Examination Results Report', 105, pageHeaderBottomY + 2, { align: 'center' });

  const examTitleLines = doc.splitTextToSize(exam.title, 178);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(22, 62, 34);
  doc.text(examTitleLines, 14, pageHeaderBottomY + 12);

  let detailY = pageHeaderBottomY + 12 + (examTitleLines.length * 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`Course: ${subject?.name || 'N/A'}`, 14, detailY);
  doc.text(`Time Limit: ${exam.timeLimit || 0} minutes`, 105, detailY, { align: 'center' });
  doc.text(`Generated: ${reportStamp}`, 196, detailY, { align: 'right' });
  detailY += 6;
  doc.text(`Prepared by: ${generatedBy}`, 14, detailY);
  doc.text(`Submitted Records: ${sorted.length}`, 105, detailY, { align: 'center' });
  doc.text(`School: ${settings.schoolName || 'Pamantasan ng Lungsod ng Pasig'}`, 196, detailY, { align: 'right' });
  detailY += 8;

  drawPdfSummaryCard(doc, 14, detailY, 42, 'Average Score', `${averagePercent}%`, [22, 101, 52]);
  drawPdfSummaryCard(doc, 61, detailY, 42, 'Passing Students', `${passCount}`, [21, 128, 61]);
  drawPdfSummaryCard(doc, 108, detailY, 42, 'Needs Review', `${Math.max(sorted.length - passCount, 0)}`, [180, 83, 9]);
  drawPdfSummaryCard(
    doc,
    155,
    detailY,
    41,
    'Highest Mark',
    topPerformer ? `${topPerformer.maxScore ? Math.round((topPerformer.score / topPerformer.maxScore) * 100) : 0}%` : 'N/A',
    [30, 64, 175]
  );

  const tableStartY = detailY + 24;
  if (sorted.length === 0) {
    doc.setFontSize(10);
    doc.setTextColor(71, 85, 105);
    doc.text('No submissions have been recorded for this examination as of the report date.', 14, tableStartY);
    drawPdfPageFooter(doc, settings);
    doc.save(`${slugifyReportName(exam.title)}_report.pdf`);
    showToast('PDF exported.', 'success');
    return;
  }

  const tableData = sorted.map((s, i) => {
    const pct = s.maxScore ? Math.round((s.score / s.maxScore) * 100) : 0;
    return [
      i + 1,
      s.studentName,
      s.studentId,
      `${s.yearLevel || 'N/A'} / ${s.section || 'N/A'}`,
      `${s.score !== null ? s.score : '—'}/${s.maxScore}`,
      `${pct}%`,
      getSubmissionStatusText(s),
    ];
  });

  doc.autoTable({
    startY: tableStartY,
    margin: { top: 36, right: 14, bottom: 20, left: 14 },
    head: [['Rank', 'Student Name', 'Student ID', 'Year / Section', 'Score', 'Percentage', 'Status']],
    body: tableData,
    styles: {
      fontSize: 8.5,
      cellPadding: 3,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.1,
      valign: 'middle',
    },
    headStyles: {
      fillColor: [22, 62, 34],
      textColor: 255,
      fontStyle: 'bold',
      halign: 'center',
    },
    bodyStyles: {
      minCellHeight: 8,
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { halign: 'center', cellWidth: 12 },
      2: { halign: 'center', cellWidth: 24 },
      3: { halign: 'center', cellWidth: 30 },
      4: { halign: 'center', cellWidth: 18 },
      5: { halign: 'center', cellWidth: 22 },
      6: { halign: 'center', cellWidth: 22 },
    },
    didDrawPage: () => {
      if (doc.internal.getCurrentPageInfo().pageNumber > 1) {
        drawPdfPageHeader(doc, exam.title, headerImage);
      }
      drawPdfPageFooter(doc, settings);
    },
  });

  doc.save(`${slugifyReportName(exam.title)}_report.pdf`);
  showToast('PDF exported successfully.', 'success');
}

async function releaseScores() {
  const examId = document.getElementById('report-exam-select').value;
  if (!examId) return;
  const exam = DB.getExam(examId);
  const ok = await showConfirm(`Release scores for "${exam.title}"? Students will be able to see their scores on the result page.`);
  if (!ok) return;
  const sessions = DB.getSessionsByExam(examId);
  sessions.forEach(s => DB.updateSession(s.id, { scoreReleased: true }));
  DB.updateExam(examId, { scoringReleased: true });
  showToast('Scores released to students.', 'success');
  renderReportTable();
}

async function hideScores() {
  const examId = document.getElementById('report-exam-select').value;
  if (!examId) return;
  const exam = DB.getExam(examId);
  const ok = await showConfirm(`Hide scores for "${exam.title}"? Students will no longer see their scores until you release them again.`);
  if (!ok) return;
  const sessions = DB.getSessionsByExam(examId);
  sessions.forEach(s => DB.updateSession(s.id, { scoreReleased: false }));
  DB.updateExam(examId, { scoringReleased: false });
  showToast('Scores are now hidden from students.', 'success');
  renderReportTable();
}

async function allowStudentRetake(sessionId) {
  const session = DB.getSession(sessionId);
  if (!session) return;
  const exam = DB.getExam(session.examId);
  const ok = await showConfirm(
    `Allow ${session.studentName} (${session.studentId}) to retake "${exam ? exam.title : 'this exam'}"?\n\nTheir previous submission, answers, and score will be cleared.`
  );
  if (!ok) return;
  DB.updateSession(sessionId, {
    submitted:     false,
    autoSubmitted: false,
    startTime:     null,
    endTime:       null,
    score:         null,
    scoreReleased: false,
    answers:       {},
    aiDetections:  {},
    warnings:      0,
    activities:    [],
  });
  showToast(`Retake granted for ${session.studentName}.`, 'success');
  renderReportTable();
}

// ============================================================
// SETTINGS
// ============================================================
function loadSettings() {
  const s = DB.getSettings();
  const admin = getCurrentAdminRecord() || {};
  const schoolNameEl = document.getElementById('set-school-name');
  const deptEl = document.getElementById('set-department');
  const nameEl = document.getElementById('set-admin-name');
  const emailEl = document.getElementById('set-admin-email');
  const usernameEl = document.getElementById('set-admin-username');
  const apiKeyEl = document.getElementById('set-claude-api-key');
  const logoImg = document.getElementById('logo-preview-img');
  const logoWrap = document.getElementById('logo-preview-wrap');
  const removeLogoBtn = document.getElementById('btn-remove-logo');

  if (schoolNameEl) schoolNameEl.value = s.schoolName || '';
  if (deptEl) deptEl.value = admin.department || s.department || '';
  if (nameEl) nameEl.value = admin.name || s.adminName || '';
  if (emailEl) emailEl.value = admin.email || s.adminEmail || '';
  if (usernameEl) usernameEl.value = admin.username || '';
  if (apiKeyEl) apiKeyEl.value = s.claudeApiKey || '';

  if (s.logoUrl && logoImg && logoWrap && removeLogoBtn) {
    logoImg.src = s.logoUrl;
    logoWrap.classList.remove('hidden');
    removeLogoBtn.style.display = 'inline-flex';
  }
}

function saveSettings() {
  const schoolNameEl = document.getElementById('set-school-name');
  const departmentEl = document.getElementById('set-department');
  const adminNameEl = document.getElementById('set-admin-name');
  const adminEmailEl = document.getElementById('set-admin-email');
  const adminUsernameEl = document.getElementById('set-admin-username');
  const schoolName = schoolNameEl ? schoolNameEl.value.trim() : '';
  const department = departmentEl ? departmentEl.value.trim() : '';
  const adminName = adminNameEl ? adminNameEl.value.trim() : '';
  const adminEmail = adminEmailEl ? adminEmailEl.value.trim() : '';
  const adminUsername = adminUsernameEl ? adminUsernameEl.value.trim().toLowerCase() : '';
  const session = Auth.getAdminSession();

  if (schoolNameEl && !schoolName) { showToast('School name is required.', 'error', { variant: 'settings' }); return; }
  if (adminUsernameEl && !adminUsername) { showToast('Professor username is required.', 'error', { variant: 'settings' }); return; }
  if (session && adminUsernameEl) {
    const duplicate = DB.getAdmins().find(a => a.username === adminUsername && a.id !== session.id);
    if (duplicate) { showToast('Username already exists.', 'error', { variant: 'settings' }); return; }
  }

  if (schoolNameEl) {
    DB.updateSettings({
      schoolName,
      ...(schoolNameEl ? { adminName } : {}),
      ...(schoolNameEl ? { adminEmail } : {}),
    });
  }

  if (session && adminNameEl && adminEmailEl && adminUsernameEl) {
    DB.updateAdmin(session.id, {
      name: adminName,
      email: adminEmail,
      username: adminUsername,
      department,
    });
    sessionStorage.setItem('acs_admin_session', JSON.stringify({
      ...session,
      username: adminUsername || session.username,
      name: adminName || session.name,
      email: adminEmail || session.email,
      department: department || session.department || '',
    }));
    refreshAdminIdentity();
    loadSettings();
  }

  if (schoolNameEl) document.getElementById('sb-school-name').textContent = schoolName;
  const deptTitle = document.getElementById('courses-department-title');
  if (deptTitle) deptTitle.textContent = department || '';
  const dashboardDeptTitle = document.getElementById('dashboard-department-title');
  if (dashboardDeptTitle) dashboardDeptTitle.textContent = department || '';
  document.title = 'TUKLAS - Admin Panel';
  showToast('Settings saved.', 'success', { variant: 'settings' });
}

function saveClaudeApiKey() {
  // Strip all whitespace/non-printable chars that can sneak in from copy-paste
  const key = document.getElementById('set-claude-api-key').value.replace(/\s/g, '');
  if (!key) { showToast('Please enter an API key.', 'error', { variant: 'settings' }); return; }
  if (!key.startsWith('gsk_')) { showToast('Groq API keys start with "gsk_". Please check your key.', 'error', { variant: 'settings' }); return; }
  DB.updateSettings({ claudeApiKey: key });
  document.getElementById('groq-test-result').textContent = '';
  showToast('Groq API key saved successfully.', 'success', { variant: 'settings' });
}

async function testGroqKey() {
  const resultEl = document.getElementById('groq-test-result');
  const key = document.getElementById('set-claude-api-key').value.replace(/\s/g, '');
  if (!key) { showToast('Enter an API key first.', 'error'); return; }
  resultEl.textContent = 'Testing...';
  resultEl.style.color = '#6b7280';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    const data = await res.json();
    if (res.ok) {
      resultEl.textContent = '✓ Connected successfully!';
      resultEl.style.color = '#16a34a';
    } else {
      resultEl.textContent = '✗ ' + (data.error?.message || 'Error ' + res.status);
      resultEl.style.color = '#dc2626';
    }
  } catch (e) {
    resultEl.textContent = '✗ Network error: ' + e.message;
    resultEl.style.color = '#dc2626';
  }
}

function handleLogoUpload(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('Logo must be less than 5MB.', 'error', { variant: 'settings' }); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const base64 = e.target.result;
    DB.updateSettings({ logoUrl: base64 });
    document.getElementById('logo-preview-img').src = base64;
    document.getElementById('logo-preview-wrap').classList.remove('hidden');
    document.getElementById('btn-remove-logo').style.display = 'inline-flex';
    document.getElementById('sb-logo-wrap').innerHTML = `<img src="${base64}" style="width:38px;height:38px;object-fit:contain;border-radius:8px;" />`;
    showToast('Logo uploaded.', 'success', { variant: 'settings' });
  };
  reader.readAsDataURL(file);
}

function removeLogo() {
  DB.updateSettings({ logoUrl: '' });
  document.getElementById('logo-preview-wrap').classList.add('hidden');
  document.getElementById('btn-remove-logo').style.display = 'none';
  const PLP_LOGO_URL = 'https://plpasig.edu.ph/wp-content/uploads/2023/01/cropped-logo120.png';
  document.getElementById('sb-logo-wrap').innerHTML = `<img src="${PLP_LOGO_URL}" style="width:40px;height:40px;object-fit:contain;border-radius:4px;" />`;
  showToast('Logo removed.', 'success', { variant: 'settings' });
}

function showPasswordVerificationPrompt() {
  return new Promise(resolve => {
    passwordPromptResolve = resolve;
    document.getElementById('confirm-body').innerHTML = `
      <div class="confirm-icon" style="background:#e8f5ec;"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0f5132" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17a2 2 0 0 0 2-2c0-.74-.4-1.39-1-1.73V11a1 1 0 1 0-2 0v2.27A2 2 0 0 0 10 15a2 2 0 0 0 2 2z"/><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/></svg></div>
      <div class="confirm-title">Verify Password</div>
      <div class="confirm-message">Enter your account password to reveal the saved Groq API key.</div>
      <div class="form-group confirm-input-wrap">
        <input type="password" class="form-control" id="verify-account-password" placeholder="Current account password" autocomplete="current-password" />
      </div>
      <div class="confirm-actions">
        <button class="btn btn-secondary" onclick="resolvePasswordPrompt(null)">Cancel</button>
        <button class="btn btn-primary" onclick="resolvePasswordPrompt(document.getElementById('verify-account-password')?.value || '')">Verify</button>
      </div>
    `;
    openModal('modal-confirm');

    requestAnimationFrame(() => {
      const input = document.getElementById('verify-account-password');
      input?.focus();
      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          resolvePasswordPrompt(input.value || '');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          resolvePasswordPrompt(null);
        }
      });
    });
  });
}

function resolvePasswordPrompt(value) {
  closeModal('modal-confirm');
  if (passwordPromptResolve) {
    passwordPromptResolve(value);
    passwordPromptResolve = null;
  }
}

async function togglePassword(fieldId, button) {
  const input = document.getElementById(fieldId);
  if (!input) return;

  const shouldReveal = input.type === 'password';
  if (shouldReveal) {
    const password = await showPasswordVerificationPrompt();
    if (password === null) return;

    const admin = getCurrentAdminRecord();
    if (!admin || !(await Auth.verifyAdminPassword(admin, password))) {
      showToast('Password verification failed.', 'error', { variant: 'settings' });
      return;
    }
  }

  input.type = shouldReveal ? 'text' : 'password';
  if (button) {
    button.style.color = shouldReveal ? '#1a4d2a' : '#666';
    button.setAttribute('aria-label', shouldReveal ? 'Hide API key' : 'Show API key');
    button.setAttribute('title', shouldReveal ? 'Hide API key' : 'Show API key');
  }
}

async function changePassword() {
  const curPass = document.getElementById('set-cur-pass').value;
  const newPass = document.getElementById('set-new-pass').value;
  const confirmPass = document.getElementById('set-confirm-pass').value;
  if (!curPass || !newPass || !confirmPass) { showToast('All password fields are required.', 'error', { variant: 'settings' }); return; }
  if (newPass !== confirmPass) { showToast('New passwords do not match.', 'error', { variant: 'settings' }); return; }
  if (newPass.length < 6) { showToast('Password must be at least 6 characters.', 'error', { variant: 'settings' }); return; }

  const session = Auth.getAdminSession();
  if (!session?.id) { showToast('Professor session not found.', 'error', { variant: 'settings' }); return; }
  const result = await Auth.changeProfessorPassword(session.id, curPass, newPass);
  if (!result?.success) { showToast(result?.message || 'Unable to change password right now.', 'error', { variant: 'settings' }); return; }
  document.getElementById('set-cur-pass').value = '';
  document.getElementById('set-new-pass').value = '';
  document.getElementById('set-confirm-pass').value = '';
  showToast('Password changed successfully.', 'success', { variant: 'settings' });
}

// ============================================================
// MODAL HELPERS
// ============================================================
function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('hidden');
  requestAnimationFrame(() => initCustomDropdowns(modal));
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('hidden');
}

// Close modal on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', function(e) {
    if (e.target === this) this.classList.add('hidden');
  });
});

// ============================================================
// CONFIRM DIALOG
// ============================================================
function showConfirm(options) {
  return new Promise(resolve => {
    const config = typeof options === 'string'
      ? {
          title: 'Confirm Action',
          message: options,
          confirmLabel: 'Confirm',
          confirmClass: 'btn btn-danger',
          icon: 'warning',
        }
      : {
          title: options?.title || 'Confirm Action',
          message: options?.message || '',
          confirmLabel: options?.confirmLabel || 'Confirm',
          confirmClass: options?.confirmClass || 'btn btn-danger',
          icon: options?.icon || 'warning',
        };
    const iconSvg = config.icon === 'signout'
      ? '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'
      : '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
    const iconBg = config.icon === 'signout' ? '#e8f5ec' : '#fef3c7';
    const iconStroke = config.icon === 'signout' ? '#0f5132' : '#d97706';
    confirmResolve = resolve;
    document.getElementById('confirm-body').innerHTML = `
      <div class="confirm-icon" style="background:${iconBg};"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${iconStroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconSvg}</svg></div>
      <div class="confirm-title">${escHtml(config.title)}</div>
      <div class="confirm-message">${escHtml(config.message)}</div>
      <div class="confirm-actions">
        <button class="btn btn-secondary" onclick="resolveConfirm(false)">Cancel</button>
        <button class="${config.confirmClass}" onclick="resolveConfirm(true)">${escHtml(config.confirmLabel)}</button>
      </div>
    `;
    openModal('modal-confirm');
  });
}

function resolveConfirm(result) {
  closeModal('modal-confirm');
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, type = 'success', options = {}) {
  const icons = {
    success: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    warning: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  const variant = options.variant || 'default';
  toast.className = `toast ${type}${variant === 'settings' ? ' toast-settings' : ''}`;
  toast.innerHTML = variant === 'settings'
    ? `<span class="toast-settings-icon">${icons[type] || icons.info}</span><span class="toast-message">${escHtml(message)}</span>`
    : `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-message">${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 350);
  }, 3500);
}

// ============================================================
// UTILITIES
// ============================================================
function buildAudienceTag(exam) {
  const years = exam.targetYearLevels || [];
  const sections = exam.targetSections || [];
  if (!years.length && !sections.length) return '';

  const parts = [];
  if (years.length) {
    // Abbreviate: "1st Year" → "Y1", etc.
    const abbr = { '1st Year': 'Y1', '2nd Year': 'Y2', '3rd Year': 'Y3', '4th Year': 'Y4', '5th Year': 'Y5' };
    parts.push(years.map(y => abbr[y] || y).join(', '));
  }
  if (sections.length) parts.push(sections.join(', '));

  return `<span style="display:inline-flex;align-items:center;gap:4px;background:#f0f9ff;border:1px solid #bae6fd;color:#0369a1;font-size:10px;font-weight:700;padding:1px 7px;border-radius:20px;">
    <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
    ${escHtml(parts.join(' · '))}
  </span>`;
}

function statusBadge(status) {
  const map = {
    draft: 'badge-secondary',
    ready: 'badge-info',
    active: 'badge-success',
    closed: 'badge-danger',
    archived: 'badge-secondary',
  };
  return `<span class="badge ${map[status] || 'badge-secondary'}">${status}</span>`;
}

function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

function formatDateTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return iso; }
}

// ============================================================
// CAMERA SNAPSHOT VIEWER
// ============================================================
function viewCameraSnapshot(sessionId) {
  const session = DB.getSession(sessionId);
  if (!session) return;
  const modal = document.getElementById('modal-camera-snap');
  const img = document.getElementById('modal-cam-img');
  const timeEl = document.getElementById('modal-cam-time');
  const emptyEl = document.getElementById('modal-cam-empty');

  document.getElementById('modal-cam-title').textContent = `Camera — ${session.studentName}`;
  const snaps = session.cameraSnapshots || [];
  if (snaps.length > 0) {
    const latest = snaps[snaps.length - 1];
    img.src = latest.imageData;
    img.style.display = '';
    timeEl.textContent = 'Captured at ' + formatDateTime(latest.timestamp);
    emptyEl.style.display = 'none';
  } else {
    img.src = '';
    img.style.display = 'none';
    timeEl.textContent = '';
    emptyEl.style.display = '';
  }
  openModal('modal-camera-snap');
}

// ============================================================
// AI CONTENT DETECTION (with visual gauge)
// ============================================================
function getAIDetectionCache(sessionId) {
  return DB.getSession(sessionId)?.aiDetections || {};
}

function getEssayDetectionSignature(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `${normalized.length}:${Math.abs(hash)}`;
}

function getEssayDetectionCacheKey(sessionId, questionId) {
  return `${sessionId}::${questionId}`;
}

function getCachedEssayAIDetection(sessionId, questionId, text) {
  if (!sessionId || !questionId || !text) return null;
  const cache = getAIDetectionCache(sessionId);
  const cached = cache[getEssayDetectionCacheKey(sessionId, questionId)];
  if (!cached) return null;
  return cached.signature === getEssayDetectionSignature(text) ? cached.result : null;
}

function cacheEssayAIDetection(sessionId, questionId, text, result) {
  if (!sessionId || !questionId || !text || !result) return;
  const session = DB.getSession(sessionId);
  if (!session) return;
  const cache = { ...(session.aiDetections || {}) };
  cache[getEssayDetectionCacheKey(sessionId, questionId)] = {
    signature: getEssayDetectionSignature(text),
    result,
    updatedAt: new Date().toISOString(),
  };
  DB.updateSession(sessionId, { aiDetections: cache });
}

function getAIDetectionBarColor(label) {
  return label === 'high' ? '#dc2626' : label === 'medium' ? '#d97706' : '#15803d';
}

async function analyzeAIContent(text) {
  const apiKey = DB.getSettings().claudeApiKey;
  if (!apiKey) throw new Error('Groq API key not set. Go to Settings.');
  if (!text || text.trim().length < 30) throw new Error('Text is too short to analyze.');

  const systemPrompt = `You are an expert forensic linguist and AI-generated content detector specialized in analyzing student academic writing. Your task is to determine whether a submitted essay was written by a human student or generated by an AI assistant.

SCORING RUBRIC — rate 0-100 overall AI likelihood:

STRONG AI SIGNALS (+raise score):
• Overly formal or polished academic register inconsistent with student level
• Perfectly balanced paragraph structure (intro/body/conclusion every time)
• Absence of first-person perspective, hedging, uncertainty ("I think", "maybe", "not sure")
• Generic, surface-level examples not tied to course-specific content
• No spelling/grammar errors, no informal phrasing, no colloquialisms
• Bullet-point thinking in prose form ("Firstly... Secondly... Finally...")
• Transitions that are too smooth and formulaic ("Furthermore", "In conclusion", "It is worth noting")
• Abstract generalization without concrete personal insight
• Word count that precisely meets minimum requirements with padding filler

STRONG HUMAN SIGNALS (+lower score):
• Spelling or grammatical errors, informal phrasing
• Personal opinions with emotional tone ("I really believe", "this was shocking")
• Specific concrete examples tied to personal experience or course material
• Inconsistent paragraph lengths, abrupt topic shifts
• Tangential or slightly off-topic digressions
• Repetition of ideas in different words
• Uneven sentence rhythm — some very short, some run-on

CALIBRATION:
• 0–25: Very likely human — clear personal voice, errors, specific examples
• 26–50: Probably human — some AI signals but also authentic markers
• 51–74: Uncertain — mixed signals, could go either way
• 75–89: Probably AI — multiple strong AI patterns, lacks authentic voice
• 90–100: Almost certainly AI — textbook AI patterns throughout

Return ONLY valid JSON (no markdown): {"score":<0-100>,"label":"<low|medium|high>","signals":["<top 3 specific observations>"],"reason":"<one sentence summary>"}
Thresholds: 0-40=low, 41-69=medium, 70-100=high`;

  const userPrompt = `Analyze this student essay answer:\n\n"""\n${text.slice(0, 3000)}\n"""`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 350,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'API error ' + res.status);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Invalid response from AI detector');
  const result = JSON.parse(match[0]);
  const score = Math.min(100, Math.max(0, Number(result.score) || 0));
  const label = score >= 70 ? 'high' : score >= 41 ? 'medium' : 'low';
  const signals = Array.isArray(result.signals) ? result.signals.slice(0, 3) : [];
  return {
    score,
    label,
    reason: result.reason || '',
    signals,
  };
}

async function detectAIContentDetailed(text, badgeId, sessionId, questionId, forceRescan = false) {
  const cachedResult = !forceRescan ? getCachedEssayAIDetection(sessionId, questionId, text) : null;

  const badgeEl = document.getElementById(badgeId);
  const barEl = document.getElementById(badgeId + '-bar');
  if (badgeEl) { badgeEl.className = 'ai-badge ai-badge-scanning'; badgeEl.textContent = 'Scanning…'; }

  const prompt = `You are an AI-generated content detector. Analyze the following student essay response and determine the likelihood that it was generated by an AI (such as ChatGPT, Claude, etc.) rather than written by a human student.

Consider: vocabulary complexity, sentence structure variety, generic phrasing, lack of personal voice, overly perfect grammar, and typical AI writing patterns.

Respond ONLY with a JSON object: {"score": <0-100>, "label": "<low|medium|high>", "reason": "<one brief sentence>"}
- score 0-30 = likely human (label: "low")
- score 31-69 = uncertain (label: "medium")
- score 70-100 = likely AI (label: "high")

Essay text:
"""
${text.slice(0, 2000)}
"""`;

  if (cachedResult) {
    if (barEl) {
      barEl.style.width = cachedResult.score + '%';
      barEl.style.background = getAIDetectionBarColor(cachedResult.label);
    }
    if (badgeEl) {
      badgeEl.className = `ai-badge ai-badge-${cachedResult.label}`;
      badgeEl.innerHTML = `AI: <strong>${cachedResult.score}%</strong> <span style="font-weight:400;">(${cachedResult.label})</span>`;
      badgeEl.title = cachedResult.reason || '';
    }
    return cachedResult;
  }
  if (badgeEl) { badgeEl.textContent = 'Scanning...'; }

  try {
    const result = await analyzeAIContent(text);

    if (barEl) {
      barEl.style.width = result.score + '%';
      barEl.style.background = getAIDetectionBarColor(result.label);
    }
    if (badgeEl) {
      badgeEl.className = `ai-badge ai-badge-${result.label}`;
      badgeEl.innerHTML = `AI: <strong>${result.score}%</strong> <span style="font-weight:400;">(${result.label})</span>`;
      const tooltip = [result.reason, ...(result.signals || [])].filter(Boolean).join('\n• ');
      badgeEl.title = tooltip ? '• ' + tooltip : '';
    }
    cacheEssayAIDetection(sessionId, questionId, text, result);
    return result;
  } catch (e) {
    if (badgeEl) {
      badgeEl.className = 'ai-badge ai-badge-medium';
      badgeEl.textContent = 'Scan failed';
    }
    showToast('AI detection failed: ' + e.message, 'error');
    return null;
  }
}

async function detectAIContent(text, btnEl, badgeId) {
  if (btnEl) btnEl.disabled = true;
  const badgeEl = document.getElementById(badgeId);
  if (badgeEl) { badgeEl.className = 'ai-badge ai-badge-scanning'; badgeEl.textContent = 'Scanning...'; }

  try {
    const result = await analyzeAIContent(text);
    if (badgeEl) {
      badgeEl.className = `ai-badge ai-badge-${result.label}`;
      badgeEl.textContent = `AI: ${result.score}% (${result.label})`;
      badgeEl.title = result.reason || '';
    }
  } catch (e) {
    if (badgeEl) { badgeEl.className = 'ai-badge ai-badge-medium'; badgeEl.textContent = 'Scan failed'; }
    showToast('AI detection failed: ' + e.message, 'error');
  }
  if (btnEl) btnEl.disabled = false;
}

// ============================================================
// AI EXAM GENERATOR
// ============================================================
let aiGeneratedQuestions = [];
let aiSelectedFiles = [];
const AI_MAX_FILE_SIZE = 100 * 1024 * 1024;
const AI_ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
];
const AI_ALLOWED_FILE_EXTENSIONS = /\.(pdf|docx|pptx|txt)$/i;

function _aiSD(id, v) { var el = document.getElementById(id); if (el) el.style.display = v; }

function openAIGen() {
  if (!currentQBuilderExamId) {
    saveExamFromEditor();
    if (!currentQBuilderExamId) return;
  }
  const apiKey = DB.getSettings().claudeApiKey;
  if (!apiKey) {
    showToast('Groq API key not set. Go to Settings → Groq AI Integration.', 'error');
    return;
  }
  clearAIFile();
  const customPromptEl = document.getElementById('ai-custom-prompt');
  if (customPromptEl) { customPromptEl.value = ''; customPromptEl.style.height = 'auto'; }
  _aiSD('ai-status', 'none'); _aiSD('ai-preview', 'none'); _aiSD('ai-user-bubble', 'none');
  _aiSD('ai-gen-btn', 'flex'); _aiSD('ai-import-btn', 'none');
  const aiBackdrop = document.getElementById('modal-ai-gen');
  const aiBox = document.getElementById('ai-gen-modal-box');
  if (aiBox) {
    aiBox.style.width = '100%'; aiBox.style.maxWidth = '100%';
    aiBox.style.height = '100%'; aiBox.style.borderRadius = '16px';
    aiBox.dataset.fullscreen = '0';
  }
  if (aiBackdrop) aiBackdrop.classList.remove('hidden');
  scrollAIChat();
  requestAnimationFrame(() => document.getElementById('ai-custom-prompt')?.focus());
}

function closeAIGen() {
  const box = document.getElementById('ai-gen-modal-box');
  if (box) { box.style.maxWidth = ''; box.style.height = ''; box.style.borderRadius = ''; box.style.width = ''; box.dataset.fullscreen = '0'; }
  const backdrop = document.getElementById('modal-ai-gen');
  if (backdrop) { backdrop.style.padding = ''; }
  const icon = document.getElementById('ai-gen-expand-icon');
  if (icon) icon.innerHTML = '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>';
  document.getElementById('modal-ai-gen').classList.add('hidden');
}

function toggleAIGenFullscreen() {
  const box = document.getElementById('ai-gen-modal-box');
  const icon = document.getElementById('ai-gen-expand-icon');
  if (!box) return;
  const isFs = box.dataset.fullscreen === '1';
  if (isFs) {
    box.style.maxWidth = '100%';
    box.style.height = '100%';
    box.style.borderRadius = '16px';
    box.style.width = '100%';
    box.dataset.fullscreen = '0';
    const backdrop = document.getElementById('modal-ai-gen');
    if (backdrop) { backdrop.style.left = 'var(--sidebar-current-width, 260px)'; backdrop.style.padding = '12px'; }
    if (icon) icon.innerHTML = '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>';
  } else {
    box.style.maxWidth = '100%';
    box.style.height = '100%';
    box.style.borderRadius = '0';
    box.style.width = '100%';
    box.dataset.fullscreen = '1';
    const backdrop = document.getElementById('modal-ai-gen');
    if (backdrop) { backdrop.style.left = '0'; backdrop.style.padding = '0'; }
    if (icon) icon.innerHTML = '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>';
  }
}

function scrollAIChat() {
  const body = document.getElementById('ai-chat-body');
  if (body) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

function handleAIFileSelect(files) {
  setAIFiles(files);
}

function handleAIFileDrop(files) {
  setAIFiles(files);
}

function normalizeAIFiles(files) {
  if (!files) return [];
  return Array.from(files).filter(Boolean);
}

function dedupeAIFiles(files) {
  const seen = new Set();
  return files.filter(file => {
    const key = [file.name, file.size, file.lastModified].join('::');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatAIFileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function getAIFileSummary(files) {
  if (!files.length) return '';
  if (files.length === 1) return `${files[0].name} (${formatAIFileSize(files[0].size)})`;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const previewNames = files.slice(0, 2).map(file => file.name).join(', ');
  const extraCount = files.length - 2;
  const extraLabel = extraCount > 0 ? `, +${extraCount} more` : '';
  return `${files.length} files (${formatAIFileSize(totalBytes)} total): ${previewNames}${extraLabel}`;
}

function setAIFiles(files) {
  const incomingFiles = normalizeAIFiles(files);
  if (!incomingFiles.length) return;

  const acceptedFiles = [];
  let validationError = '';

  incomingFiles.forEach(file => {
    const extOk = AI_ALLOWED_FILE_EXTENSIONS.test(file.name);
    if (!AI_ALLOWED_FILE_TYPES.includes(file.type) && !extOk) {
      validationError = validationError || `Unsupported file type: ${file.name}. Use PDF, DOCX, PPTX, or TXT.`;
      return;
    }
    if (file.size > AI_MAX_FILE_SIZE) {
      validationError = validationError || `File too large: ${file.name}. Max 100MB per file.`;
      return;
    }
    acceptedFiles.push(file);
  });

  const input = document.getElementById('ai-file-input');
  if (!acceptedFiles.length) {
    showToast(validationError || 'Please attach at least one valid file.', 'error');
    if (input) input.value = '';
    return;
  }

  aiSelectedFiles = dedupeAIFiles([...aiSelectedFiles, ...acceptedFiles]);
  const fileInfo = document.getElementById('ai-file-info');
  if (fileInfo) fileInfo.style.display = 'flex';
  document.getElementById('ai-file-name').textContent = getAIFileSummary(aiSelectedFiles);
  if (input) input.value = '';
  if (validationError) showToast(validationError, 'error');
  scrollAIChat();
}

function clearAIFile() {
  aiSelectedFiles = [];
  const fileInfo = document.getElementById('ai-file-info');
  const attachBtn = document.getElementById('ai-attach-btn');
  if (fileInfo) fileInfo.style.display = 'none';
  if (attachBtn) attachBtn.style.display = '';
  document.getElementById('ai-file-input').value = '';
}

function normalizeAIQuestionCount(value) {
  return Math.min(100, Math.max(1, parseInt(value, 10) || 1));
}

async function extractTextFromFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.txt')) return extractTextTXT(file);
  if (name.endsWith('.pdf')) return extractTextPDF(file);
  if (name.endsWith('.docx')) return extractTextDOCX(file);
  if (name.endsWith('.pptx')) return extractTextPPTX(file);
  throw new Error('Unsupported file format.');
}

function extractTextTXT(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

async function extractTextPDF(file) {
  if (!window.pdfjsLib) throw new Error('PDF.js not loaded.');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text;
}

async function extractTextDOCX(file) {
  if (!window.mammoth) throw new Error('mammoth.js not loaded.');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractTextPPTX(file) {
  if (!window.JSZip) throw new Error('JSZip not loaded.');
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  let text = '';
  const slideFiles = Object.keys(zip.files).filter(n => /ppt\/slides\/slide\d+\.xml/.test(n)).sort();
  for (const name of slideFiles) {
    const xml = await zip.files[name].async('string');
    const matches = xml.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || [];
    text += matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ') + '\n';
  }
  return text;
}

async function extractTextFromFiles(files, onProgress) {
  const sections = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (typeof onProgress === 'function') onProgress({ index: i + 1, total: files.length, file });
    const text = await extractTextFromFile(file);
    sections.push(`=== ${file.name} ===\n${text}`);
  }
  return sections.join('\n\n');
}

async function runAIGenerate() {
  if (!aiSelectedFiles.length) { showToast('Please attach at least one file first using the paperclip button.', 'error'); return; }

  const apiKey = DB.getSettings().claudeApiKey;
  const mode = document.getElementById('ai-mode')?.value || 'quick';
  const count = normalizeAIQuestionCount(document.getElementById('ai-count')?.value);
  const selectedTypes = [...document.querySelectorAll('.ai-type-cb:checked')].map(cb => cb.value);
  const difficulty = document.getElementById('ai-difficulty')?.value || 'mixed';
  const customPrompt = (document.getElementById('ai-custom-prompt')?.value || '').trim();

  if (mode === 'custom' && !customPrompt) {
    showToast('In Custom mode, describe your questions in the message field.', 'error');
    return;
  }

  // Promote pending file chip → user chat bubble
  const pendingName = getAIFileSummary(aiSelectedFiles);
  const userBubble = document.getElementById('ai-user-bubble');
  if (userBubble && pendingName) {
    const nameEl = document.getElementById('ai-user-bubble-file');
    const promptEl = document.getElementById('ai-user-bubble-prompt');
    const promptTextEl = document.getElementById('ai-user-bubble-prompt-text');
    if (nameEl) nameEl.textContent = pendingName;
    if (promptTextEl) promptTextEl.textContent = customPrompt;
    if (promptEl) promptEl.style.display = customPrompt ? 'flex' : 'none';
    userBubble.style.display = 'block';
  }
  _aiSD('ai-file-info', 'none'); _aiSD('ai-gen-btn', 'none');
  _aiSD('ai-preview', 'none'); _aiSD('ai-status', 'flex');
  const stEl = document.getElementById('ai-status-text'); if (stEl) stEl.textContent = 'Extracting learning materials...';
  scrollAIChat();

  let rawText;
  try {
    rawText = await extractTextFromFiles(aiSelectedFiles, ({ index, total, file }) => {
      if (stEl) stEl.textContent = `Extracting file ${index} of ${total}: ${file.name}`;
    });
  } catch (err) {
    _aiSD('ai-status', 'none'); _aiSD('ai-gen-btn', 'flex');
    showToast('Failed to read learning materials: ' + err.message, 'error');
    return;
  }

  // Trim to ~12000 chars to fit context
  if (rawText.length > 12000) rawText = rawText.slice(0, 12000) + '\n[content truncated]';

  const schemaRules = `Return ONLY a valid JSON array with no other text, explanation, or markdown.
Each question object schema:
  { "type": "mcq"|"checkbox"|"tf"|"identification"|"enumeration"|"matching"|"essay"|"coding", "content": "...", "options": [...], "correctAnswer": "...", "answers": [...], "pairs": [...], "points": 1 }
- For "mcq": options = array of 4 strings; correctAnswer must match one option exactly.
- For "checkbox": options = array of 4-6 strings; correctAnswerIndices = array of 0-based indices of correct options; points = 2.
- For "tf": options = ["True","False"]; correctAnswer = "True" or "False".
- For "identification": options = []; correctAnswer = expected answer string (1-4 words).
- For "enumeration": options = []; answers = array of expected answer strings (3-6 items); correctAnswer = ""; partialScoring = true; points = 5.
- For "matching": options = []; pairs = array of {term, match} objects (4-6 pairs); correctAnswer = ""; partialScoring = true; points = 5.
- For "essay": options = []; correctAnswer = ""; rubric = grading guidance string; minWords = 0; points = 10.
- For "coding": options = []; correctAnswer = ""; language = "python"|"javascript"|"java"|"cpp"|"c"; starterCode = starter code string; expectedOutput = expected output string; rubric = grading notes; points = 20.`;

  let prompt;
  if (mode === 'custom') {
    prompt = `Professor's instructions: ${customPrompt}

Rules:
- ${schemaRules}

Course materials:
${rawText}`;
  } else {
    const typeList = selectedTypes.length > 0 ? selectedTypes : ['mcq', 'tf', 'identification'];
    const hasCoding = typeList.includes('coding');
    const nonCodingTypes = typeList.filter(t => t !== 'coding');

    let typeInstruction;
    if (typeList.length === 1 && hasCoding) {
      typeInstruction = `All ${count} questions MUST be "coding" type. Every question must be a programming/coding challenge.`;
    } else if (hasCoding) {
      const codingCount = Math.max(1, Math.round(count * (1 / typeList.length)));
      typeInstruction = `Use a mix of these types: ${typeList.join(', ')}. IMPORTANT: You MUST include exactly ${codingCount} "coding" type question${codingCount > 1 ? 's' : ''} — do not skip the coding type.`;
    } else if (typeList.length === 1) {
      typeInstruction = `Use only "${typeList[0]}" type.`;
    } else {
      typeInstruction = `Use a mix of these types: ${typeList.join(', ')}.`;
    }
    const customInstruction = customPrompt ? `\nAdditional topic/instructions: ${customPrompt}` : '';

    prompt = `Generate exactly ${count} exam questions based on the course materials below.

Rules:
- Return exactly ${count} question objects in the JSON array. Do not return more or fewer.
- ${typeInstruction}
- Difficulty: ${difficulty}${customInstruction}
- ${schemaRules}

Course materials:
${rawText}`;
  }

  if (stEl) stEl.textContent = 'Generating questions with AI…';

  let questions;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 8000,
        messages: [
          { role: 'system', content: 'You are an educational exam question generator. Your sole purpose is to generate exam questions from provided course material. You must only produce exam questions — never answer unrelated questions, generate non-academic content, or deviate from the JSON schema. Always return a valid JSON array with no extra text.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || 'API error ' + response.status);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    // Extract JSON array from response
    const jsonMatch = raw.match(/\[[\s\S]*/);
    if (!jsonMatch) throw new Error('AI did not return a valid JSON array.');

    let jsonStr = jsonMatch[0];
    // If response was truncated, repair by closing at the last complete object
    try {
      questions = JSON.parse(jsonStr);
    } catch (_) {
      // Find last complete question object and close the array
      const lastBrace = jsonStr.lastIndexOf('}');
      if (lastBrace !== -1) {
        jsonStr = jsonStr.slice(0, lastBrace + 1) + ']';
        questions = JSON.parse(jsonStr);
      } else {
        throw new Error('AI response could not be parsed. Try fewer questions.');
      }
    }
    if (!Array.isArray(questions) || questions.length === 0) throw new Error('No questions generated.');
  } catch (err) {
    _aiSD('ai-status', 'none'); _aiSD('ai-gen-btn', 'flex');
    showToast('AI generation failed: ' + err.message, 'error');
    return;
  }

  // Sort: MCQ → True/False → Identification
  const typeOrder = { mcq: 0, tf: 1, identification: 2 };
  questions.sort((a, b) => (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3));

  if (mode === 'quick' && questions.length > count) {
    questions = questions.slice(0, count);
  }

  aiGeneratedQuestions = questions;
  _aiSD('ai-status', 'none');
  renderAIPreview(questions);
}

function renderAIPreview(questions) {
  const typeLabel = { mcq: 'Multiple Choice', tf: 'True / False', identification: 'Identification', enumeration: 'Enumeration', matching: 'Matching', essay: 'Essay', coding: 'Coding', checkbox: 'Checkboxes' };
  const sectionColors = { mcq: '#0f2d1a', tf: '#0f2d1a', identification: '#0f2d1a', enumeration: '#0f2d1a', matching: '#0f2d1a', essay: '#0f2d1a', coding: '#0f2d1a', checkbox: '#0f2d1a' };
  const previewTitle = document.getElementById('ai-preview-title');
  if (previewTitle) previewTitle.textContent = `${questions.length} questions generated — select which to import`;
  const selectAll = document.getElementById('ai-select-all');
  if (selectAll) selectAll.checked = true;

  let html = '';
  let lastType = null;
  let groupNum = { mcq: 0, tf: 0, identification: 0 };

  questions.forEach((q, i) => {
    if (q.type !== lastType) {
      const count = questions.filter(x => x.type === q.type).length;
      html += `<div style="display:flex;align-items:center;gap:10px;margin:${lastType ? '14px' : '4px'} 0 6px;">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:${sectionColors[q.type] || '#6b7280'};letter-spacing:0.05em;">${typeLabel[q.type] || q.type}</span>
        <span style="font-size:11px;color:#9ca3af;">(${count})</span>
        <div style="flex:1;height:1px;background:#e5e7eb;"></div>
      </div>`;
      lastType = q.type;
    }
    groupNum[q.type] = (groupNum[q.type] || 0) + 1;
    html += `
    <div class="ai-q-card">
      <label style="align-items:flex-start;">
        <div class="checkbox-wrapper-30" style="flex-shrink:0;margin-top:1px;">
          <div class="checkbox" style="--size:0.9;--stroke:#1a6b35;">
            <input type="checkbox" class="ai-q-check" data-idx="${i}" checked />
            <svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="3" class="cb-border"/><polyline points="20,6 9,17 4,12" class="cb-check"/></svg>
          </div>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:500;margin-bottom:4px;">${groupNum[q.type]}. ${escHtml(q.content)}</div>
          ${q.type === 'mcq' ? `<div style="font-size:12px;color:#6b7280;margin-bottom:3px;">${q.options.map((o, oi) => `<span style="margin-right:12px;">${String.fromCharCode(65+oi)}. ${escHtml(o)}</span>`).join('')}</div>` : ''}
          <div class="ai-q-correct">✓ ${escHtml(q.correctAnswer)}</div>
        </div>
      </label>
    </div>`;
  });

  const qPreview = document.getElementById('ai-questions-preview');
  if (qPreview) qPreview.innerHTML = html;
  _aiSD('ai-preview', 'flex'); _aiSD('ai-gen-btn', 'none');
  _aiSD('ai-import-btn', 'inline-flex'); _aiSD('ai-status', 'none');
  scrollAIChat();
}

function toggleAllAIQuestions(checked) {
  document.querySelectorAll('.ai-q-check').forEach(cb => cb.checked = checked);
}

function importAIQuestions() {
  const selected = [...document.querySelectorAll('.ai-q-check:checked')].map(cb => parseInt(cb.dataset.idx));
  if (selected.length === 0) { showToast('Select at least one question.', 'error'); return; }

  const exam = DB.getExam(currentQBuilderExamId);
  if (!exam) return;

  const newQuestions = selected.map(i => {
    const q = aiGeneratedQuestions[i];
    return {
      id: DB.generateId(),
      type: q.type,
      content: q.content || '',
      options: Array.isArray(q.options) ? q.options : [],
      correctAnswer: q.correctAnswer || '',
      // Checkbox type
      correctAnswerIndices: Array.isArray(q.correctAnswerIndices) ? q.correctAnswerIndices : undefined,
      // Matching type
      pairs: Array.isArray(q.pairs) ? q.pairs : undefined,
      partialScoring: q.partialScoring !== false,
      // Enumeration type
      answers: Array.isArray(q.answers) ? q.answers : undefined,
      // Essay type
      rubric: q.rubric || '',
      minWords: q.minWords || 0,
      points: q.points || 1,
      imageUrl: '',
      required: true,
    };
  });

  DB.updateExam(currentQBuilderExamId, { questions: [...exam.questions, ...newQuestions] });
  closeAIGen();
  renderQuestionsList(currentQBuilderExamId);
  updateQBadge(currentQBuilderExamId);
  showToast(`${newQuestions.length} question(s) imported successfully.`, 'success');
}
