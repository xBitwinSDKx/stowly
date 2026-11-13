// Setzt Thema und Akzentfarbe, bevor die App geladen ist (kein Aufblitzen des falschen Themas).
// Muss zu src/ui/theme.ts passen: gleiche Schlüssel, gleiche Werte, gleiche Vorgaben.
// Der Test src/ui/theme.test.ts führt diese Datei aus und vergleicht.
(function () {
  var THEMES = ["dark", "light", "system"];
  var ACCENTS = ["mint", "blue", "violet", "rose", "lime"];
  var theme = "dark";
  var accent = "mint";
  try {
    var storedTheme = localStorage.getItem("stowly.theme");
    var storedAccent = localStorage.getItem("stowly.accent");
    if (THEMES.indexOf(storedTheme) !== -1) theme = storedTheme;
    if (ACCENTS.indexOf(storedAccent) !== -1) accent = storedAccent;
  } catch (e) {
    // Speicher gesperrt (z. B. privater Modus): Vorgaben verwenden.
  }
  var resolved = theme;
  if (theme === "system") {
    resolved = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  var root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-accent", accent);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "light" ? "#f3f6f6" : "#0b1214");
})();
