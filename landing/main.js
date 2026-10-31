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

  /* ---- fill duel: drag the sheet-stack comparison ---- */
  var duel = document.querySelector("[data-duelwrap]");
  if (duel) {
    var after = duel.querySelector(".duel--after");
    var divider = duel.querySelector("[data-divider]");
    var pos = 0.55;

    function applyFill() {
      var pct = Math.round(pos * 100);
      if (after) after.style.clipPath = "inset(0 0 0 " + pct + "%)";
      if (divider) {
        divider.style.left = pct + "%";
        divider.setAttribute("aria-valuenow", String(pct));
      }
    }
    function setFromEvent(ev) {
      var rect = duel.getBoundingClientRect();
      var x = (ev.clientX - rect.left) / rect.width;
      pos = Math.max(0.06, Math.min(0.94, x));
      applyFill();
    }

    var dragging = false;
    duel.addEventListener("pointerdown", function (ev) {
      dragging = true;
      if (duel.setPointerCapture) duel.setPointerCapture(ev.pointerId);
      setFromEvent(ev);
    });
    duel.addEventListener("pointermove", function (ev) {
      if (dragging) setFromEvent(ev);
    });
    duel.addEventListener("pointerup", function () { dragging = false; });
    duel.addEventListener("pointercancel", function () { dragging = false; });

    if (divider) {
      divider.addEventListener("keydown", function (ev) {
        var step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[ev.key];
        if (!step) return;
        ev.preventDefault();
        ev.stopPropagation();
        pos = Math.max(0.06, Math.min(0.94, pos + step));
        applyFill();
      });
    }
    applyFill();
  }

  /* ---- copy the flag ---- */
  var copyBtn = document.querySelector("[data-copy]");
  if (copyBtn) {
    var toast = document.querySelector("[data-toast]");
    var toastTimer = null;
    function copied() {
      copyBtn.classList.add("is-copied");
      copyBtn.setAttribute("aria-live", "polite");
      copyBtn.textContent = "copied to clipboard \u2713";
      if (toast) toast.classList.add("is-on");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        copyBtn.classList.remove("is-copied");
        copyBtn.textContent = "Copy the run \u2014 $ npx tympan deck.html --flow";
        if (toast) toast.classList.remove("is-on");
      }, 2600);
    }
    copyBtn.addEventListener("click", function () {
      var text = copyBtn.getAttribute("data-copy");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(copied, function () { fallback(); });
      } else {
        fallback();
      }
      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); copied(); } catch (err) { /* ignore */ }
        document.body.removeChild(ta);
      }
    });
  }
})();
