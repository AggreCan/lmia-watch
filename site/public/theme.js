// Theme switch. Runs in the head, before the first paint, so a saved choice
// never flashes the other scheme. With no saved choice the stylesheet follows
// the system setting. The choice is a per-viewer convenience kept in this
// browser only; nothing about it is sent anywhere.
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  var saved = null;
  try { saved = localStorage.getItem("theme"); } catch (e) {}
  if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);

  function current() {
    var set = root.getAttribute("data-theme");
    if (set === "dark" || set === "light") return set;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  // Delegated, because the button is rendered after this script runs.
  document.addEventListener("click", function (e) {
    var target = e.target;
    var button = target && target.closest ? target.closest(".theme-toggle") : null;
    if (!button) return;
    var next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) {}
  });
})();

// Cloudflare checks that a visitor is a browser before the pages are shown
// and keeps the pass in a cookie that expires. A page left open past that,
// or brought back from the browser's cache, gets the check instead of the
// data in answer to its own requests (search, map, watchlist), marked by the
// header cf-mitigated: challenge, and the script would fail. Reloading shows
// the check and then the page. At most one reload a minute per tab, so a
// check that keeps coming back never loops. Here rather than in a deferred
// script because this file runs in the head, before the map and watchlist
// scripts make their first request.
(function () {
  var original = window.fetch;
  if (typeof original !== "function") return;
  var KEY = "challenge-reload";
  var WAIT_MS = 60000;
  var last = 0; // this page's own reload, for when storage cannot be read
  function reloadOnce() {
    var now = Date.now();
    try { last = Number(window.sessionStorage.getItem(KEY)) || last; } catch (e) {}
    if (last && now - last >= 0 && now - last < WAIT_MS) return;
    last = now;
    try { window.sessionStorage.setItem(KEY, String(now)); } catch (e) {}
    window.location.reload();
  }
  window.fetch = function () {
    return original.apply(window, arguments).then(function (res) {
      try {
        if (res && res.headers && res.headers.get("cf-mitigated") === "challenge") reloadOnce();
      } catch (e) {}
      return res;
    });
  };
})();
