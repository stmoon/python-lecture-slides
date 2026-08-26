/* Deck runtime: code line numbers, plus an in-slide Python runner.
 *
 * Line numbers go on every <pre>, shell sessions included.
 * The gutter lives outside the <pre> so pre.textContent stays pure code.
 *
 * A pre marked data-run also gets a 실행 button. Each run starts from a fresh
 * namespace: the deck preamble runs first, then the slide's own
 * <script type="text/x-run-setup"> if it has one, then the block. Blocks never
 * see each other's variables, so any slide runs on its own, in any order.
 *
 * Skipped inside an iframe - the editor previews the deck that way and has no
 * use for any of this. Print CSS hides the runner but keeps the numbers.
 */
(function () {
  'use strict';
  if (window.top !== window.self) return;

  var PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/';
  var KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.18.4/dist/';
  var pyodide = null;
  var booting = null;

  /* Slides list several expressions per block with the expected value in a
   * comment. Echo every top-level expression, the way a notebook would, instead
   * of only the last one. */
  var CELL_HELPER = [
    'import ast as _ast, os as _os',
    '_os.environ.setdefault("MPLBACKEND", "agg")',
    'def _figures():',
    '    import sys',
    '    plt = sys.modules.get("matplotlib.pyplot")',
    '    if plt is None: return []',
    '    import base64, io',
    '    out = []',
    '    for num in plt.get_fignums():',
    '        buf = io.BytesIO()',
    '        plt.figure(num).savefig(buf, format="png", dpi=130, bbox_inches="tight")',
    '        out.append(base64.b64encode(buf.getvalue()).decode())',
    '    plt.close("all")',
    '    return out',
    'def _show(v):',
    '    if v is None: return',
    '    mod = type(v).__module__ or ""',
    '    if mod.startswith("matplotlib"): return',
    '    if isinstance(v, (list, tuple)) and v and any((type(x).__module__ or "").startswith("matplotlib") for x in v):',
    '        return',
    '    text = str(v)',
    '    print(text if len(text) <= 2000 else text[:2000] + " ... (생략)")',
    '_PRE = ""',
    'def _base():',
    '    ns = {"__name__": "__main__", "_show": _show}',
    '    if _PRE:',
    '        import contextlib, io as _io',
    '        with contextlib.redirect_stdout(_io.StringIO()):',
    '            exec(compile(_PRE, "<preamble>", "exec"), ns)',
    '    return ns',
    'def _quiet(code, ns):',
    '    import contextlib, io as _io',
    '    with contextlib.redirect_stdout(_io.StringIO()), contextlib.redirect_stderr(_io.StringIO()):',
    '        exec(compile(code, "<setup>", "exec"), ns)',
    '    _figures()          # setup plots are scaffolding, not the answer',
    'def _run_cell(src, setup=""):',
    '    ns = _base()',
    '    if setup:',
    '        _quiet(setup, ns)',
    '    tree = _ast.parse(src)',
    '    for i, node in enumerate(tree.body):',
    '        if isinstance(node, _ast.Expr):',
    '            tree.body[i] = _ast.Expr(_ast.Call(',
    '                func=_ast.Name("_show", _ast.Load()), args=[node.value], keywords=[]))',
    '    _ast.fix_missing_locations(tree)',
    '    exec(compile(tree, "<cell>", "exec"), ns)'
  ].join('\n');

  var CSS = [
    '.code-wrap { position: relative; min-width: 0; }',
    '.code-wrap > pre { margin: 0; }',
    '.code-ln {',
    '  position: absolute; z-index: 2; top: 0; left: 0;',
    '  text-align: right; user-select: none; pointer-events: none;',
    '  font-family: var(--font-mono), monospace; font-variant-ligatures: none;',
    '  color: var(--ink-faint); white-space: pre;',
    '}',
    '.run-btn {',
    '  position: absolute; top: 10px; right: 12px; z-index: 3;',
    '  font-family: var(--font-body), sans-serif; font-size: 20px; font-weight: 700;',
    '  color: #1d4ed8; background: #ffffff; border: 2px solid #93c5fd;',
    '  border-radius: 999px; padding: 6px 18px; cursor: pointer; line-height: 1.2;',
    '  opacity: 0.35; transition: opacity 120ms ease, background 120ms ease;',
    '}',
    '.code-wrap:hover .run-btn, .run-btn:focus { opacity: 1; }',
    '.run-btn:hover { background: #dbeafe; }',
    '.run-btn[disabled] { cursor: progress; opacity: 1; color: #94a3b8; border-color: #e2e8f0; }',
    'pre[data-run][contenteditable]:focus { outline: none; box-shadow: inset 0 0 0 3px #93c5fd; }',
    '.run-panel {',
    '  position: absolute; left: 112px; right: 112px; bottom: 96px; z-index: 4;',
    '  max-height: 58%; overflow: auto; box-sizing: border-box;',
    '  background: #ffffff; color: #0f172a; border: 2px solid #0f172a; border-radius: 20px;',
    '  padding: 24px 28px; font-family: var(--font-mono), monospace; font-size: 26px;',
    '  line-height: 1.45; white-space: pre-wrap; word-break: break-word;',
    '  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.35);',
    '}',
    '.run-panel.err { color: #b91c1c; border-color: #b91c1c; }',
    '.run-panel.inline {',
    '  position: relative; left: auto; right: auto; bottom: auto;',
    '  max-height: 320px; box-shadow: none; font-size: 24px; padding: 18px 22px;',
    '}',
    '.run-panel.inline img { max-height: 250px; object-fit: contain; margin-top: 0;',
    '}',
    '.run-panel.inline:not(.has-output) { display: none; }',
    /* A slot lets the output cover whatever shares that column. */
    '.run-slot { position: relative; min-width: 0; }',
    '.run-slot > .run-panel.inline {',
    '  position: absolute; inset: 0; max-height: none; margin: 0;',
    '  display: flex; flex-direction: column; justify-content: center;',
    '}',
    // the slot rule above would otherwise out-rank the generic hide rule
    '.run-slot > .run-panel.inline:not(.has-output) { display: none; }',
    '.run-slot > .run-panel.inline img { max-height: 100%; margin: 0 auto; }',
    '.run-panel img { display: block; max-width: 100%; margin: 14px auto 0;',
    '  background: #ffffff; border-radius: 12px; }',
    '.run-close {',
    '  position: absolute; top: 10px; right: 16px;',
    '  background: transparent; border: 0; color: #475569; font-size: 30px;',
    '  cursor: pointer; line-height: 1;',
    '}',
    '.present-btn {',
    '  position: fixed; right: 24px; bottom: 24px; z-index: 20;',
    '  font-family: var(--font-body), sans-serif; font-size: 20px; font-weight: 700;',
    '  color: #1d4ed8; background: #ffffff; border: 2px solid #93c5fd;',
    '  border-radius: 999px; padding: 10px 22px; cursor: pointer;',
    '  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12); opacity: 0.5;',
    '}',
    '.present-btn:hover { opacity: 1; }',
    /* One slide at a time, scaled to the screen, everything else out of the way. */
    'body.presenting { background: #000; overflow: hidden; }',
    'body.presenting .present-btn { display: none; }',
    'body.presenting .slide { display: none; }',
    'body.presenting .slide.current {',
    '  display: flex; position: fixed; left: 50%; top: 50%;',
    '  transform: translate(-50%, -50%) scale(var(--present-scale, 1));',
    '  transform-origin: center center; box-shadow: none;',
    '}',
    '@media print {',
    '  .run-btn, .run-panel, .present-btn { display: none !important; }',
    '  body.presenting { background: #fff; overflow: visible; }',
    '  body.presenting .slide { display: flex !important; position: static !important; transform: none !important; }',
    '}'
  ].join('\n');

  function injectCss() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function wrap(pre) {
    var w = pre.parentNode;
    if (w && w.classList.contains('code-wrap')) return w;
    w = document.createElement('div');
    w.className = 'code-wrap';
    pre.parentNode.insertBefore(w, pre);
    w.appendChild(pre);
    return w;
  }

  /* --- line numbers ---------------------------------------------------- */

  function gutterText(pre) {
    var n = codeOf(pre).replace(/\n+$/, '').split('\n').length;
    var out = [];
    for (var i = 1; i <= n; i++) out.push(i);
    return out.join('\n');
  }

  function addLineNumbers(pre) {
    var lines = codeOf(pre).replace(/\n+$/, '').split('\n');

    var cs = getComputedStyle(pre);
    var size = parseFloat(cs.fontSize);
    var padLeft = parseFloat(cs.paddingLeft);
    var digits = String(lines.length).length;
    var gutter = Math.ceil(size * 0.62 * digits);
    var gap = 18;

    var w = wrap(pre);
    var g = document.createElement('span');
    g.className = 'code-ln';
    g.setAttribute('aria-hidden', 'true');
    g.style.fontSize = size + 'px';
    g.style.lineHeight = cs.lineHeight;
    g.style.top = cs.paddingTop;
    g.style.left = padLeft + 'px';
    g.style.width = gutter + 'px';
    g.textContent = lines.map(function (_, i) { return i + 1; }).join('\n');
    w.appendChild(g);
    // An edited block gains or loses lines; keep the gutter in step.
    pre.addEventListener('input', function () { g.textContent = gutterText(pre); });

    pre.style.paddingLeft = (padLeft + gutter + gap) + 'px';
  }

  /* --- runner ----------------------------------------------------------- */

  function textNode() {
    var span = document.createElement('span');
    span.className = 'run-text';
    return span;
  }

  // A re-run replaces the previous result; without this the figures pile up.
  function clear(panel) {
    [].forEach.call(panel.querySelectorAll('img'), function (img) { img.remove(); });
    var t = panel.querySelector('.run-text');
    if (t) t.textContent = '';
  }

  function panelFor(slide) {
    // A slide can reserve its own spot for output; otherwise the panel floats.
    var inline = slide.querySelector('[data-run-out]');
    if (inline) {
      if (!inline.querySelector('.run-close')) {
        inline.classList.add('run-panel', 'inline');
        var close = document.createElement('button');
        close.className = 'run-close';
        close.type = 'button';
        close.textContent = '×';
        close.title = '지우기';
        close.addEventListener('click', function () {
          clear(inline);
          inline.classList.remove('has-output');
        });
        inline.appendChild(close);
        inline.appendChild(textNode());
      }
      inline.classList.add('has-output');
      return inline;
    }
    var p = slide.querySelector('.run-panel');
    if (!p) {
      p = document.createElement('div');
      p.className = 'run-panel';
      var x = document.createElement('button');
      x.className = 'run-close';
      x.type = 'button';
      x.textContent = '×';
      x.title = '닫기';
      x.addEventListener('click', function () { p.remove(); });
      p.appendChild(x);
      p.appendChild(textNode());
      slide.appendChild(p);
    }
    return p;
  }

  function write(slide, text, isError) {
    var p = panelFor(slide);
    p.classList.toggle('err', !!isError);
    clear(p);
    p.querySelector('.run-text').textContent = text;
    p.scrollTop = isError ? p.scrollHeight : 0;
  }

  function append(slide, text) {
    var t = panelFor(slide).querySelector('.run-text');
    t.textContent += text;
  }

  function boot(slide) {
    if (pyodide) return Promise.resolve(pyodide);
    if (booting) return booting;
    write(slide, '파이썬 런타임 내려받는 중 ...');
    booting = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PYODIDE + 'pyodide.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('pyodide.js 를 불러오지 못했다. 네트워크를 확인할 것.')); };
      document.head.appendChild(s);
    }).then(function () {
      return window.loadPyodide({ indexURL: PYODIDE });
    }).then(function (py) {
      // A lecture jumps around, so every slide must run on its own. Assign the
      // shared handle only once the preamble is in, or a second click races it.
      var pre = document.querySelector('script[type="text/x-deck-preamble"]');
      py.runPython(CELL_HELPER);
      var src = pre ? pre.textContent : '';
      py.globals.set('_PRE', src);
      var ready = src.trim() ? py.loadPackagesFromImports(src) : Promise.resolve();
      return ready.then(function () { pyodide = py; window.deckPyodide = py; return py; });
    });
    return booting;
  }

  function codeOf(pre) {
    // Editing a <pre> makes the browser insert <div>/<br> for new lines, and
    // textContent drops those breaks - innerText keeps what the user sees.
    return (pre.innerText || pre.textContent).replace(/\u00a0/g, ' ');
  }

  function run(pre) {
    var slide = pre.closest('.slide');
    var btn = pre.parentNode.querySelector('.run-btn');
    var code = codeOf(pre);
    btn.disabled = true;
    btn.textContent = '실행 중';

    boot(slide).then(function (py) {
      write(slide, '패키지 준비 중 ...');
      // stdout is hooked only after the loader chatter is done, so the panel
      // shows the cell's own output and nothing else.
      var setupTag = slide.querySelector('script[type="text/x-run-setup"]');
      var setup = setupTag ? setupTag.textContent : '';
      return py.loadPackagesFromImports(setup + '\n' + code).then(function () {
        write(slide, '');
        py.setStdout({ batched: function (line) { append(slide, line + '\n'); } });
        py.setStderr({ batched: function (line) { append(slide, line + '\n'); } });
        py.globals.set('_src', code);
        py.globals.set('_setup', setup);
        return py.runPythonAsync('_run_cell(_src, _setup)');
      }).then(function () {
        return py.runPython('_figures()').toJs();
      });
    }).then(function (figs) {
      var p = slide.querySelector('.run-panel');
      if (p && !p.querySelector('.run-text').textContent && !figs.length) write(slide, '(출력 없음)');
      figs.forEach(function (b64) {
        var img = document.createElement('img');
        img.src = 'data:image/png;base64,' + b64;
        p.appendChild(img);
      });
    }).catch(function (err) {
      write(slide, String(err && err.message ? err.message : err), true);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '실행';
    });
  }

  /* --- comment toggle --------------------------------------------------- */

  function lineStarts(text) {
    var starts = [0];
    for (var i = 0; i < text.length; i++) {
      if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
  }

  function selectionOffsets(pre) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!pre.contains(range.startContainer)) return null;
    function offsetOf(node, off) {
      var r = document.createRange();
      r.selectNodeContents(pre);
      r.setEnd(node, off);
      return r.toString().length;
    }
    return [offsetOf(range.startContainer, range.startOffset),
            offsetOf(range.endContainer, range.endOffset)];
  }

  function toggleComment(pre) {
    var text = codeOf(pre).replace(/\n$/, '');
    var lines = text.split('\n');
    var starts = lineStarts(text);
    var off = selectionOffsets(pre) || [0, 0];

    var first = 0, last = 0;
    for (var i = 0; i < starts.length; i++) {
      if (starts[i] <= off[0]) first = i;
      if (starts[i] <= off[1]) last = i;
    }

    var picked = [];
    for (var n = first; n <= last; n++) {
      if (lines[n].trim()) picked.push(n);
    }
    if (!picked.length) picked = [first];

    var allCommented = picked.every(function (n) { return /^\s*#/.test(lines[n]); });
    var indent = Math.min.apply(null, picked.map(function (n) {
      return lines[n].match(/^\s*/)[0].length;
    }));

    picked.forEach(function (n) {
      if (allCommented) {
        lines[n] = lines[n].replace(/^(\s*)#\s?/, '$1');
      } else {
        lines[n] = lines[n].slice(0, indent) + '# ' + lines[n].slice(indent);
      }
    });

    // Rewriting drops the highlight spans; the block is being edited anyway.
    pre.textContent = lines.join('\n');
    pre.dispatchEvent(new Event('input'));

    var newStarts = lineStarts(pre.textContent);
    var from = newStarts[picked[0]];
    var to = newStarts[picked[picked.length - 1]] + lines[picked[picked.length - 1]].length;
    var node = pre.firstChild;
    if (node && node.nodeType === 3) {
      var r = document.createRange();
      r.setStart(node, Math.min(from, node.length));
      r.setEnd(node, Math.min(to, node.length));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  function addRunner(pre) {
    var w = wrap(pre);
    var btn = document.createElement('button');
    btn.className = 'run-btn';
    btn.type = 'button';
    btn.textContent = '실행';
    btn.addEventListener('click', function () { run(pre); });
    w.appendChild(btn);

    // Live tweaking during a lecture beats a fixed snippet.
    pre.setAttribute('contenteditable', 'plaintext-only');
    pre.setAttribute('spellcheck', 'false');
    pre.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        run(pre);
      }
      if (ev.key === '/' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        toggleComment(pre);
      }
    });
  }

  /* --- presenting ------------------------------------------------------- */

  var slides = [];
  var at = 0;

  /* Esc clears the visible result. Returns true when there was one to clear. */
  function closeOutput() {
    var open = [].filter.call(document.querySelectorAll('.run-panel'), function (p) {
      return !p.classList.contains('inline') || p.classList.contains('has-output');
    });
    if (!open.length) return false;
    open.forEach(function (p) {
      if (p.classList.contains('inline')) {
        clear(p);
        p.classList.remove('has-output');
      } else {
        p.remove();
      }
    });
    return true;
  }

  function editing(el) {
    if (!el || !el.closest) return false;   // document / window targets
    return !!(el.isContentEditable || el.closest('button, .run-panel'));
  }

  function fit() {
    if (!document.body.classList.contains('presenting')) return;
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    document.body.style.setProperty('--present-scale', s);
  }

  function show(i) {
    if (!slides.length) return;
    at = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach(function (sl, n) { sl.classList.toggle('current', n === at); });
  }

  function nearestSlide() {
    var mid = window.scrollY + window.innerHeight / 2;
    var best = 0, bestGap = Infinity;
    slides.forEach(function (sl, n) {
      var box = sl.getBoundingClientRect();
      var gap = Math.abs(window.scrollY + box.top + box.height / 2 - mid);
      if (gap < bestGap) { bestGap = gap; best = n; }
    });
    return best;
  }

  function startPresenting() {
    if (document.body.classList.contains('presenting')) return;
    var from = nearestSlide();
    document.body.classList.add('presenting');
    show(from);
    fit();
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () { /* keep going windowed */ });
    }
  }

  function stopPresenting() {
    if (!document.body.classList.contains('presenting')) return;
    document.body.classList.remove('presenting');
    slides.forEach(function (sl) { sl.classList.remove('current'); });
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
    slides[at].scrollIntoView();
  }

  var NEXT = { ' ': 1, Spacebar: 1, ArrowRight: 1, ArrowDown: 1, PageDown: 1, Enter: 1 };
  var PREV = { ArrowLeft: 1, ArrowUp: 1, PageUp: 1, Backspace: 1 };

  function setupPresenting() {
    slides = [].slice.call(document.querySelectorAll('.slide'));
    if (!slides.length) return;

    var btn = document.createElement('button');
    btn.className = 'present-btn';
    btn.type = 'button';
    btn.textContent = '전체 화면';
    btn.title = 'F 키로도 시작';
    btn.addEventListener('click', startPresenting);
    document.body.appendChild(btn);

    document.addEventListener('keydown', function (ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      // Esc closes the result first, wherever the focus is.
      if (ev.key === 'Escape' && closeOutput()) { ev.preventDefault(); return; }
      if (editing(ev.target)) return;

      if (!document.body.classList.contains('presenting')) {
        if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); startPresenting(); }
        return;
      }
      if (ev.key === 'Escape') { stopPresenting(); return; }
      if (NEXT[ev.key]) { ev.preventDefault(); show(at + 1); return; }
      if (PREV[ev.key]) { ev.preventDefault(); show(at - 1); return; }
      if (ev.key === 'Home') { ev.preventDefault(); show(0); return; }
      if (ev.key === 'End') { ev.preventDefault(); show(slides.length - 1); }
    });

    // Click anywhere on the slide advances, except on things you click to use.
    document.addEventListener('click', function (ev) {
      if (!document.body.classList.contains('presenting')) return;
      if (editing(ev.target) || ev.target.closest('pre')) return;
      show(at + 1);
    });

    window.addEventListener('resize', fit);
    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement) stopPresenting();
    });
  }

  /* --- math ------------------------------------------------------------- */

  function renderMath() {
    var spans = document.querySelectorAll('[data-tex]');
    if (!spans.length) return;

    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = KATEX + 'katex.min.css';
    document.head.appendChild(css);

    var js = document.createElement('script');
    js.src = KATEX + 'katex.min.js';
    js.onload = function () {
      Array.prototype.forEach.call(spans, function (el) {
        try {
          window.katex.render(el.getAttribute('data-tex'), el, {
            displayMode: el.hasAttribute('data-display'),
            throwOnError: false
          });
        } catch (err) {
          el.textContent = el.getAttribute('data-tex');
        }
      });
    };
    js.onerror = function () {
      // Offline: show the source rather than an empty slide.
      Array.prototype.forEach.call(spans, function (el) {
        el.textContent = el.getAttribute('data-tex');
      });
    };
    document.head.appendChild(js);
  }

  function init() {
    injectCss();
    renderMath();
    var code = document.querySelectorAll('pre:not([data-nolines])');
    Array.prototype.forEach.call(code, addLineNumbers);
    var runnable = document.querySelectorAll('pre[data-run]');
    Array.prototype.forEach.call(runnable, addRunner);
    setupPresenting();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
