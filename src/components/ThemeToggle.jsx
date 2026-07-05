export default function ThemeToggle({
  checked,
  onChange,
  title = "Toggle dark mode",
}) {
  return (
    <label className="dm-toggle" title={title} aria-label={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={title}
      />
      <span className="dm-button" aria-hidden="true"></span>
      <span className="dm-label" aria-hidden="true">
        {checked ? "☾" : "☼"}
      </span>
    </label>
  );
}
