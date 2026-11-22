"use strict";

(() => {
  const key = "diskwatch-theme";
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference;
  let toggle;

  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") preference = saved;
  } catch {
    // Apply the theme even when browser storage is unavailable.
  }

  function applyTheme() {
    const theme = preference ?? (system.matches ? "dark" : "light");
    toggle?.setAttribute("aria-pressed", String(theme === "dark"));
    if (root.dataset.theme === theme) return;
    root.dataset.theme = theme;
    document.dispatchEvent(new Event("diskwatch-theme-change"));
  }

  applyTheme();
  system.addEventListener("change", applyTheme);
  document.addEventListener("DOMContentLoaded", () => {
    toggle = document.getElementById("theme-toggle");
    applyTheme();
    toggle.hidden = false;
    toggle.addEventListener("click", () => {
      preference = root.dataset.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(key, preference);
      } catch {
        // Keep the preference for the current page.
      }
      applyTheme();
    });
  });
})();
