import React, { useState, useEffect, useRef, useCallback } from "react";
import ThemeToggle from "../components/ThemeToggle.jsx";
import { applyTheme, readStoredTheme, toggleTheme } from "../lib/theme.js";

const SUPERADMIN_SECTIONS = new Set(["dashboard", "professors", "settings"]);

function readSuperAdminSectionFromUrl() {
  if (typeof window === "undefined") return "dashboard";
  const section = new URLSearchParams(window.location.search).get("section");
  return SUPERADMIN_SECTIONS.has(section) ? section : "dashboard";
}

function writeSuperAdminSectionToUrl(section) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!section || section === "dashboard") {
    url.searchParams.delete("section");
  } else {
    url.searchParams.set("section", section);
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

// ── tiny helpers ────────────────────────────────────────────────
function EyeToggle({ show, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      tabIndex={-1}
      style={{
        position: "absolute",
        right: "8px",
        top: "50%",
        transform: "translateY(-50%)",
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: 0,
        color: "#666",
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {show ? (
          <>
            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </>
        ) : (
          <>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
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
  const icons = {
    success: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
    error: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    ),
    warning: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
    info: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    ),
  };
  return (
    <div className={`sa-toast sa-toast-${type}`}>
      <span className="sa-toast-icon">{icons[type] || icons.info}</span>
      <span className="sa-toast-message">{message}</span>
    </div>
  );
}

// ── nav icons ───────────────────────────────────────────────────
const ICONS = {
  dashboard: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  ),
  professors: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  settings: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  signout: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
};

// ── stat card ───────────────────────────────────────────────────
function StatCard({ label, value, icon, color }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${color}`}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          dangerouslySetInnerHTML={{ __html: icon }}
        />
      </div>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

// ── confirm dialog ──────────────────────────────────────────────
function ConfirmDialog({
  title = "Confirm Action",
  message,
  confirmLabel = "Confirm",
  confirmClassName = "btn btn-danger",
  icon = "warning",
  onConfirm,
  onCancel,
}) {
  const iconStroke =
    icon === "signout" ? "#0f5132" : icon === "danger" ? "#dc2626" : "#d97706";
  const iconBg =
    icon === "signout" ? "#e8f5ec" : icon === "danger" ? "#fee2e2" : "#fef3c7";
  return (
    <div className="sa-modal-overlay">
      <div className="sa-modal sa-modal-sm">
        <div className="sa-confirm-icon" style={{ background: iconBg }}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke={iconStroke}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {icon === "signout" ? (
              <>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </>
            ) : icon === "danger" ? (
              <>
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </>
            ) : (
              <>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </>
            )}
          </svg>
        </div>
        <div className="sa-confirm-title">{title}</div>
        <div className="sa-confirm-message">{message}</div>
        <div className="sa-modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className={confirmClassName} onClick={onConfirm}>
            {confirmLabel}
          </button>
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
  const [error, setError] = useState("");
  const [showPass, setShowPass] = useState(false);
  const isEdit = !!professor;

  const handleSave = async () => {
    const name = (nameRef.current?.value || "").trim();
    const username = (usernameRef.current?.value || "").trim().toLowerCase();
    const email = (emailRef.current?.value || "").trim().toLowerCase();
    const password = passRef.current?.value || "";

    setError("");
    if (!name) {
      setError("Full name is required.");
      return;
    }
    if (!username) {
      setError("Username is required.");
      return;
    }
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) {
      setError("Username must be 3–30 characters (letters, numbers, _ . -).");
      return;
    }
    if (!isEdit && !password) {
      setError("Password is required.");
      return;
    }
    if (password && password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    const data = { name, username, email };
    if (password) data.password = password;
    const result = await onSave(data);
    if (result?.success === false) {
      setError(result.message || "Unable to save professor.");
    }
  };

  return (
    <div className="sa-modal-overlay">
      <div className="sa-modal sa-modal-md">
        <div className="sa-modal-header">
          <span
            style={{
              fontWeight: 700,
              fontSize: "16px",
              color: "var(--primary)",
            }}
          >
            {isEdit ? "Edit Professor" : "Add Professor"}
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "20px",
              color: "#9ca3af",
              lineHeight: 1,
            }}
          >
            &#10005;
          </button>
        </div>
        <div className="sa-modal-body">
          <div className="form-group">
            <label>Full Name *</label>
            <input
              ref={nameRef}
              type="text"
              className="form-control"
              placeholder="e.g. Dr. Maria Santos"
              defaultValue={professor?.name || ""}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Username *</label>
            <input
              ref={usernameRef}
              type="text"
              className="form-control"
              placeholder="e.g. msantos"
              defaultValue={professor?.username || ""}
            />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input
              ref={emailRef}
              type="email"
              className="form-control"
              placeholder="professor@plpasig.edu.ph"
              defaultValue={professor?.email || ""}
            />
          </div>
          <div className="form-group">
            <label>
              {isEdit ? "New Password" : "Password *"}{" "}
              {isEdit && (
                <span style={{ fontWeight: 400, color: "#9ca3af" }}>
                  (leave blank to keep current)
                </span>
              )}
            </label>
            <div style={{ position: "relative" }}>
              <input
                ref={passRef}
                type={showPass ? "text" : "password"}
                className="form-control"
                placeholder="Minimum 6 characters"
                style={{ paddingRight: "42px" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                }}
              />
              <EyeToggle
                show={showPass}
                onToggle={() => setShowPass((v) => !v)}
              />
            </div>
          </div>
          {error && (
            <div className="text-danger mb-12" style={{ fontSize: "13px" }}>
              {error}
            </div>
          )}
        </div>
        <div className="sa-modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            {isEdit ? "Save Changes" : "Add Professor"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── main page ───────────────────────────────────────────────────
export default function SuperAdminPage() {
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState(() => readStoredTheme());
  const [section, setSection] = useState(() => readSuperAdminSectionFromUrl());
  const [professors, setProfessors] = useState([]);
  const [professorSearch, setProfessorSearch] = useState("");
  const [stats, setStats] = useState({
    professors: 0,
    students: 0,
    exams: 0,
    subjects: 0,
  });
  const [systemSettings, setSystemSettings] = useState({
    schoolName: "",
    logoUrl: "",
  });
  const [adminProfile, setAdminProfile] = useState({
    name: "",
    username: "",
    email: "",
    department: "",
  });
  const [toast, setToast] = useState(null);
  const [confirm, setConfirm] = useState(null); // { message, onConfirm }
  const [profModal, setProfModal] = useState(null); // null | { professor?: obj }
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // settings tab
  const curPassRef = useRef();
  const newPassRef = useRef();
  const confirmPassRef = useRef();
  const [settingsError, setSettingsError] = useState("");
  const [settingsSuccess, setSettingsSuccess] = useState("");
  const [showCurPass, setShowCurPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);

  const readyRef = useRef(false);
  const sessionRef = useRef(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const showToast = useCallback((message, type = "success") => {
    setToast({ message, type, key: Date.now() });
  }, []);

  const handleThemeToggle = () => {
    setTheme(toggleTheme());
  };

  const loadData = useCallback(() => {
    const profs = window.DB?.getAdmins?.() || [];
    const students = window.DB?.getStudents?.() || [];
    const exams = window.DB?.getExams?.() || [];
    const subjects = window.DB?.getSubjects?.() || [];
    const settings = window.DB?.getSettings?.() || {};
    const sysAdmin = window.DB?.getSysAdmin?.() || {};
    setProfessors(profs);
    setStats({
      professors: profs.length,
      students: students.length,
      exams: exams.length,
      subjects: subjects.length,
    });
    setSystemSettings({
      schoolName: settings.schoolName || "TUKLAS",
      logoUrl: settings.logoUrl || "",
    });
    setAdminProfile({
      name: sysAdmin.name || "System Administrator",
      username: sysAdmin.username || "sysadmin",
      email: sysAdmin.email || "",
      department: sysAdmin.department || "",
    });
  }, []);

  useEffect(() => {
    const boot = () => {
      if (readyRef.current) return;
      readyRef.current = true;

      const session = window.Auth?.getSysAdminSession?.();
      if (!session) {
        window.location.replace("index.html");
        return;
      }
      sessionRef.current = session;

      setReady(true);
      loadData();

      document
        .getElementById("fb-loading")
        ?.setAttribute("style", "display:none");
    };

    document.addEventListener("dbReady", boot);
    window.SupabaseSync?.init?.();

    return () => document.removeEventListener("dbReady", boot);
  }, [loadData]);

  useEffect(() => {
    writeSuperAdminSectionToUrl(section);
  }, [section]);

  const doLogout = async () => {
    setConfirm({
      title: "Sign Out",
      message:
        "Sign out of your system admin panel? You will need to log in again to continue.",
      confirmLabel: "Sign Out",
      confirmClassName: "btn btn-primary",
      icon: "signout",
      onConfirm: () => {
        setConfirm(null);
        window.Auth?.clearSysAdminSession?.();
        window.location.replace("index.html");
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

  const saveProfessor = async (data) => {
    const existing = profModal?.professor;
    const normalizedEmail = (data.email || "").trim().toLowerCase();
    const duplicateEmail = normalizedEmail
      ? professors.find(
          (prof) =>
            (prof.email || "").trim().toLowerCase() === normalizedEmail &&
            prof.id !== existing?.id,
        )
      : null;
    if (duplicateEmail) {
      const message =
        "That email is already assigned to another professor. Duplicate emails are not allowed.";
      showToast(message, "error");
      return { success: false, message };
    }

    const duplicateUsername = professors.find(
      (prof) =>
        (prof.username || "").trim().toLowerCase() === data.username &&
        prof.id !== existing?.id,
    );
    if (duplicateUsername) {
      const message = "Username already exists.";
      showToast(message, "error");
      return { success: false, message };
    }

    const result = await window.Auth.saveProfessorAccount(existing?.id, data);
    if (!result?.success) {
      showToast(result?.message || "Unable to save professor.", "error");
      return { success: false, message: result?.message || "Unable to save professor." };
    }

    await window.Auth.refreshAdminsFromSupabase?.();
    showToast(existing ? "Professor updated successfully." : "Professor added successfully.");
    setProfModal(null);
    loadData();
    return { success: true };
  };

  const filteredProfessors = professors.filter((prof) => {
    const query = professorSearch.trim().toLowerCase();
    if (!query) return true;
    return [prof.name, prof.username, prof.email]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(query));
  });

  const confirmDeleteProfessor = (prof) => {
    setConfirm({
      title: "Delete Professor?",
      message: `Delete professor "${prof.name}" (@${prof.username})? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmClassName: "btn btn-danger",
      icon: "danger",
      onConfirm: () => {
        window.DB.deleteProfessor(prof.id);
        setConfirm(null);
        showToast("Professor deleted.");
        loadData();
      },
    });
  };

  const saveSystemSettings = () => {
    const schoolName = (systemSettings.schoolName || "").trim();
    if (!schoolName) {
      showToast("School / System name is required.", "error");
      return;
    }
    const next = { schoolName, logoUrl: systemSettings.logoUrl || "" };
    window.DB?.updateSettings?.(next);
    setSystemSettings(next);
    showToast("School / System settings saved.");
  };

  const saveAdminProfile = () => {
    const name = (adminProfile.name || "").trim();
    const username = (adminProfile.username || "").trim().toLowerCase();
    const email = (adminProfile.email || "").trim().toLowerCase();
    const department = (adminProfile.department || "").trim();

    if (!name) {
      showToast("Administrator name is required.", "error");
      return;
    }
    if (!username) {
      showToast("Administrator username is required.", "error");
      return;
    }
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) {
      showToast("Username must be 3-30 characters.", "error");
      return;
    }

    const updated = window.DB?.updateSysAdmin?.({
      name,
      username,
      email,
      department,
    });
    sessionRef.current = {
      ...(sessionRef.current || {}),
      name,
      username,
      email,
      department,
    };
    sessionStorage.setItem(
      "acs_sysadmin_session",
      JSON.stringify({
        ...(sessionRef.current || {}),
        loginAt: sessionRef.current?.loginAt || new Date().toISOString(),
      }),
    );
    setAdminProfile({
      name: updated?.name || name,
      username: updated?.username || username,
      email: updated?.email || email,
      department: updated?.department || department,
    });
    showToast("Administrator account information saved.");
  };

  const handleSystemLogoUpload = (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast("Logo must be less than 5MB.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      setSystemSettings((prev) => ({
        ...prev,
        logoUrl: e.target?.result || "",
      }));
    };
    reader.readAsDataURL(file);
  };

  const removeSystemLogo = () => {
    const schoolName =
      (systemSettings.schoolName || "").trim() || "TUKLAS";
    const next = { ...systemSettings, schoolName, logoUrl: "" };
    setSystemSettings(next);
    window.DB?.updateSettings?.(next);
    showToast("Logo removed successfully.");
  };

  // ── Change password ─────────────────────────────────────────
  const changePassword = async () => {
    const cur = curPassRef.current?.value || "";
    const next = newPassRef.current?.value || "";
    const confirm = confirmPassRef.current?.value || "";
    setSettingsError("");
    setSettingsSuccess("");

    if (next.length < 6) {
      setSettingsError("New password must be at least 6 characters.");
      return;
    }
    if (next !== confirm) {
      setSettingsError("Passwords do not match.");
      return;
    }
    const result = await window.Auth.changeSysAdminPassword(cur, next);
    if (!result?.success) {
      setSettingsError(result?.message || "Unable to update the password right now.");
      return;
    }
    if (curPassRef.current) curPassRef.current.value = "";
    if (newPassRef.current) newPassRef.current.value = "";
    if (confirmPassRef.current) confirmPassRef.current.value = "";
    setSettingsSuccess("Password updated successfully.");
  };

  // ── date/time ───────────────────────────────────────────────
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);
  const dateStr = now.toLocaleDateString("en-PH", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const session = sessionRef.current;
  const hasCustomLogo = !!String(systemSettings.logoUrl || "").trim();
  const brandLogo = hasCustomLogo ? systemSettings.logoUrl : "";
  const brandName = systemSettings.schoolName || "TUKLAS";
  const brandInitial = (brandName || "P").trim().charAt(0).toUpperCase() || "P";
  const adminDepartment = adminProfile.department || session?.department || "";

  // ── render ──────────────────────────────────────────────────
  return (
    <>
      <style>{`@keyframes _fbspin{to{transform:rotate(360deg)}}`}</style>

      {/* Loading overlay */}
      <div
        id="fb-loading"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(255,255,255,0.97)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 99999,
          gap: "14px",
        }}
      >
        <div
          className="theme-loading-spinner"
          style={{
            width: "36px",
            height: "36px",
            border: "3px solid #e5e7eb",
            borderTopColor: "#1a4d2a",
            borderRadius: "50%",
            animation: "_fbspin 0.75s linear infinite",
          }}
        />
        <p
          className="theme-loading-text"
          style={{
            color: "#6b7280",
            fontSize: "13px",
            fontFamily: "sans-serif",
            margin: 0,
          }}
        >
          Loading your workspace&hellip;
        </p>
      </div>

      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          type={toast.type}
          onDone={() => setToast(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          confirmClassName={confirm.confirmClassName}
          icon={confirm.icon}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
      {profModal && (
        <ProfessorModal
          professor={profModal.professor}
          onSave={saveProfessor}
          onClose={() => setProfModal(null)}
        />
      )}

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 998,
          }}
        />
      )}

      {ready && (
        <div className="admin-layout super-admin-shell">
          {/* SIDEBAR */}
          <aside
            className="sidebar"
            id="sidebar"
            style={
              sidebarOpen ? { transform: "translateX(0)", zIndex: 999 } : {}
            }
          >
            <div className="sidebar-brand">
              <div className="sidebar-brand-icon">
                {brandLogo ? (
                  <img
                    src={brandLogo}
                    alt="PLP"
                    style={{
                      width: "40px",
                      height: "40px",
                      objectFit: "contain",
                    }}
                  />
                ) : (
                  <div className="sa-brand-logo-fallback">{brandInitial}</div>
                )}
              </div>
              <div className="sidebar-brand-text">
                <h2>{brandName}</h2>
                <p>System Admin</p>
              </div>
            </div>

            <nav className="sidebar-nav">
              <div className="nav-section-label">Overview</div>
              <div
                className={`nav-item${section === "dashboard" ? " active" : ""}`}
                onClick={() => navTo("dashboard")}
              >
                <span className="nav-icon">{ICONS.dashboard}</span>
                <span className="nav-item-label">Dashboard</span>
              </div>
              <div className="nav-section-label">Management</div>
              <div
                className={`nav-item${section === "professors" ? " active" : ""}`}
                onClick={() => navTo("professors")}
              >
                <span className="nav-icon">{ICONS.professors}</span>
                <span className="nav-item-label">Professors</span>
              </div>
              <div className="nav-section-label">System</div>
              <div
                className={`nav-item${section === "settings" ? " active" : ""}`}
                onClick={() => navTo("settings")}
              >
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
            <header className="topbar sa-topbar">
              <div className="sa-topbar-main">
                <button
                  className="hamburger-btn"
                  onClick={() => setSidebarOpen((v) => !v)}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </svg>
                </button>
                <span className="topbar-title">
                  {section === "dashboard" && "Dashboard"}
                  {section === "professors" && "Professors"}
                  {section === "settings" && "Settings"}
                </span>
              </div>
              <div className="topbar-actions sa-topbar-actions">
                <span className="topbar-date sa-topbar-date">{dateStr}</span>
                <ThemeToggle
                  checked={theme === "dark"}
                  onChange={handleThemeToggle}
                  title="Toggle dark mode"
                />
                <button type="button" className="sa-user-pill" onClick={() => navTo("settings")}>
                  <div className="sa-user-avatar">
                    {(session?.name || "A").charAt(0).toUpperCase()}
                  </div>
                  <span className="sa-user-name">
                    {session?.name || "System Admin"}
                  </span>
                </button>
              </div>
            </header>

            <div className="content-area">
              {/* ── DASHBOARD ── */}
              {section === "dashboard" && (
                <div>
                  <div className="section-header">
                    <div>
                      <div className="section-title">Dashboard</div>
                      {adminDepartment && (
                        <div
                          className="section-subtitle"
                          style={{
                            marginTop: "6px",
                            fontSize: "22px",
                            fontWeight: 800,
                            color: "var(--primary)",
                            letterSpacing: "-0.03em",
                            lineHeight: 1.15,
                          }}
                        >
                          {adminDepartment}
                        </div>
                      )}
                      <div className="section-subtitle">System overview</div>
                    </div>
                  </div>

                  <div className="sa-stats-grid">
                    {[
                      {
                        label: "Professors",
                        value: stats.professors,
                        color: "green",
                        icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
                      },
                      {
                        label: "Students",
                        value: stats.students,
                        color: "blue",
                        icon: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
                      },
                      {
                        label: "Exams",
                        value: stats.exams,
                        color: "orange",
                        icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
                      },
                      {
                        label: "Courses",
                        value: stats.subjects,
                        color: "purple",
                        icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
                      },
                    ].map(({ label, value, icon, color }) => (
                      <StatCard
                        key={label}
                        label={label}
                        value={value}
                        icon={icon}
                        color={color}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* ── PROFESSORS ── */}
              {section === "professors" && (
                <div>
                  <div className="section-header">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        <div className="section-title">Professors</div>
                        <div className="section-subtitle">
                          Manage professor accounts for the exam management panel
                        </div>
                      </div>
                      <div
                        className="search-input"
                        style={{ marginTop: "14px", maxWidth: "360px" }}
                      >
                        <span className="search-icon">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                          </svg>
                        </span>
                        <input
                          type="text"
                          placeholder="Search professors"
                          value={professorSearch}
                          onChange={(e) => setProfessorSearch(e.target.value)}
                        />
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      onClick={openAddProfessor}
                    >
                      + Add Professor
                    </button>
                  </div>

                  <div className="card">
                    <div className="card-body" style={{ padding: 0 }}>
                      {professors.length === 0 ? (
                        <div className="dash-empty" style={{ padding: "48px" }}>
                          <div className="dash-empty-title">
                            No professors yet
                          </div>
                          <div className="dash-empty-sub">
                            Create professor accounts so they can log in and
                            manage exams.
                          </div>
                        </div>
                      ) : filteredProfessors.length === 0 ? (
                        <div className="dash-empty" style={{ padding: "48px" }}>
                          <div className="dash-empty-title">
                            No matching professors
                          </div>
                          <div className="dash-empty-sub">
                            Try a different name, username, or email.
                          </div>
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
                                <th style={{ textAlign: "center" }}>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredProfessors.map((p) => (
                                <tr key={p.id}>
                                  <td data-label="Name">
                                    <div className="sa-person-cell">
                                      <div className="sa-person-avatar">
                                        {(p.name || "?")
                                          .charAt(0)
                                          .toUpperCase()}
                                      </div>
                                      <span style={{ fontWeight: 600 }}>
                                        {p.name}
                                      </span>
                                    </div>
                                  </td>
                                  <td data-label="Username">
                                    <span className="sa-mono-chip">
                                      @{p.username}
                                    </span>
                                  </td>
                                  <td
                                    data-label="Email"
                                    style={{
                                      color: "var(--text-muted)",
                                      fontSize: "13px",
                                    }}
                                  >
                                    {p.email || "—"}
                                  </td>
                                  <td
                                    data-label="Created"
                                    style={{
                                      color: "var(--text-muted)",
                                      fontSize: "12px",
                                    }}
                                  >
                                    {p.createdAt
                                      ? new Date(
                                          p.createdAt,
                                        ).toLocaleDateString("en-PH", {
                                          year: "numeric",
                                          month: "short",
                                          day: "numeric",
                                        })
                                      : "—"}
                                  </td>
                                  <td
                                    data-label="Actions"
                                    style={{ textAlign: "center" }}
                                  >
                                    <div className="sa-row-actions">
                                      <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => openEditProfessor(p)}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        className="btn btn-danger btn-sm"
                                        onClick={() =>
                                          confirmDeleteProfessor(p)
                                        }
                                      >
                                        Delete
                                      </button>
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
              {section === "settings" && (
                <div>
                  <div className="section-header">
                    <div>
                      <div className="section-title">Settings</div>
                      <div className="section-subtitle">
                        System administrator and school configuration
                      </div>
                    </div>
                  </div>

                  {/* Two‑column grid for System & Admin */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(340px, 1fr))",
                      gap: "24px",
                      marginBottom: "24px",
                    }}
                  >
                    {/* School / System Card  */}
                    <div className="card">
                      <div
                        className="card-header"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                          <polyline points="9 22 9 12 15 12 15 22" />
                        </svg>
                        <span className="card-title">School / System</span>
                      </div>
                      <div className="card-body">
                        <div className="form-group">
                          <label>School / System Name</label>
                          <input
                            type="text"
                            className="form-control"
                            value={systemSettings.schoolName}
                            onChange={(e) =>
                              setSystemSettings((prev) => ({
                                ...prev,
                                schoolName: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div className="form-group">
                          <label>Logo</label>
                          <div
                            style={{
                              display: "flex",
                              gap: "16px",
                              flexWrap: "wrap",
                            }}
                          >
                            {/* Current logo preview card */}
                            <div
                              style={{
                                flex: "1 1 160px",
                                background: "var(--surface-2)",
                                borderRadius: "10px",
                                padding: "12px",
                                textAlign: "center",
                                border: "1px solid var(--border)",
                              }}
                            >
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "var(--text-muted)",
                                  marginBottom: "6px",
                                }}
                              >
                                {hasCustomLogo ? "Current Logo" : "No Logo"}
                              </div>
                              {hasCustomLogo ? (
                                <img
                                  src={brandLogo}
                                  alt="Logo"
                                  style={{
                                    width: "64px",
                                    height: "64px",
                                    objectFit: "contain",
                                    margin: "0 auto 6px",
                                    display: "block",
                                  }}
                                />
                              ) : (
                                <div
                                  style={{
                                    width: "64px",
                                    height: "64px",
                                    borderRadius: "8px",
                                    background: "var(--border)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: "24px",
                                    fontWeight: 700,
                                    color: "var(--text-muted)",
                                    margin: "0 auto 6px",
                                  }}
                                >
                                  {brandInitial}
                                </div>
                              )}

                              {/* Remove button */}
                              <button
                                type="button"
                                disabled={!hasCustomLogo}
                                onClick={() => {
                                  if (hasCustomLogo) {
                                    setConfirm({
                                      message:
                                        "Remove the current school logo? This action cannot be undone.",
                                      onConfirm: removeSystemLogo,
                                    });
                                  }
                                }}
                                style={{
                                  width: "100%",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  gap: "6px",
                                  padding: "6px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #ef4444",
                                  background: "transparent",
                                  color: "#ef4444",
                                  fontSize: "13px",
                                  fontWeight: 500,
                                  cursor: hasCustomLogo
                                    ? "pointer"
                                    : "not-allowed",
                                  opacity: hasCustomLogo ? 1 : 0.5,
                                  transition: "background 0.2s, color 0.2s",
                                }}
                                onMouseEnter={(e) => {
                                  if (hasCustomLogo) {
                                    e.currentTarget.style.background =
                                      "#fee2e2";
                                    e.currentTarget.style.color = "#dc2626";
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (hasCustomLogo) {
                                    e.currentTarget.style.background =
                                      "transparent";
                                    e.currentTarget.style.color = "#ef4444";
                                  }
                                }}
                              >
                                {/* Trash icon SVG */}
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="16"
                                  height="16"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  <line x1="10" y1="11" x2="10" y2="17" />
                                  <line x1="14" y1="11" x2="14" y2="17" />
                                </svg>
                                Remove
                              </button>
                            </div>

                            {/* Upload card */}
                            <label
                              style={{
                                flex: "1 1 160px",
                                background: "var(--surface-2)",
                                borderRadius: "10px",
                                padding: "12px",
                                textAlign: "center",
                                border: "1px dashed var(--border)",
                                cursor: "pointer",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                justifyContent: "center",
                                minHeight: "120px",
                              }}
                            >
                              <div
                                style={{
                                  fontSize: "28px",
                                  color: "var(--text-muted)",
                                }}
                              >
                                +
                              </div>
                              <div
                                style={{
                                  fontSize: "13px",
                                  fontWeight: 600,
                                  color: "var(--text)",
                                }}
                              >
                                Upload New Logo
                              </div>
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "var(--text-muted)",
                                  marginTop: "2px",
                                }}
                              >
                                PNG, JPG, SVG up to 5MB
                              </div>
                              <input
                                type="file"
                                accept="image/*"
                                style={{ display: "none" }}
                                onChange={(e) =>
                                  handleSystemLogoUpload(e.target.files?.[0])
                                }
                              />
                            </label>
                          </div>
                        </div>
                        <div
                          className="sa-card-actions"
                          style={{ marginTop: "16px" }}
                        >
                          <button
                            className="btn btn-primary"
                            onClick={saveSystemSettings}
                            type="button"
                          >
                            Save School / System
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Administrator Account Card */}
                    <div className="card">
                      <div
                        className="card-header"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                        <span className="card-title">
                          Administrator Account
                        </span>
                      </div>
                      <div className="card-body">
                        <div className="form-group">
                          <label>Administrator Name</label>
                          <input
                            type="text"
                            className="form-control"
                            value={adminProfile.name}
                            onChange={(e) =>
                              setAdminProfile((prev) => ({
                                ...prev,
                                name: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div className="form-group">
                          <label>Administrator Username</label>
                          <input
                            type="text"
                            className="form-control"
                            autoComplete="username"
                            value={adminProfile.username}
                            onChange={(e) =>
                              setAdminProfile((prev) => ({
                                ...prev,
                                username: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div className="form-group">
                          <label>Administrator Email</label>
                          <input
                            type="email"
                            className="form-control"
                            value={adminProfile.email}
                            onChange={(e) =>
                              setAdminProfile((prev) => ({
                                ...prev,
                                email: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div className="form-group">
                          <label>Department</label>
                          <select
                            className="form-control"
                            value={adminProfile.department}
                            onChange={(e) =>
                              setAdminProfile((prev) => ({
                                ...prev,
                                department: e.target.value,
                              }))
                            }
                          >
                            <option value="">Select Department</option>
                            <option value="College of Arts & Sciences (CAS)">
                              College of Arts & Sciences (CAS)
                            </option>
                            <option value="College of Education (COE)">
                              College of Education (COE)
                            </option>
                            <option value="College of Business & Accountancy (CBA)">
                              College of Business & Accountancy (CBA)
                            </option>
                            <option value="College of Computer Studies (CCS)">
                              College of Computer Studies (CCS)
                            </option>
                            <option value="College of Engineering (COE)">
                              College of Engineering (COE)
                            </option>
                            <option value="College of Nursing (CON)">
                              College of Nursing (CON)
                            </option>
                          </select>
                        </div>
                        <div
                          className="sa-card-actions"
                          style={{ marginTop: "16px" }}
                        >
                          <button
                            className="btn btn-primary"
                            onClick={saveAdminProfile}
                            type="button"
                          >
                            Save Account Information
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Password Change Card */}
                  <div className="card">
                    <div
                      className="card-header"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect
                          x="3"
                          y="11"
                          width="18"
                          height="11"
                          rx="2"
                          ry="2"
                        />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                      <span className="card-title">Change Admin Password</span>
                    </div>
                    <div className="card-body">
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(240px, 1fr))",
                          gap: "16px",
                        }}
                      >
                        <div className="form-group">
                          <label>Current Password</label>
                          <div style={{ position: "relative" }}>
                            <input
                              ref={curPassRef}
                              type={showCurPass ? "text" : "password"}
                              className="form-control"
                              placeholder="Enter current password"
                              style={{ paddingRight: "42px" }}
                            />
                            <EyeToggle
                              show={showCurPass}
                              onToggle={() => setShowCurPass((v) => !v)}
                            />
                          </div>
                        </div>
                        <div className="form-group">
                          <label>New Password</label>
                          <div style={{ position: "relative" }}>
                            <input
                              ref={newPassRef}
                              type={showNewPass ? "text" : "password"}
                              className="form-control"
                              placeholder="Minimum 6 characters"
                              style={{ paddingRight: "42px" }}
                            />
                            <EyeToggle
                              show={showNewPass}
                              onToggle={() => setShowNewPass((v) => !v)}
                            />
                          </div>
                        </div>
                        <div className="form-group">
                          <label>Confirm New Password</label>
                          <div style={{ position: "relative" }}>
                            <input
                              ref={confirmPassRef}
                              type={showConfirmPass ? "text" : "password"}
                              className="form-control"
                              placeholder="Re-enter new password"
                              style={{ paddingRight: "42px" }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") changePassword();
                              }}
                            />
                            <EyeToggle
                              show={showConfirmPass}
                              onToggle={() => setShowConfirmPass((v) => !v)}
                            />
                          </div>
                        </div>
                      </div>
                      {settingsError && (
                        <div
                          className="text-danger mb-12"
                          style={{ fontSize: "13px" }}
                        >
                          {settingsError}
                        </div>
                      )}
                      {settingsSuccess && (
                        <div
                          style={{
                            color: "#16a34a",
                            fontSize: "13px",
                            marginBottom: "12px",
                          }}
                        >
                          {settingsSuccess}
                        </div>
                      )}
                      <div
                        className="sa-card-actions"
                        style={{ marginTop: "8px" }}
                      >
                        <button
                          className="btn btn-primary"
                          onClick={changePassword}
                        >
                          Update Password
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* /content-area */}
          </div>
          {/* /main-content */}
        </div>
      )}
    </>
  );
}
