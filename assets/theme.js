(() => {
  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";

  function applyTheme(value) {
    preference = value === "light" || value === "dark" ? value : "system";
    const dark =
      preference === "dark" || (preference === "system" && systemTheme.matches);
    root.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]').content = dark
      ? "#09090b"
      : "#f5f5f2";
  }

  try {
    preference = localStorage.getItem("jev-theme") ?? "system";
  } catch {
    // Storage can be unavailable in private or embedded browsing contexts.
  }
  // Apply before the stylesheet loads to avoid a flash of the wrong theme.
  applyTheme(preference);

  systemTheme.addEventListener("change", () => {
    if (preference === "system") applyTheme(preference);
  });

  document.addEventListener("DOMContentLoaded", () => {
    const select = document.querySelector("[data-theme-select]");
    select.value = preference;
    select.disabled = false;
    select.addEventListener("change", () => {
      applyTheme(select.value);
      try {
        localStorage.setItem("jev-theme", preference);
      } catch {
        // The selected theme still works when preferences cannot be saved.
      }
    });
  });
})();
