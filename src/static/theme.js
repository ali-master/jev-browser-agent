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
      : "#ffffff";
  }

  try {
    preference = localStorage.getItem("jev-theme") ?? "system";
  } catch {}
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
      } catch {}
    });
  });
})();
