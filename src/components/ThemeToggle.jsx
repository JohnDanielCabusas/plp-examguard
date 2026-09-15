export default function ThemeToggle({
  checked,
  onChange,
  title = "Toggle dark mode",
}) {
  return (
    <label className="theme-switch examv2-interactive" title={title} data-exam-control="true">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={title}
      />
      <span className="theme-switch-track" aria-hidden="true">
        <svg className="theme-switch-icon ts-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
        <svg className="theme-switch-icon ts-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
        <span className="theme-switch-knob" />
      </span>
    </label>
  );
}
