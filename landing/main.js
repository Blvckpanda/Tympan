// tympan landing — the cut demo + terminal typing (zero deps)
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- the cut: pages pile in as the doc "scrolls" ---- */
  var pages = Array.prototype.slice.call(document.querySelectorAll(".stack .page"));
  var sheetCount = document.getElementById("sheetCount");
  var note = document.querySelector("[data-count]");
  var onIdx = -1;

  function showNext() {
    if (onIdx >= pages.length - 1) return;
    onIdx++;
    pages[onIdx].classList.add("is-on");
    pages[onIdx].style.zIndex = String(pages.length + 10 - onIdx);
    if (sheetCount) sheetCount.textContent = String(onIdx + 1);
    if (onIdx < pages.length - 1) setTimeout(showNext, 650);
  }

  var cut = document.querySelector(".cut");
  if (cut) {
    if (reduceMotion) {
      pages.forEach(function (p) { p.classList.add("is-on"); });
      if (sheetCount) sheetCount.textContent = String(pages.length);
    } else if ("IntersectionObserver" in window) {
      var seen = false;
      new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; }) && !seen) {
          seen = true;
          showNext();
        }
      }, { threshold: 0.35 }).observe(cut);
    } else {
      showNext();
    }
  }

  /* ---- terminal typing ---- */
  var term = document.getElementById("termBody");
  var script = [
    "$ npx tympan brief-dark.html --probe \"Harbor Gardens\"",
    "",
    "  brief-dark.html  ->  brief-dark.pdf",
    "  detected 3 section(s) via semantic-children",
    "    section 1/3 (prelude)   -> sheet 1",
    "    section 2/3 (body)      -> sheet 2",
    "    section 3/3 (questions) -> sheet 3",
    "  verified: probe matched   outline written   0 diagnostics",
    "  4.1 s  \" 127 KB \"  sha256 3b0f...c91a   [same input, same bytes]"
  ].join("\n");

  function type() {
    if (!term) return;
    var i = 0;
    if (reduceMotion) { term.textContent = script; return; }
    (function step() {
      if (i > script.length) return;
      term.textContent = script.slice(0, i);
      i++;
      var ch = script.charAt(i - 1);
      setTimeout(step, ch === "\n" ? 260 : 14 + Math.random() * 26);
    })();
  }

  var termSec = document.querySelector(".term");
  if (termSec) {
    if ("IntersectionObserver" in window) {
      var typed = false;
      new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; }) && !typed) {
          typed = true;
          type();
        }
      }, { threshold: 0.3 }).observe(termSec);
    } else {
      type();
    }
  }
})();
