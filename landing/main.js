
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---- stage: browser print vs tympan ---- */
  var stage = $('#stage'), verdict = $('#verdict'), interacted = false, timer = null;
  var copy = {
    browser: { n: '6', h: 'pages for 4 sections', t: 'The cover spills a line onto page 2 and the footer ends up alone on page 6. You find that out by flipping through the file.' },
    tympan:  { n: '4', h: 'pages for 4 sections', t: 'Each section sits on its own page, the footer is on the last one, and the page count is checked against the section count.' }
  };
  function setState(s) {
    stage.dataset.state = s; verdict.dataset.state = s;
    $$('.seg button').forEach(function (b) {
      var on = b.dataset.state === s;
      b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1;
    });
    $('#row-browser').hidden = s !== 'browser';
    $('#row-tympan').hidden = s !== 'tympan';
    $('#v-n').textContent = copy[s].n; $('#v-h').textContent = copy[s].h; $('#v-t').textContent = copy[s].t;
  }
  $$('.seg button').forEach(function (b) {
    b.addEventListener('click', function () { interacted = true; clearTimeout(timer); setState(b.dataset.state); });
    b.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault(); interacted = true; clearTimeout(timer);
        var s = b.dataset.state === 'browser' ? 'tympan' : 'browser'; setState(s); $('#tab-' + s).focus();
      }
    });
  });
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) timer = setTimeout(function () { if (!interacted) setState('tympan'); }, 3600);

  /* ---- enlarge a page ---- */
  var lb = $('#lb'), lbImg = $('#lb img'), lastBtn = null;
  function closeLb() { lb.hidden = true; if (lastBtn) lastBtn.focus(); }
  $$('[data-zoom]').forEach(function (b) {
    b.addEventListener('click', function () {
      var im = $('img', b); lbImg.src = im.src; lbImg.alt = im.alt; lastBtn = b; lb.hidden = false; $('#lb-x').focus();
    });
  });
  lb.addEventListener('click', function (e) { if (e.target !== lbImg) closeLb(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !lb.hidden) closeLb(); });

  /* ---- copy buttons ---- */
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.parentNode.querySelector('code');
      var text = code.textContent.replace(/^\$\s*/, '');
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); };
      var fallback = function () {
        var r = document.createRange(); r.selectNodeContents(code);
        var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        btn.textContent = 'Press Ctrl+C'; setTimeout(function () { btn.textContent = 'Copy'; }, 2400);
      };
      try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
    });
  });

  /* ---- section counter: same detection ladder as src/detect.js, static DOM ---- */
  function titleOf(el) {
    var h = el.querySelector('h1,h2,h3,h4,h5,h6'), raw = null;
    if (h) { var c = h.cloneNode(true); $$('br', c).forEach(function (b) { b.replaceWith(' '); }); raw = c.textContent; }
    raw = raw || el.getAttribute('data-label') || el.getAttribute('aria-label') || el.getAttribute('title');
    return raw ? raw.replace(/\s+/g, ' ').trim().slice(0, 70) : null;
  }
  function detect(doc) {
    var n = $$('section.page-section', doc);
    if (n.length) return { how: 'section.page-section', nodes: n };
    var attrs = ['data-page', 'data-slide'];
    for (var i = 0; i < attrs.length; i++) {
      n = $$('[' + attrs[i] + ']', doc);
      if (n.length) return { how: '[' + attrs[i] + ']', nodes: n };
    }
    var best = null;
    $$('main, [role="main"], body > div', doc).forEach(function (c) {
      var kids = Array.prototype.filter.call(c.children, function (k) { return /^(SECTION|ARTICLE)$/.test(k.tagName); });
      if (kids.length && (!best || kids.length > best.length)) best = kids;
    });
    if (best) return { how: 'section / article inside main', nodes: best };
    return { how: 'whole document', nodes: [doc.body] };
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function render(html, name, isExample) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var r = detect(doc), count = r.nodes.length, whole = r.how === 'whole document';
    var text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    var jsBuilt = whole && doc.querySelectorAll('script').length && text.length < 300;
    var rows = r.nodes.slice(0, 8).map(function (el, i) {
      return '<li><span class="k">' + (i + 1) + '/' + count + '</span><span class="v">' + esc(titleOf(el) || el.id || '(untitled)') + '</span></li>';
    }).join('');
    var more = count > 8 ? '<li><span class="k"></span><span class="v">and ' + (count - 8) + ' more</span></li>' : '';
    var out = (isExample ? '<span class="tag-ex">Example: deck.html</span>' : '') +
      '<div class="big">' + count + '<small>' + (count === 1 ? 'section' : 'sections') + '</small></div>' +
      '<div class="how">found by: ' + esc(r.how) + '</div>' +
      (whole ? '' : '<ol>' + rows + more + '</ol>') +
      (jsBuilt ? '<p class="note warn">This file looks like it builds its content with JavaScript. This page does not run scripts, but tympan does, so its real count can differ. Run the command to see it.</p>'
               : '<p class="note">tympan also keeps any content above the first section as a cover page. Run <span class="mono">npx tympan ' + esc(name) + '</span> for the verified count.</p>');
    $('#result').innerHTML = out;
    $$('.cmd-file').forEach(function (el) { el.textContent = name; });
  }
  var dec = function (b) { return new TextDecoder().decode(Uint8Array.from(atob(b), function (c) { return c.charCodeAt(0); })); };
  render(dec($('#sample').textContent.trim()), 'deck.html', true);
  function readFile(f) {
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { render(String(rd.result), f.name.replace(/[^\w.\- ]/g, '_'), false); };
    rd.readAsText(f);
  }
  var drop = $('#drop');
  $('#file').addEventListener('change', function (e) { readFile(e.target.files[0]); });
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { readFile(e.dataTransfer.files[0]); });
})();
