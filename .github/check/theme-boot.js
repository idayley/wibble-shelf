// THE THEME, BEFORE THE FIRST PAINT. Loaded as a blocking script from
// index.html's <head>, so the document is already the right way round by
// the time the body is drawn -- otherwise an operator who chose dark would
// see a light flash on every launch while the bundle loaded.
//
// Reads what `src/styles/theme.ts` writes: the `theme` field of this
// device's window-half workspace (`workspaceHome.ts`, WINDOW_KEY). Kept
// deliberately tiny and dependency-free; `useResolvedTheme` takes over as
// soon as the app mounts, so anything this gets wrong lasts one frame.
(function () {
  var theme = "light";
  try {
    var stored = JSON.parse(localStorage.getItem("wibble.workspace.window") || "{}").theme;
    if (stored === "light" || stored === "dark" || stored === "system") theme = stored;
  } catch (e) {
    // No storage, or a hand-edited value: the default stands.
  }
  if (theme === "system") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  var root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
})();
