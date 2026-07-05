const THEME_STORAGE_KEY = "acs_theme";

function normalizeTheme(theme) {
  return theme === "dark" ? "dark" : "light";
}

export function readStoredTheme() {
  if (typeof window === "undefined") return "light";
  return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
}

export function getActiveTheme() {
  if (typeof document === "undefined") return readStoredTheme();
  return normalizeTheme(
    document.documentElement.getAttribute("data-theme") || readStoredTheme(),
  );
}

export function applyTheme(theme) {
  const nextTheme = normalizeTheme(theme);
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", nextTheme);
  }
  return nextTheme;
}

export function persistTheme(theme) {
  const nextTheme = applyTheme(theme);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  }
  return nextTheme;
}

export function initializeTheme() {
  return persistTheme(readStoredTheme());
}

export function toggleTheme() {
  return persistTheme(getActiveTheme() === "dark" ? "light" : "dark");
}
