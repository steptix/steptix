  // ── The toolbar (stories/testbench-record-toolbar.md) ───────────────────
  //
  // Spliced into record-steps.js's closure by src/recorder/page-script.ts, at
  // the __RECORD_TOOLBAR__ placeholder, so it shares that script's state and
  // helpers (`state`, `token`, `sendCmd`, `flushAllExcept`, the describers).
  //
  // What lives here:
  //
  //   - the bar itself, in the TOP frame of each tab only: an
  //     `<aiui-recorder>` element with a CLOSED shadow root, a manual popover
  //     on `<html>` (the browser's top layer), styled by one constructable
  //     sheet adopted into the root and by per-property `style.setProperty`
  //     on the host — no `<style>`, no `cssText`, no `innerHTML`, so a strict
  //     Content-Security-Policy or Trusted Types have nothing to block;
  //   - the gate: the recorder's FIRST window listener, capture phase, for
  //     every event that could come from the bar. An event whose composed path
  //     holds the host is the bar being used: handled here and stopped here,
  //     so neither the recorder's listeners nor the page's ever hear it. The
  //     Alt+Shift shortcuts are handled here too, in every frame;
  //   - pick mode's outline and label, in EVERY frame (the pointer is in the
  //     frame's coordinates), in a second closed-root popover that takes no
  //     pointer events and is taken down before any crop is asked for;
  //   - the check-in that notices a recorder that stopped answering.
  //
  // It is driven entirely by the server's state push (`setState`, and the
  // `hello` answer): `toolbar` is the block the server sends to top frames.
  // Nothing is kept in the page's own storage — the dock and the minimised
  // state come from the server and go back to it.

  var TB_TAG = 'aiui-recorder';
  var PICK_TAG = 'aiui-recorder-pick';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var IS_TOP = window === window.top;
  var DOCKS = { tl: 1, tc: 1, tr: 1, bl: 1, bc: 1, br: 1 };
  /** Below this page width the labels drop and the bar starts minimised. */
  var NARROW_PX = 560;
  /** The done / ended message stays this long, then the bar leaves. */
  var END_SHOW_MS = 6000;
  /** The step box's unsent text goes to the server after this pause. */
  var BOX_TEXT_MS = 400;
  var DEFAULT_CHECK_IN_MS = 2000;
  /** Unanswered check-ins before "The recorder isn't answering". */
  var MISSED_FOR_OFFLINE = 2;
  /** How long a command the page applied ahead of the server waits for the
   *  server's answer before taking its own change back. */
  var COMMAND_ANSWER_MS = 3000;
  var SHORTCUTS = { KeyP: 'pause', KeyC: 'check', KeyS: 'step', KeyZ: 'undo', KeyM: 'minimise', KeyR: 'focus' };

  var tb = null;
  var tbView = null;
  var tbViewAt = 0;
  var tbLocal = {
    drawer: false, box: false, confirm: false, offline: false, expanded: false,
    boxText: '', boxTimer: 0, returnFocus: null, drag: null, suppressClick: false,
    noticeSeq: -1, noticeUntil: 0, closedByUser: false, removeTimer: 0,
    lastPaused: false, lastPick: false, lastPhase: '', lastFocusSecret: false,
    // The drawer (stories/testbench-record-edit-steps.md, "The drawer"): the
    // step being edited in place ({ id, input, viaKeyboard, original });
    // what this page has done to a row ahead of the server's answer, by step
    // id ({ text } | { deleted } | { restored }, `confirmed` once answered
    // yes); and where the Add step box puts its step ({ id, index, revision,
    // n }) when a row's + opened it.
    editing: null, overrides: {}, insertAfter: null,
  };
  var tbCheck = { timer: 0, every: 0, pending: false, missed: 0 };
  var swallowKeyUp = null;

  function nowMs() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function important(el, prop, value) {
    try { el.style.setProperty(prop, value, 'important'); } catch (err) { /* an old engine */ }
  }

  /** The host's own box, set property by property with !important: they
   *  beat the popover's built-in styles and any page rule on the host. */
  function resetHost(el, pointerEvents) {
    important(el, 'all', 'initial');
    important(el, 'position', 'fixed');
    important(el, 'display', 'block');
    important(el, 'inset', 'auto');
    important(el, 'margin', '0');
    important(el, 'padding', '0');
    important(el, 'border', '0');
    important(el, 'background', 'transparent');
    important(el, 'overflow', 'visible');
    important(el, 'z-index', '2147483647');
    important(el, 'visibility', 'visible');
    important(el, 'opacity', '1');
    important(el, 'pointer-events', pointerEvents);
    important(el, 'cursor', 'auto');
    important(el, 'transform', 'none');
    important(el, 'filter', 'none');
    important(el, 'contain', 'none');
    important(el, 'color-scheme', 'dark');
    important(el, 'max-height', 'none');
    important(el, 'min-width', '0');
  }

  function tbSheetOf(css) {
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      return sheet;
    } catch (err) {
      return null;
    }
  }

  var TOOLBAR_CSS = [
    '*{box-sizing:border-box}',
    '[hidden]{display:none!important}',
    'button{font:inherit;color:inherit;margin:0;text-transform:none;letter-spacing:normal}',
    'svg{display:block;flex:none;overflow:visible}',
    '.wrap{--bg:#1B1E23;--raise:#292D34;--press:#323741;--field:#121418;--line:#3A4049;--text:#EDEFF2;',
    '--dim:#A7AFB9;--faint:#7D8691;--rec:#FF5A5F;--paused:#F2B544;--pick:#5CB8FF;--ok:#6FD6A0;--yours:#8FE0B5;',
    '--ui:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    '--mono:ui-monospace,"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace;',
    'font-family:var(--ui);font-size:13px;line-height:1.25;font-weight:400;font-style:normal;color:var(--text);',
    'font-variant-numeric:tabular-nums;cursor:default;text-align:left;white-space:normal;word-spacing:normal;',
    'user-select:none;-webkit-user-select:none;direction:ltr}',
    '.wrap.dragging .tb,.wrap.dragging .pill{box-shadow:0 0 0 1px var(--ring),0 18px 40px rgba(0,0,0,.45)}',
    '.tb{--ring:rgba(255,255,255,.16);display:flex;flex-direction:column;background:var(--bg);border-radius:10px;',
    'box-shadow:0 0 0 1px var(--ring),0 10px 28px rgba(0,0,0,.34),0 2px 6px rgba(0,0,0,.22);overflow:hidden}',
    '.wrap[data-edge="bottom"] .tb{flex-direction:column-reverse}',
    '[data-ring="rec"]{--ring:rgba(255,90,95,.62)}',
    '[data-ring="paused"]{--ring:rgba(242,181,68,.7)}',
    '[data-ring="pick"]{--ring:rgba(92,184,255,.8)}',
    '[data-ring="warn"]{--ring:rgba(242,181,68,.7)}',
    '[data-ring="done"]{--ring:rgba(111,214,160,.6)}',
    '.main{display:flex;align-items:center;gap:2px;padding:4px;min-height:40px}',
    '.grip{display:grid;place-items:center;width:20px;height:32px;border:0;background:transparent;color:var(--faint);',
    'cursor:grab;border-radius:5px;padding:0;touch-action:none}',
    '.grip:hover{color:var(--dim);background:var(--raise)}',
    '.status{display:flex;align-items:center;gap:7px;padding:0 10px 0 6px;white-space:nowrap}',
    '.dot{position:relative;width:10px;height:10px;border-radius:50%;background:var(--rec);flex:none}',
    '.dot::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid var(--rec);opacity:0;',
    'animation:aiui-pulse 1.8s ease-out infinite}',
    '@keyframes aiui-pulse{0%{transform:scale(.6);opacity:.7}100%{transform:scale(1.35);opacity:0}}',
    '.dot[data-kind="paused"]{background:transparent}',
    '.dot[data-kind="paused"]::before{content:"";position:absolute;inset:0 1px;border-left:3px solid var(--paused);',
    'border-right:3px solid var(--paused)}',
    '.dot[data-kind="paused"]::after,.dot[data-kind="offline"]::after,.dot[data-kind="done"]::after,',
    '.dot[data-kind="ended"]::after,.dot[data-kind="writing"]::after{display:none}',
    '.dot[data-kind="offline"]{background:transparent;box-shadow:inset 0 0 0 2px var(--paused)}',
    '.dot[data-kind="done"]{background:var(--ok)}',
    '.dot[data-kind="ended"]{background:var(--faint)}',
    '.dot[data-kind="writing"]{background:transparent;border:2px solid var(--line);border-top-color:var(--text);',
    'animation:aiui-spin .9s linear infinite}',
    '@keyframes aiui-spin{to{transform:rotate(360deg)}}',
    '.rec{font-weight:700;letter-spacing:.08em;font-size:12px}',
    '.rec[data-kind="rec"]{color:#FF7B7F}',
    '.rec[data-kind="paused"],.rec[data-kind="offline"]{color:var(--paused)}',
    '.rec[data-kind="done"]{color:var(--ok)}',
    '.rec[data-kind="ended"],.rec[data-kind="writing"]{color:var(--dim)}',
    '.rec[data-kind="pick"]{color:#A8D8FF}',
    '.time{color:var(--text);font-weight:500}',
    '.count{color:var(--dim)}',
    '.sep{width:1px;height:20px;background:var(--line);margin:0 4px;flex:none}',
    '.btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:0;border-radius:6px;',
    'background:transparent;color:var(--text);font:500 13px var(--ui);cursor:pointer;white-space:nowrap}',
    '.btn svg{color:var(--dim)}',
    '.btn:hover:not(:disabled){background:var(--raise)}',
    '.btn:hover:not(:disabled) svg{color:var(--text)}',
    'button:focus{outline:none}',
    '.btn:focus-visible,.grip:focus-visible,.mini:focus-visible,.pill:focus-visible,.toggle:focus-visible{',
    'outline:2px solid var(--pick);outline-offset:-2px}',
    '.btn:disabled{color:var(--faint);cursor:default}',
    '.btn:disabled svg{color:var(--faint);opacity:.7}',
    '.btn[data-cmd="pause"][aria-pressed="true"]{background:rgba(242,181,68,.16);color:#FFD27A}',
    '.btn[data-cmd="pause"][aria-pressed="true"] svg{color:#FFD27A}',
    '.btn[data-cmd="check"][aria-pressed="true"]{background:rgba(92,184,255,.18);color:#A8D8FF}',
    '.btn[data-cmd="check"][aria-pressed="true"] svg{color:#A8D8FF}',
    '.btn[data-cmd="step"][aria-pressed="true"]{background:var(--press)}',
    '.stop{background:#E9ECEF;color:#16191D;margin-left:2px}',
    '.stop svg{color:#D93A40}',
    '.btn.stop:hover:not(:disabled){background:#FFFFFF}',
    '.btn.stop:hover:not(:disabled) svg{color:#D93A40}',
    '.btn.stop:disabled{background:var(--raise);color:var(--faint)}',
    '.quiet{color:var(--dim)}',
    '.quiet .x{display:none}',
    '.icon{padding:0;width:30px;justify-content:center}',
    '.sub{width:0;min-width:100%;display:flex;align-items:center;gap:8px;min-height:34px;padding:5px 10px 5px 12px;',
    'border-top:1px solid var(--line);font-size:12.5px;color:var(--dim)}',
    '.wrap[data-edge="bottom"] .sub{border-top:0;border-bottom:1px solid var(--line)}',
    '.sub .n{font-family:var(--mono);font-size:11.5px;color:var(--faint);flex:none;min-width:1.4em;text-align:right}',
    '.sub .t{color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}',
    '.sub .msg{color:var(--text);flex:1;min-width:0}',
    '.sub .msg.dim{color:var(--dim)}',
    '.sub .msg.pick{color:#BFE2FF}',
    '.sub .msg.warn{color:#FFD27A}',
    '.sub .upd{color:var(--dim);font-style:italic;flex:none}',
    '.sub kbd{font-family:var(--mono);font-size:11px;border:1px solid var(--line);border-bottom-width:2px;',
    'border-radius:4px;padding:0 4px;color:var(--text);background:var(--raise)}',
    '.ico{flex:none;display:inline-flex}',
    '.ico.ok{color:var(--ok)}',
    '.ico.warn{color:var(--paused)}',
    '.yours{flex:none;font-size:10.5px;font-weight:600;letter-spacing:.04em;color:#0F2A1D;background:var(--yours);',
    'border-radius:4px;padding:1px 5px}',
    '.chip{display:inline-flex;align-items:center;gap:5px;flex:none;border:1px solid rgba(143,224,181,.5);',
    'color:var(--yours);border-radius:999px;padding:2px 8px 2px 6px;font-weight:600;font-size:12px}',
    '.toggle{flex:none;display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--dim);',
    'font:500 12px var(--ui);padding:3px 6px;border-radius:5px;cursor:pointer}',
    '.toggle:hover{background:var(--raise);color:var(--text)}',
    '.toggle svg{transition:transform .15s}',
    '.toggle[aria-expanded="true"] svg{transform:rotate(180deg)}',
    '.wrap[data-edge="bottom"] .toggle svg{transform:rotate(180deg)}',
    '.wrap[data-edge="bottom"] .toggle[aria-expanded="true"] svg{transform:none}',
    '.mini{flex:none;border:1px solid var(--line);background:var(--raise);color:var(--text);font:500 12px var(--ui);',
    'border-radius:5px;padding:3px 9px;cursor:pointer}',
    '.mini:hover{background:var(--press)}',
    // The host takes no pointer events once the recording is over; Close does.
    '.mini[data-cmd="close"]{pointer-events:auto}',
    '.mini.danger{background:#5A1E22;border-color:#7A2A30;color:#FFD9D9}',
    '.mini.danger:hover{background:#6E252A}',
    '.input{flex:1;min-width:0;width:320px;height:28px;background:var(--field);color:var(--text);',
    'border:1px solid var(--line);border-radius:6px;padding:0 9px;font:13px var(--ui);margin:0;',
    'user-select:text;-webkit-user-select:text;cursor:text}',
    '.input::placeholder{color:var(--faint)}',
    '.input:focus{outline:2px solid var(--pick);outline-offset:-1px;border-color:transparent}',
    '.hint{flex:none;color:var(--faint);font-size:11.5px;white-space:nowrap}',
    '.spin{width:12px;height:12px;border-radius:50%;flex:none;border:2px solid var(--line);',
    'border-top-color:var(--text);animation:aiui-spin .9s linear infinite}',
    '.drawer{position:relative;width:0;min-width:100%;max-height:214px;overflow:auto;border-top:1px solid var(--line);',
    'padding:6px 4px}',
    '.wrap[data-edge="bottom"] .drawer{border-top:0;border-bottom:1px solid var(--line)}',
    '.drawer ol{list-style:none;margin:0;padding:0 0 4px;display:grid}',
    '.drawer li.row{display:flex;align-items:center;gap:8px;min-height:26px;padding:2px 4px 2px 8px;border-radius:5px;',
    'font-size:12.5px;color:var(--text)}',
    '.drawer li.row:hover{background:var(--raise)}',
    '.drawer li.row:focus{outline:none}',
    '.drawer li.row:focus-visible{outline:2px solid var(--pick);outline-offset:-2px}',
    '.drawer li .n{font-family:var(--mono);font-size:11px;color:var(--faint);min-width:1.6em;text-align:right;flex:none}',
    '.drawer li .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:text}',
    '.drawer li.last{background:var(--raise)}',
    '.drawer li.pending .t{color:var(--faint);font-style:italic;cursor:default}',
    '.drawer li.deleted .t{color:var(--faint);text-decoration:line-through;cursor:default}',
    '.drawer li.restoring .t{color:var(--dim);cursor:default}',
    '.drawer li .yours{font-size:10px;padding:0 5px}',
    '.drawer .rb{flex:none;display:inline-grid;place-items:center;width:22px;height:22px;border:0;border-radius:5px;',
    'background:transparent;color:var(--dim);cursor:pointer;padding:0;visibility:hidden}',
    '.drawer .rb:hover{background:var(--press);color:var(--text)}',
    '.drawer li.row:hover .rb,.drawer li.row:focus-within .rb,.drawer .rb:focus-visible{visibility:visible}',
    '.drawer li.gap{position:relative;height:5px;padding:0}',
    '.drawer .ins{position:absolute;left:6px;top:-8px;z-index:1;display:grid;place-items:center;width:20px;height:20px;',
    'border:1px solid var(--line);border-radius:50%;background:var(--raise);color:var(--text);cursor:pointer;padding:0;',
    'visibility:hidden}',
    '.drawer .ins:hover{background:var(--press)}',
    '.drawer li.gap:hover .ins,.drawer li.row:hover+li.gap .ins,.drawer li.row:focus-within+li.gap .ins,',
    '.drawer .ins:focus-visible{visibility:visible}',
    '.drawer .rb:focus-visible,.drawer .ins:focus-visible,.drawer .mini:focus-visible{outline:2px solid var(--pick);',
    'outline-offset:-1px}',
    '.drawer .rowedit{flex:1;min-width:0;height:24px;background:var(--field);color:var(--text);border:1px solid var(--line);',
    'border-radius:5px;padding:0 7px;font:12.5px var(--ui);margin:0;user-select:text;-webkit-user-select:text;cursor:text}',
    '.drawer .rowedit:focus{outline:2px solid var(--pick);outline-offset:-1px;border-color:transparent}',
    '.drawer .foot{color:var(--faint);font-size:11.5px;padding:6px 8px 2px;margin:0}',
    '.pill{--ring:rgba(255,255,255,.16);display:inline-flex;align-items:center;gap:7px;height:34px;',
    'padding:0 6px 0 12px;background:var(--bg);color:var(--text);border:0;border-radius:999px;',
    'box-shadow:0 0 0 1px var(--ring),0 8px 22px rgba(0,0,0,.34);font:500 13px var(--ui);cursor:grab;',
    'touch-action:none}',
    '.pill .exp{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;',
    'background:var(--raise);color:var(--dim)}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '@media (max-width:559px){.label{display:none}.btn{padding:0 8px}.quiet .x{display:block}',
    '.count{display:none}.hint{display:none}.input{width:180px}}',
    '@media (max-width:400px){.btn{padding:0 6px}.status{padding:0 6px 0 4px}.time{display:none}.sep{margin:0 1px}}',
    '@media (prefers-reduced-motion:reduce){.dot::after{display:none}',
    '.dot[data-kind="writing"],.spin{animation:none;border-top-color:var(--dim)}.toggle svg{transition:none}}',
  ].join('');

  var PICK_CSS = [
    '.outline{position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid #2E9BFF;border-radius:4px;',
    'background:rgba(46,155,255,.10);box-shadow:0 0 0 1px rgba(255,255,255,.95),inset 0 0 0 1px rgba(255,255,255,.55)}',
    '.label{position:fixed;pointer-events:none;box-sizing:border-box;display:flex;align-items:center;gap:6px;',
    'max-width:min(380px,calc(100vw - 16px));background:#1B1E23;color:#EDEFF2;',
    'font:500 12px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    'padding:5px 9px;border-radius:6px;box-shadow:0 0 0 1px rgba(92,184,255,.6),0 6px 16px rgba(0,0,0,.3);',
    'white-space:nowrap;letter-spacing:normal;text-transform:none;text-align:left}',
    '.label::before{content:"";width:7px;height:7px;border-radius:50%;background:#5CB8FF;flex:none}',
    '.label span{overflow:hidden;text-overflow:ellipsis}',
    '[hidden]{display:none!important}',
  ].join('');

  var CROSSHAIR_CSS = '*,*::before,*::after{cursor:crosshair!important}';

  // Icons: SVG elements built one attribute at a time (never an HTML
  // string — Trusted Types would refuse one), not subject to img-src.
  var ICONS = {
    grip: { w: 10, h: 16, fill: true, shapes: [
      ['circle', { cx: 3, cy: 4, r: 1.3 }], ['circle', { cx: 7, cy: 4, r: 1.3 }],
      ['circle', { cx: 3, cy: 8, r: 1.3 }], ['circle', { cx: 7, cy: 8, r: 1.3 }],
      ['circle', { cx: 3, cy: 12, r: 1.3 }], ['circle', { cx: 7, cy: 12, r: 1.3 }]] },
    pause: { w: 16, h: 16, fill: true, shapes: [
      ['rect', { x: 3.5, y: 3, width: 3, height: 10, rx: 1 }], ['rect', { x: 9.5, y: 3, width: 3, height: 10, rx: 1 }]] },
    play: { w: 16, h: 16, fill: true, shapes: [
      ['path', { d: 'M4.5 2.8v10.4c0 .5.6.8 1 .5l8-5.2a.6.6 0 0 0 0-1L5.5 2.3c-.4-.3-1 0-1 .5Z' }]] },
    check: { w: 16, h: 16, shapes: [
      ['path', { d: 'M2.5 5V3.5a1 1 0 0 1 1-1H5M11 2.5h1.5a1 1 0 0 1 1 1V5M13.5 11v1.5a1 1 0 0 1-1 1H11M5 13.5H3.5a1 1 0 0 1-1-1V11' }],
      ['path', { d: 'm5.5 8.2 1.8 1.8 3.4-3.6' }]] },
    step: { w: 16, h: 16, shapes: [['path', { d: 'M2.5 4h8M2.5 8h5M2.5 12h4M12 8.5v5M9.5 11h5' }]] },
    undo: { w: 16, h: 16, shapes: [['path', { d: 'M5.5 3.5 2.5 6.5l3 3' }], ['path', { d: 'M2.8 6.5h6.7a4 4 0 0 1 0 8H7' }]] },
    stop: { w: 12, h: 12, fill: true, shapes: [['rect', { x: 1, y: 1, width: 10, height: 10, rx: 2 }]] },
    x: { w: 14, h: 14, sw: 1.6, shapes: [['path', { d: 'm3 3 8 8M11 3l-8 8' }]] },
    minus: { w: 14, h: 14, sw: 1.6, shapes: [['path', { d: 'M3 7h8' }]] },
    lock: { w: 12, h: 12, sw: 1.4, shapes: [
      ['rect', { x: 2.5, y: 5.2, width: 7, height: 5, rx: 1.2 }], ['path', { d: 'M4 5.2V3.8a2 2 0 0 1 4 0v1.4' }]] },
    tick: { w: 14, h: 14, sw: 1.8, shapes: [['path', { d: 'm2.8 7.4 2.8 2.8 5.6-6' }]] },
    warn: { w: 14, h: 14, shapes: [['path', { d: 'M7 1.8 12.8 12H1.2L7 1.8Z' }], ['path', { d: 'M7 5.6v3M7 10.2v.3' }]] },
    chev: { w: 12, h: 12, sw: 1.6, shapes: [['path', { d: 'm3 4.5 3 3 3-3' }]] },
    up: { w: 12, h: 12, sw: 1.6, shapes: [['path', { d: 'm3 7.5 3-3 3 3' }]] },
    plus: { w: 10, h: 10, sw: 1.6, shapes: [['path', { d: 'M5 1.5v7M1.5 5h7' }]] },
    xs: { w: 10, h: 10, sw: 1.6, shapes: [['path', { d: 'm2 2 6 6M8 2 2 8' }]] },
  };

  function tbIcon(name, cls) {
    var def = ICONS[name];
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(def.w));
    svg.setAttribute('height', String(def.h));
    svg.setAttribute('viewBox', '0 0 ' + def.w + ' ' + def.h);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (cls) svg.setAttribute('class', cls);
    if (def.fill) {
      svg.setAttribute('fill', 'currentColor');
    } else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', String(def.sw || 1.5));
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    for (var i = 0; i < def.shapes.length; i++) {
      var shape = document.createElementNS(SVG_NS, def.shapes[i][0]);
      var attrs = def.shapes[i][1];
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) shape.setAttribute(k, String(attrs[k]));
      }
      svg.appendChild(shape);
    }
    return svg;
  }

  function tbEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.setAttribute('class', cls);
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function tbButton(cmd, cls, icon, label, title, shortcut) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('class', cls);
    b.setAttribute('data-cmd', cmd);
    // Out of the page's Tab order: a recorded "Press Tab" must land where it
    // lands in a run, where there is no toolbar. Alt+Shift+R reaches the bar.
    b.tabIndex = -1;
    if (icon) b.appendChild(tbIcon(icon));
    if (label) b.appendChild(tbEl('span', 'label', label));
    if (title) b.title = title;
    if (shortcut) b.setAttribute('aria-keyshortcuts', shortcut);
    return b;
  }

  // ── Is this event the toolbar's? ───────────────────────────────────────
  //
  // Events from inside a closed root reach every listener outside it
  // retargeted to the host, and `composedPath()` seen from outside holds the
  // host (and nothing inside). One question, asked first by every recorder
  // listener: does the path hold one of the recorder's own hosts?
  function isOurs(event) {
    if (!tb && !pk) return false;
    var path;
    try {
      path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    } catch (err) {
      path = null;
    }
    if (!path) return false;
    return (tb !== null && path.indexOf(tb.host) !== -1) || (pk !== null && path.indexOf(pk.host) !== -1);
  }

  function isOurHost(el) {
    return !!el && ((tb !== null && el === tb.host) || (pk !== null && el === pk.host));
  }

  // ── Building and mounting ──────────────────────────────────────────────

  function tbBuild() {
    var host = document.createElement(TB_TAG);
    resetHost(host, 'auto');
    var root;
    try {
      root = host.attachShadow({ mode: 'closed' });
    } catch (err) {
      return null;
    }
    var sheet = tbSheetOf(TOOLBAR_CSS);
    if (sheet) {
      try { root.adoptedStyleSheets = [sheet]; } catch (err) { /* no adopted sheets: unstyled, still usable */ }
    }
    try { host.setAttribute('popover', 'manual'); } catch (err) { /* no popover: z-index only */ }

    var wrap = tbEl('div', 'wrap');
    var bar = tbEl('div', 'tb');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Record Steps');
    var main = tbEl('div', 'main');

    var grip = tbButton('grip', 'grip', 'grip', null, 'Drag to move');
    grip.setAttribute('aria-label', 'Move the toolbar');
    var status = tbEl('div', 'status');
    var dot = tbEl('span', 'dot');
    dot.setAttribute('aria-hidden', 'true');
    var rec = tbEl('span', 'rec', 'REC');
    var time = tbEl('span', 'time', '00:00');
    var count = tbEl('span', 'count', '');
    status.appendChild(dot);
    status.appendChild(rec);
    status.appendChild(time);
    status.appendChild(count);

    var pause = tbButton('pause', 'btn', null, null, 'Pause recording (Alt+Shift+P)', 'Alt+Shift+P');
    pause.setAttribute('aria-pressed', 'false');
    var icoPause = tbIcon('pause');
    var icoPlay = tbIcon('play');
    icoPlay.setAttribute('hidden', '');
    var pauseLabel = tbEl('span', 'label', 'Pause');
    pause.appendChild(icoPause);
    pause.appendChild(icoPlay);
    pause.appendChild(pauseLabel);

    var check = tbButton('check', 'btn', 'check', 'Add check',
      'Add check: the next click picks what to verify (Alt+Shift+C)', 'Alt+Shift+C');
    check.setAttribute('aria-pressed', 'false');
    var step = tbButton('step', 'btn', 'step', 'Add step', 'Add a step by hand (Alt+Shift+S)', 'Alt+Shift+S');
    step.setAttribute('aria-pressed', 'false');
    var undo = tbButton('undo', 'btn', 'undo', 'Undo', 'Undo the last action (Alt+Shift+Z)', 'Alt+Shift+Z');
    var stop = tbButton('stop', 'btn stop', 'stop', 'Stop', 'Stop and write the steps');
    var cancel = tbButton('cancel', 'btn quiet', null, null, 'Cancel: end without writing anything');
    cancel.setAttribute('aria-label', 'Cancel recording');
    cancel.appendChild(tbIcon('x', 'x'));
    cancel.appendChild(tbEl('span', 'label', 'Cancel'));
    var minimise = tbButton('minimise', 'btn icon', 'minus', null, 'Minimise (Alt+Shift+M)', 'Alt+Shift+M');
    minimise.setAttribute('aria-label', 'Minimise the toolbar');

    main.appendChild(grip);
    main.appendChild(status);
    main.appendChild(tbSep());
    main.appendChild(pause);
    main.appendChild(check);
    main.appendChild(step);
    main.appendChild(undo);
    main.appendChild(tbSep());
    main.appendChild(stop);
    main.appendChild(cancel);
    main.appendChild(minimise);

    var sub = tbEl('div', 'sub');
    var drawer = tbEl('div', 'drawer');
    drawer.hidden = true;
    var list = tbEl('ol');
    list.setAttribute('aria-label', 'Steps so far');
    drawer.appendChild(list);
    drawer.appendChild(tbEl('p', 'foot', 'Click a step to change it · ✕ removes it · + adds one below'));
    drawer.setAttribute('id', 'aiui-drawer');

    bar.appendChild(main);
    bar.appendChild(sub);
    bar.appendChild(drawer);

    var pill = tbButton('expand', 'pill', null, null, 'Open the toolbar');
    pill.setAttribute('aria-label', 'Record Steps, minimised. Open the toolbar');
    pill.hidden = true;
    var pillDot = tbEl('span', 'dot');
    pillDot.setAttribute('aria-hidden', 'true');
    var pillRec = tbEl('span', 'rec', 'REC');
    var pillTime = tbEl('span', 'time', '00:00');
    var exp = tbEl('span', 'exp');
    exp.setAttribute('aria-hidden', 'true');
    exp.appendChild(tbIcon('up'));
    pill.appendChild(pillDot);
    pill.appendChild(pillRec);
    pill.appendChild(pillTime);
    pill.appendChild(exp);

    var live = tbEl('div', 'sr');
    live.setAttribute('aria-live', 'polite');

    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('class', 'input');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'true');
    input.setAttribute('aria-label', 'Add a step');
    input.setAttribute('aria-describedby', 'aiui-hint');
    input.placeholder = 'Verify the balance shows "$1,234.56"';

    wrap.appendChild(bar);
    wrap.appendChild(pill);
    wrap.appendChild(live);
    root.appendChild(wrap);

    return {
      host: host, root: root, wrap: wrap, bar: bar, main: main, dot: dot, rec: rec, time: time, count: count,
      pause: pause, icoPause: icoPause, icoPlay: icoPlay, pauseLabel: pauseLabel, check: check, step: step,
      undo: undo, stop: stop, cancel: cancel, minimise: minimise, sub: sub, subKey: '', drawer: drawer,
      list: list, listKey: '', pill: pill, pillDot: pillDot, pillRec: pillRec, pillTime: pillTime, live: live,
      input: input, observer: null, watch: null, backstop: 0, clock: 0, topSeen: '', onResize: null,
      onToggle: null, onFullscreen: null,
    };
  }

  /** A text button in the status row: its words are the whole of it, so
   *  they stay when the narrow layout drops the toolbar's labels. */
  function tbMini(cmd, text, cls) {
    var b = tbButton(cmd, cls || 'mini', null, null, null);
    b.textContent = text;
    return b;
  }

  function tbSep() {
    var s = tbEl('span', 'sep');
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  /** Into the top layer — or back to its top, above a dialog or popover the
   *  page opened since. Not while focus is inside the bar: hiding a popover
   *  that holds focus drops the focus, and the step box would lose what is
   *  being typed. */
  function tbToTop() {
    if (!tb || !tb.host.isConnected) return;
    if (tbHasFocus()) return;
    try {
      if (tb.host.matches(':popover-open')) tb.host.hidePopover();
      tb.host.showPopover();
    } catch (err) { /* no popover support: the z-index stands in */ }
  }

  function tbHasFocus() {
    return !!tb && (tb.root.activeElement !== null && tb.root.activeElement !== undefined);
  }

  function tbMount() {
    if (!tb) return false;
    var html = document.documentElement;
    if (!html) return false;
    if (tb.host.parentNode !== html) {
      try { html.appendChild(tb.host); } catch (err) { return false; }
    }
    tbToTop();
    return true;
  }

  /** Other top-layer elements, as a signature: one appearing puts the bar
   *  back on top (the backstop to the toggle events and the observer). */
  function tbTopLayerSignature() {
    try {
      var list = document.querySelectorAll(':modal,:popover-open,:fullscreen');
      var n = 0;
      var names = '';
      for (var i = 0; i < list.length; i++) {
        if (isOurHost(list[i])) continue;
        n++;
        names += (list[i].id || list[i].tagName) + ',';
      }
      return n + ':' + names;
    } catch (err) {
      return '';
    }
  }

  function tbWatch() {
    if (!tb) return;
    // An app that wipes the document (document.open, replacing <html>'s
    // children) gets the bar put back.
    if (typeof MutationObserver === 'function') {
      tb.observer = new MutationObserver(function () {
        if (tb && !tb.host.isConnected) tbMount();
      });
      try { tb.observer.observe(document, { childList: true, subtree: false }); } catch (err) { /* ignore */ }
      if (document.documentElement) {
        try { tb.observer.observe(document.documentElement, { childList: true }); } catch (err) { /* ignore */ }
      }
      // A dialog opened with showModal(), or a popover shown, paints above
      // what entered the top layer before it: the bar goes back on top.
      tb.watch = new MutationObserver(function () {
        setTimeout(tbToTop, 0);
      });
      if (document.documentElement) {
        try {
          tb.watch.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
        } catch (err) { /* ignore */ }
      }
    }
    tb.onToggle = function (event) {
      if (!tb || event.target === tb.host || (pk && event.target === pk.host)) return;
      if (event.newState === 'open') setTimeout(tbToTop, 0);
    };
    tb.onFullscreen = function () { setTimeout(tbToTop, 0); };
    document.addEventListener('toggle', tb.onToggle, true);
    document.addEventListener('fullscreenchange', tb.onFullscreen, true);
    tb.topSeen = tbTopLayerSignature();
    tb.backstop = setInterval(function () {
      if (!tb) return;
      if (!tb.host.isConnected) tbMount();
      var sig = tbTopLayerSignature();
      if (sig !== tb.topSeen) {
        tb.topSeen = sig;
        tbToTop();
      }
    }, 1000);
    tb.clock = setInterval(tbTickClock, 1000);
    tb.onResize = function () { tbRender(); };
    window.addEventListener('resize', tb.onResize, { passive: true });
  }

  function tbRemove() {
    if (!tb) return;
    var t = tb;
    tb = null;
    clearInterval(t.backstop);
    clearInterval(t.clock);
    if (t.observer) t.observer.disconnect();
    if (t.watch) t.watch.disconnect();
    if (t.onToggle) document.removeEventListener('toggle', t.onToggle, true);
    if (t.onFullscreen) document.removeEventListener('fullscreenchange', t.onFullscreen, true);
    if (t.onResize) window.removeEventListener('resize', t.onResize);
    clearTimeout(tbLocal.removeTimer);
    clearTimeout(tbLocal.boxTimer);
    tbLocal.removeTimer = 0;
    tbLocal.box = false;
    tbLocal.confirm = false;
    tbLocal.drawer = false;
    tbLocal.drag = null;
    tbLocal.editing = null;
    tbLocal.overrides = {};
    tbLocal.insertAfter = null;
    try {
      if (t.host.matches(':popover-open')) t.host.hidePopover();
    } catch (err) { /* ignore */ }
    if (t.host.parentNode) t.host.parentNode.removeChild(t.host);
  }

  // ── What the server pushed ─────────────────────────────────────────────

  /**
   * The toolbar block of a push (top frame only). Absent: no toolbar — the
   * recording has none, or this document was told the recording is over.
   */
  function toolbarApply(view) {
    if (!IS_TOP) return;
    if (!view || typeof view !== 'object') {
      tbView = null;
      tbRemove();
      return;
    }
    var prevPhase = tbView ? tbView.phase : '';
    tbView = view;
    tbViewAt = nowMs();
    if (view.phase === 'recording') {
      tbLocal.closedByUser = false;
      clearTimeout(tbLocal.removeTimer);
      tbLocal.removeTimer = 0;
    }
    if (tbLocal.closedByUser) return;
    if (!tb) {
      tb = tbBuild();
      if (!tb) return;
      tbWatch();
      if (window.innerWidth < NARROW_PX) tbLocal.expanded = false;
    }
    if (!tb.host.isConnected && !tbMount()) {
      // No root element yet: the observer on `document` mounts it when there is.
    }
    if (view.phase !== 'recording') {
      tbLocal.box = false;
      tbLocal.confirm = false;
      tbLocal.drawer = false;
      tbLocal.offline = false;
      tbLocal.editing = null;
      tbLocal.overrides = {};
      tbLocal.insertAfter = null;
    }
    // A row this page changed ahead of the server, and the server said yes:
    // this push (or an earlier one) already shows it.
    for (var oid in tbLocal.overrides) {
      if (Object.prototype.hasOwnProperty.call(tbLocal.overrides, oid) && tbLocal.overrides[oid].confirmed) {
        delete tbLocal.overrides[oid];
      }
    }
    if ((view.phase === 'done' || view.phase === 'ended') && !tbLocal.removeTimer) {
      tbLocal.removeTimer = setTimeout(function () {
        tbLocal.removeTimer = 0;
        tbRemove();
      }, END_SHOW_MS);
    }
    var notice = view.notice && typeof view.notice === 'object' ? view.notice : null;
    if (notice) {
      tbLocal.noticeUntil = typeof notice.remainingMs === 'number' ? nowMs() + notice.remainingMs : 0;
      if (notice.seq !== tbLocal.noticeSeq) {
        tbLocal.noticeSeq = notice.seq;
        if (notice.kind === 'added' || notice.kind === 'removed') tbAnnounce(String(notice.text || ''));
      }
    }
    if (!tbLocal.box && typeof view.boxText === 'string') tbLocal.boxText = view.boxText;
    // Announcements a screen reader user would otherwise miss.
    if (state.paused !== tbLocal.lastPaused && view.phase === 'recording') {
      tbAnnounce(state.paused ? 'Recording paused' : 'Recording resumed');
    }
    if (state.pick && !tbLocal.lastPick) tbAnnounce('Add check armed: click what to check.');
    if (view.phase !== prevPhase) {
      if (view.phase === 'writing') tbAnnounce('Writing the steps');
      if (view.phase === 'done' || view.phase === 'ended') tbAnnounce(String(view.endText || 'Done'));
    }
    tbLocal.lastPaused = state.paused;
    tbLocal.lastPick = state.pick;
    tbLocal.lastPhase = view.phase;
    tbRender();
  }

  function tbAnnounce(message) {
    if (!tb) return;
    var live = tb.live;
    live.textContent = '';
    setTimeout(function () { live.textContent = message; }, 30);
  }

  function tbElapsed() {
    if (!tbView) return 0;
    var base = typeof tbView.elapsedMs === 'number' ? tbView.elapsedMs : 0;
    var running = tbView.running === true && tbView.phase === 'recording' && !state.paused;
    return base + (running ? Math.max(0, nowMs() - tbViewAt) : 0);
  }

  function tbClockText() {
    var total = Math.floor(tbElapsed() / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function tbTickClock() {
    if (!tb || !tbView) return;
    var t = tbClockText();
    tb.time.textContent = t;
    tb.pillTime.textContent = t;
    // A timed message that ran out gives the row back to the last step.
    if (tbLocal.noticeUntil && nowMs() >= tbLocal.noticeUntil) {
      tbLocal.noticeUntil = 0;
      tbRender();
    }
  }

  function tbDock() {
    var d = tbView && typeof tbView.dock === 'string' && DOCKS[tbView.dock] ? tbView.dock : 'bc';
    return d;
  }

  function tbNarrow() {
    return window.innerWidth < NARROW_PX;
  }

  function tbMinimised() {
    if (!tbView) return false;
    if (tbView.phase !== 'recording') return false;
    if (tbLocal.box || tbLocal.confirm) return false;
    return tbView.minimised === true || (tbNarrow() && !tbLocal.expanded);
  }

  function tbPlace() {
    if (!tb || tbLocal.drag) return;
    var d = tbDock();
    var host = tb.host;
    important(host, 'top', d.charAt(0) === 't' ? '16px' : 'auto');
    important(host, 'bottom', d.charAt(0) === 'b' ? '16px' : 'auto');
    if (d.charAt(1) === 'l') {
      important(host, 'left', '16px');
      important(host, 'right', 'auto');
      important(host, 'transform', 'none');
    } else if (d.charAt(1) === 'r') {
      important(host, 'left', 'auto');
      important(host, 'right', '16px');
      important(host, 'transform', 'none');
    } else {
      important(host, 'left', '50%');
      important(host, 'right', 'auto');
      important(host, 'transform', 'translateX(-50%)');
    }
    important(host, 'width', 'max-content');
    important(host, 'height', 'auto');
    important(host, 'max-width', 'calc(100vw - 32px)');
    tb.wrap.setAttribute('data-edge', d.charAt(0) === 'b' ? 'bottom' : 'top');
  }

  function tbNotice() {
    var n = tbView && tbView.notice && typeof tbView.notice === 'object' ? tbView.notice : null;
    if (!n) return null;
    if (tbLocal.noticeUntil && nowMs() >= tbLocal.noticeUntil) return null;
    return n;
  }

  function tbWritingNotice() {
    var n = tbNotice();
    return n && n.kind === 'error' ? n : null;
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function tbRender() {
    if (!tb || !tbView) return;
    var v = tbView;
    var phase = v.phase;
    var closed = phase !== 'recording';
    var paused = !closed && state.paused;
    var pick = !closed && state.pick;
    var offline = !closed && tbLocal.offline;
    // While writing, a warning still shows beside "Writing the steps…" (a
    // step that came after Stop); a confirmation does not.
    var notice = !closed ? tbNotice() : phase === 'writing' ? tbWritingNotice() : null;
    // Once it is not recording the bar is only something to read: the page
    // under it takes every click — Close apart (a style in the sheet) — so a
    // run started straight after, or the author, never clicks the bar instead.
    important(tb.host, 'pointer-events', closed ? 'none' : 'auto');

    var kind = paused ? 'paused' : phase === 'writing' ? 'writing' : phase === 'done' ? 'done'
      : phase === 'ended' ? 'ended' : offline ? 'offline' : 'rec';
    var ring = pick ? 'pick' : paused ? 'paused' : (offline || (notice && notice.kind === 'error')) ? 'warn'
      : phase === 'done' ? 'done' : (phase === 'writing' || phase === 'ended') ? 'none' : 'rec';
    var word = { rec: 'REC', paused: 'PAUSED', writing: 'WRITING', done: 'DONE', ended: 'ENDED', offline: 'REC' }[kind];

    tb.bar.setAttribute('data-ring', ring);
    tb.pill.setAttribute('data-ring', ring);
    tb.dot.setAttribute('data-kind', kind);
    tb.rec.setAttribute('data-kind', kind);
    tb.rec.textContent = word;
    tb.pillDot.setAttribute('data-kind', kind);
    tb.pillRec.setAttribute('data-kind', pick ? 'pick' : kind);
    tb.pillRec.textContent = pick ? 'PICK…' : word;
    var clock = tbClockText();
    tb.time.textContent = clock;
    tb.pillTime.textContent = clock;
    var n = typeof v.actions === 'number' ? v.actions : 0;
    tb.count.textContent = '· ' + n + ' action' + (n === 1 ? '' : 's');

    tb.pause.setAttribute('aria-pressed', String(paused));
    tb.pauseLabel.textContent = paused ? 'Resume' : 'Pause';
    tb.pause.title = paused ? 'Resume recording (Alt+Shift+P)' : 'Pause recording (Alt+Shift+P)';
    if (paused) {
      tb.icoPause.setAttribute('hidden', '');
      tb.icoPlay.removeAttribute('hidden');
    } else {
      tb.icoPlay.setAttribute('hidden', '');
      tb.icoPause.removeAttribute('hidden');
    }
    tb.check.setAttribute('aria-pressed', String(pick));
    tb.check.title = paused ? 'Resume to add a check' : 'Add check: the next click picks what to verify (Alt+Shift+C)';
    tb.step.setAttribute('aria-pressed', String(tbLocal.box));
    var buttons = [tb.pause, tb.step, tb.undo, tb.stop, tb.cancel];
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = closed;
    tb.check.disabled = closed || paused;

    tbRenderSub(v, closed, paused, pick, offline, notice);
    var showDrawer = tbLocal.drawer && !closed && !tbLocal.box && !tbLocal.confirm;
    // An edit in place ends when its row can no longer be seen: nothing saved.
    if (!showDrawer && tbLocal.editing) {
      tbLocal.editing = null;
      tb.listKey = '';
    }
    tb.drawer.hidden = !showDrawer;
    if (showDrawer) tbRenderDrawer(v);

    var min = tbMinimised();
    tb.bar.hidden = min;
    tb.pill.hidden = !min;
    tbPlace();
  }

  function tbOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /**
   * The drawer's rows, in order: each step of the draft (numbered), and each
   * step deleted since the last one landed, struck through where it was —
   * with what this page did ahead of the server's answer applied on top: an
   * edit shows its new words, a delete strikes the row at once, a Restore
   * un-strikes it.
   */
  function tbDrawerRows(v) {
    var steps = Array.isArray(v.steps) ? v.steps : [];
    var deleted = Array.isArray(v.deleted) ? v.deleted : [];
    var ov = tbLocal.overrides;
    var rows = [];
    var seen = {};
    var n = 0;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i] && typeof steps[i] === 'object' ? steps[i] : {};
      var id = typeof s.id === 'string' ? s.id : '';
      var o = id && tbOwn(ov, id) ? ov[id] : null;
      if (id) seen[id] = true;
      if (o && o.deleted) {
        rows.push({ kind: 'deleted', id: id, text: String(s.text || ''), index: i });
        continue;
      }
      n++;
      var edited = o && typeof o.text === 'string';
      rows.push({
        kind: 'live', id: id, n: n, index: i,
        text: edited ? o.text : String(s.text || ''),
        yours: s.yours === true || !!edited,
      });
    }
    for (var d = 0; d < deleted.length; d++) {
      var row = deleted[d] && typeof deleted[d] === 'object' ? deleted[d] : null;
      if (!row || typeof row.id !== 'string' || seen[row.id]) continue;
      seen[row.id] = true;
      var back = tbOwn(ov, row.id) && ov[row.id].restored;
      var at = rows.length;
      if (row.afterId === null) {
        at = 0;
      } else {
        for (var k = 0; k < rows.length; k++) {
          if (rows[k].id === row.afterId) {
            at = k + 1;
            break;
          }
        }
      }
      rows.splice(at, 0, { kind: back ? 'restoring' : 'deleted', id: row.id, text: String(row.text || '') });
    }
    return rows;
  }

  function tbLiveRows(v) {
    return tbDrawerRows(v).filter(function (r) { return r.kind === 'live'; });
  }

  function tbToggleButton() {
    var t = tbButton('drawer', 'toggle', null, null, null);
    t.appendChild(tbEl('span', null, 'Steps so far'));
    t.appendChild(tbIcon('chev'));
    t.setAttribute('aria-expanded', String(tbLocal.drawer));
    t.setAttribute('aria-controls', 'aiui-drawer');
    return t;
  }

  /** The status row. Rebuilt only when what it shows changes — and never
   *  while the step box is in it, which would take the caret away. */
  function tbRenderSub(v, closed, paused, pick, offline, notice) {
    var parts = [];
    var mode;
    if (v.phase === 'writing') {
      mode = 'writing';
      parts.push(notice ? notice.text : '');
    } else if (v.phase === 'done' || v.phase === 'ended') {
      mode = 'end';
      parts.push(v.endKind, v.endText);
    } else if (tbLocal.confirm) {
      mode = 'confirm';
    } else if (tbLocal.box) {
      mode = 'box';
      parts.push(tbLocal.insertAfter ? tbLocal.insertAfter.n : 0);
    } else if (offline) {
      mode = 'offline';
    } else if (pick) {
      mode = 'pick';
    } else if (notice && (notice.kind !== 'error' || !paused)) {
      // A confirmation (Added…, Removed…, Adding…) shows for its moment even
      // while paused — Undo and Add step work then; an error waits for Resume.
      // Above "Typing hidden": a Removed… with its Restore lasts seconds, the
      // chip as long as focus stays in the field.
      mode = 'notice';
      parts.push(notice.kind, notice.text, notice.restore === true, notice.seq);
    } else if (paused) {
      mode = 'paused';
      parts.push(tbLocal.drawer);
    } else if (v.typingHidden === true) {
      mode = 'secret';
    } else {
      mode = 'last';
      var live = tbLiveRows(v);
      var last = live.length ? live[live.length - 1] : null;
      parts.push(live.length, last ? last.text : '', last ? last.yours : '', v.updating === true, tbLocal.drawer);
    }
    var key = mode + '|' + JSON.stringify(parts);
    if (key === tb.subKey) return;
    // The box is not rebuilt under the caret — unless a row's + has just
    // aimed it somewhere else.
    if (tb.subKey.indexOf('box|') === 0 && mode === 'box' && !tbLocal.boxRetarget) return;
    tbLocal.boxRetarget = false;
    tb.subKey = key;
    var sub = tb.sub;
    // A control of this row that has keyboard focus keeps it through the
    // rebuild (the Steps so far toggle, pressed with Enter).
    var had = tb.root.activeElement;
    var keepCmd = had && had !== tb.input && sub.contains(had) ? had.getAttribute('data-cmd') : null;
    while (sub.firstChild) sub.removeChild(sub.firstChild);
    var add = function (node) { sub.appendChild(node); return node; };
    var ico = function (name, cls) {
      var s = tbEl('span', 'ico ' + cls);
      s.appendChild(tbIcon(name));
      return s;
    };
    switch (mode) {
      case 'writing': {
        var spin = add(tbEl('span', 'spin'));
        spin.setAttribute('aria-hidden', 'true');
        add(tbEl('span', notice ? null : 'msg', 'Writing the steps…'));
        if (notice) {
          add(ico('warn', 'warn'));
          add(tbEl('span', 'msg warn', String(notice.text || '')));
        }
        break;
      }
      case 'end':
        if (v.endKind === 'done') add(ico('tick', 'ok'));
        add(tbEl('span', 'msg', String(v.endText || '')));
        add(tbMini('close', 'Close'));
        break;
      case 'confirm':
        add(tbEl('span', 'msg', "Discard this recording? The steps won't be written."));
        add(tbMini('discard', 'Discard', 'mini danger'));
        add(tbMini('keep', 'Keep recording'));
        break;
      case 'box': {
        add(tb.input);
        add(tbMini('add', 'Add'));
        var target = tbLocal.insertAfter;
        var hint = add(tbEl('span', 'hint',
          (target ? 'Goes after step ' + target.n + ' · ' : '') + 'Enter to add · Esc to close'));
        hint.setAttribute('id', 'aiui-hint');
        break;
      }
      case 'offline':
        add(ico('warn', 'warn'));
        add(tbEl('span', 'msg warn', "The recorder isn't answering. What you do now may not be recorded."));
        break;
      case 'pick': {
        var msg = add(tbEl('span', 'msg pick', 'Click what to check. '));
        msg.appendChild(tbEl('kbd', null, 'Esc'));
        msg.appendChild(document.createTextNode(' to cancel.'));
        break;
      }
      case 'secret': {
        var chip = add(tbEl('span', 'chip'));
        chip.appendChild(tbIcon('lock'));
        chip.appendChild(document.createTextNode('Typing hidden'));
        add(tbEl('span', 'msg dim', 'The value stays in this browser.'));
        break;
      }
      case 'notice':
        if (notice.kind === 'added') add(ico('tick', 'ok'));
        if (notice.kind === 'error') add(ico('warn', 'warn'));
        if (notice.kind === 'adding') {
          var s2 = add(tbEl('span', 'spin'));
          s2.setAttribute('aria-hidden', 'true');
        }
        add(tbEl('span', notice.kind === 'error' ? 'msg warn' : 'msg', String(notice.text || '')));
        if (notice.restore === true) add(tbMini('restore', 'Restore'));
        break;
      case 'paused':
        add(tbEl('span', 'msg', 'Paused. Nothing you do is recorded.'));
        add(tbToggleButton());
        break;
      default: {
        // The last step as the drawer has it. No lock: nothing is locked
        // against the author (stories/testbench-record-edit-steps.md).
        var list = tbLiveRows(v);
        if (list.length === 0) {
          add(tbEl('span', 'msg dim', 'No steps yet. They appear here as you work.'));
        } else {
          var last2 = list[list.length - 1];
          add(tbEl('span', 'n', String(list.length)));
          add(tbEl('span', 't', String(last2.text || '')));
          if (last2.yours === true) add(tbEl('span', 'yours', 'yours'));
        }
        if (v.updating === true) add(tbEl('span', 'upd', 'updating…'));
        add(tbToggleButton());
      }
    }
    if (keepCmd) {
      var again = sub.querySelector('[data-cmd="' + keepCmd + '"]');
      if (again) {
        try { again.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
      }
    }
  }

  /** A small button on a drawer row. Out of the page's Tab order like every
   *  button of the bar; Tab inside the bar reaches it. */
  function tbRowButton(cmd, cls, icon, id, label) {
    var b = tbButton(cmd, cls, icon, null, label);
    b.setAttribute('data-id', id);
    b.setAttribute('aria-label', label);
    return b;
  }

  /**
   * The Steps so far drawer: every step, editable and deletable in place,
   * with a + in the gap below each to add one there, and the steps deleted
   * since the last one landed, struck through, with Restore
   * (stories/testbench-record-edit-steps.md, "The drawer"). Not rebuilt while
   * a step is being edited in it — that would take the caret away.
   */
  function tbRenderDrawer(v) {
    if (tbLocal.editing) return;
    var rows = tbDrawerRows(v);
    var key = JSON.stringify([rows, v.updating === true]);
    if (key === tb.listKey) return;
    tb.listKey = key;
    // Keyboard focus stays on the same row, or the same button of it.
    var had = tb.root.activeElement;
    var keep = had && tb.list.contains(had)
      ? { id: had.getAttribute('data-row-id') || had.getAttribute('data-id'), cmd: had.getAttribute('data-cmd') }
      : null;
    var list = tb.list;
    while (list.firstChild) list.removeChild(list.firstChild);
    var liveCount = 0;
    for (var c = 0; c < rows.length; c++) if (rows[c].kind === 'live') liveCount++;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var li = tbEl('li', 'row ' + r.kind + (r.kind === 'live' && r.n === liveCount ? ' last' : ''));
      li.tabIndex = -1;
      li.setAttribute('data-row-id', r.id);
      li.appendChild(tbEl('span', 'n', r.kind === 'live' ? String(r.n) : ''));
      var t = li.appendChild(tbEl('span', 't', r.text));
      if (r.kind === 'live') {
        t.setAttribute('data-cmd', 'row-edit');
        t.setAttribute('data-id', r.id);
        t.title = 'Click to change this step';
        li.setAttribute('aria-label', 'Step ' + r.n + ': ' + r.text + (r.yours ? ' (yours)' : ''));
        if (r.yours) li.appendChild(tbEl('span', 'yours', 'yours'));
        li.appendChild(tbRowButton('row-delete', 'rb', 'xs', r.id, 'Remove step ' + r.n));
      } else if (r.kind === 'deleted') {
        li.setAttribute('aria-label', 'Removed: ' + r.text);
        var restore = tbMini('row-restore', 'Restore');
        restore.setAttribute('data-id', r.id);
        restore.setAttribute('aria-label', 'Restore "' + r.text + '"');
        li.appendChild(restore);
      }
      list.appendChild(li);
      if (r.kind === 'live') {
        var gap = tbEl('li', 'gap');
        gap.appendChild(tbRowButton('row-insert', 'ins', 'plus', r.id, 'Add a step after step ' + r.n));
        list.appendChild(gap);
      }
    }
    if (v.updating === true) {
      var pending = tbEl('li', 'row pending');
      pending.appendChild(tbEl('span', 'n', String(liveCount + 1)));
      pending.appendChild(tbEl('span', 't', 'updating…'));
      list.appendChild(pending);
    }
    if (keep && keep.id) {
      var back = tbDrawerFind(keep.id, keep.cmd) || tbDrawerFind(keep.id, null);
      if (back) tbFocusIn(back);
    }
  }

  /** A drawer row by its step id — or, given `cmd`, that button of it. */
  function tbDrawerFind(id, cmd) {
    var all = tb.list.querySelectorAll(cmd ? '[data-cmd]' : 'li.row');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (cmd) {
        if (el.getAttribute('data-cmd') === cmd && el.getAttribute('data-id') === id) return el;
      } else if (el.getAttribute('data-row-id') === id) {
        return el;
      }
    }
    return null;
  }

  /** Focus an element of the drawer, scrolled into the drawer's view (not
   *  the page's: the bar is fixed, and the page must not move). */
  function tbFocusIn(el) {
    try { el.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    var row = el.closest ? el.closest('li') : null;
    var d = tb.drawer;
    if (!row || !d) return;
    if (row.offsetTop < d.scrollTop) d.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > d.scrollTop + d.clientHeight) {
      d.scrollTop = row.offsetTop + row.offsetHeight - d.clientHeight;
    }
  }

  /** Every place Tab stops in the bar: its buttons, then the status row's,
   *  then the drawer's rows and their buttons, in order. */
  function tbFocusStops() {
    var out = [];
    var add = function (list) {
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.disabled || el.hidden) continue;
        if (el.closest && el.closest('[hidden]')) continue;
        out.push(el);
      }
    };
    add(tb.main.querySelectorAll('button'));
    add(tb.sub.querySelectorAll('button, input'));
    if (!tb.drawer.hidden) add(tb.list.querySelectorAll('li.row:not(.pending), button'));
    return out;
  }

  // ── Editing, deleting and inserting in the drawer ──────────────────────

  /** Edit a step in place: its text becomes a box. Enter saves (an empty
   *  save is a delete), Esc cancels. */
  function tbStartEdit(id, viaKeyboard) {
    if (!tb || !tbView || tbView.phase !== 'recording' || tbLocal.editing) return;
    var row = null;
    var rows = tbLiveRows(tbView);
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) row = rows[i];
    var li = tbDrawerFind(id, null);
    var span = li ? li.querySelector('.t') : null;
    if (!row || !li || !span) return;
    if (!tbHasFocus()) tbLocal.returnFocus = tbPageFocus();
    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('class', 'rowedit');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'true');
    input.setAttribute('aria-label', 'Change step ' + row.n + '. Enter saves, Esc cancels; empty removes it.');
    input.value = row.text;
    tbLocal.editing = { id: id, input: input, viaKeyboard: !!viaKeyboard, original: row.text, n: row.n };
    li.replaceChild(input, span);
    try {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    } catch (err) { /* ignore */ }
  }

  function tbFinishEdit(save) {
    var e = tbLocal.editing;
    if (!e || !tb) return;
    tbLocal.editing = null;
    tb.listKey = '';
    var text = e.input.value;
    if (save) {
      if (!/\S/.test(text)) tbDeleteRow(e.id);
      else if (text.trim() !== e.original.trim()) tbEditRow(e.id, text, e.n);
    }
    tbRender();
    if (e.viaKeyboard) {
      var li = tbDrawerFind(e.id, null);
      if (li) tbFocusIn(li);
      else tbGiveFocusBack();
    } else {
      tbGiveFocusBack();
    }
  }

  /**
   * Send a drawer change the row already shows. The server's yes keeps it
   * until a push shows the same; anything else takes it back — to the state
   * the refusal carries, or to what the server last pushed (the pattern of
   * `sendOptimistic`, per row).
   */
  function tbRowSend(message, id, change) {
    tbLocal.overrides[id] = change;
    var done = false;
    var timer = 0;
    var finish = function (answer) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // A newer change to the same row has taken over.
      if (tbLocal.overrides[id] !== change) return;
      if (answer && answer.ok === true) {
        change.confirmed = true;
        return;
      }
      delete tbLocal.overrides[id];
      if (answer && answer.state && typeof answer.state === 'object') {
        applyState(answer.state);
      } else if (tb) {
        tb.listKey = '';
        tbRender();
      }
    };
    timer = setTimeout(function () { finish(null); }, COMMAND_ANSWER_MS);
    void sendCmd(message).then(finish, function () { finish(null); });
    if (tb) {
      tb.listKey = '';
      tbRender();
    }
  }

  function tbEditRow(id, text, n) {
    tbRowSend({ type: 'edit-step', id: id, text: text.slice(0, 4000) }, id, { text: text, confirmed: false });
    tbAnnounce('Step ' + n + ' changed');
  }

  function tbDeleteRow(id) {
    // The ✕ of the row being edited: the edit ends, unsaved — the step goes.
    var wasEditing = !!tbLocal.editing && tbLocal.editing.id === id;
    if (wasEditing) tbLocal.editing = null;
    tbRowSend({ type: 'toolbar', command: 'delete-step', id: id }, id, { deleted: true, confirmed: false });
    if (wasEditing) tbGiveFocusBack();
    tbAnnounce('Step removed');
  }

  function tbRestoreRow(id) {
    tbRowSend({ type: 'toolbar', command: 'restore-step', id: id }, id, { restored: true, confirmed: false });
    tbAnnounce('Step restored');
  }

  /** A row's +: the Add step box, aimed at the place below that row. */
  function tbInsertAt(id) {
    if (!tbView) return;
    var rows = tbLiveRows(tbView);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id !== id) continue;
      tbLocal.insertAfter = {
        id: id,
        index: rows[i].index,
        revision: typeof tbView.revision === 'number' ? tbView.revision : undefined,
        n: rows[i].n,
      };
      tbLocal.boxRetarget = true;
      tbOpenBox(true);
      return;
    }
  }

  // ── Using it ───────────────────────────────────────────────────────────

  /** The element in the bar at a point: the root is ours, so it can be
   *  asked even though the page cannot look in. */
  function tbAt(x, y) {
    try {
      return typeof tb.root.elementFromPoint === 'function' ? tb.root.elementFromPoint(x, y) : null;
    } catch (err) {
      return null;
    }
  }

  function tbCmdOf(el) {
    for (var n = el; n && n !== tb.root; n = n.parentNode) {
      if (n.nodeType === 1 && n.hasAttribute('data-cmd')) return n;
    }
    return null;
  }

  /** The page element that had focus — never the bar's host. */
  function tbPageFocus() {
    var el = document.activeElement;
    if (!el || (tb && el === tb.host) || el === document.body || el === document.documentElement) return null;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function tbGiveFocusBack() {
    var el = tbLocal.returnFocus;
    tbLocal.returnFocus = null;
    if (tb) {
      var inside = tb.root.activeElement;
      if (inside && typeof inside.blur === 'function') inside.blur();
    }
    if (el && el.isConnected && typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }
  }

  function tbFirstButton() {
    var candidates = [tb.pause, tb.check, tb.step, tb.undo, tb.stop, tb.cancel, tb.minimise];
    for (var i = 0; i < candidates.length; i++) if (!candidates[i].disabled) return candidates[i];
    return tb.minimise;
  }

  function tbFocusBar() {
    if (!tb || !tbView) return;
    if (!tbHasFocus()) tbLocal.returnFocus = tbPageFocus();
    if (tbMinimised()) {
      tbSetMinimised(false);
    }
    try { tbFirstButton().focus({ preventScroll: true }); } catch (err) { /* ignore */ }
  }

  /** Open the Add step box — at the end of the steps, or (`aimed`) where a
   *  drawer row's + put it. */
  function tbOpenBox(aimed) {
    if (!tb || !tbView || tbView.phase !== 'recording') return;
    if (!tbHasFocus()) tbLocal.returnFocus = tbPageFocus();
    if (!aimed && tbLocal.insertAfter) {
      tbLocal.insertAfter = null;
      tbLocal.boxRetarget = true;
    }
    tbLocal.confirm = false;
    tbLocal.expanded = true;
    if (!tbLocal.box) {
      tbLocal.box = true;
      tb.input.value = tbLocal.boxText || '';
    }
    tbRender();
    try {
      tb.input.focus({ preventScroll: true });
      var end = tb.input.value.length;
      tb.input.setSelectionRange(end, end);
    } catch (err) { /* ignore */ }
  }

  function tbCloseBox() {
    if (!tb) return;
    tbLocal.boxText = tb.input.value;
    tbLocal.box = false;
    tbLocal.insertAfter = null;
    tbGiveFocusBack();
    tbRender();
  }

  function tbSubmitBox() {
    if (!tb) return;
    var text = tb.input.value;
    if (!/\S/.test(text)) {
      try { tb.input.focus(); } catch (err) { /* ignore */ }
      return;
    }
    clearTimeout(tbLocal.boxTimer);
    // Where it goes: after the row whose + opened the box — by that step's
    // id, and the index and draft it had, for when the model has since
    // rewritten it — else at the end.
    var target = tbLocal.insertAfter;
    var message = { type: 'step', text: text.slice(0, 4000) };
    if (target) {
      message.afterId = target.id;
      message.afterStep = target.index;
      if (typeof target.revision === 'number') message.revision = target.revision;
    }
    // Not taken: the text goes back into the box for the next time it opens
    // (a step refused because Stop came first is said by the server instead).
    sendOptimistic(message, function () {
      if (!tbLocal.box && tbLocal.boxText === '') tbLocal.boxText = text;
    });
    tb.input.value = '';
    tbLocal.boxText = '';
    tbLocal.box = false;
    tbLocal.insertAfter = null;
    tbGiveFocusBack();
    tbRender();
  }

  function tbBoxInput() {
    if (!tb || tb.root.activeElement !== tb.input) return;
    clearTimeout(tbLocal.boxTimer);
    var value = tb.input.value;
    tbLocal.boxTimer = setTimeout(function () {
      void sendCmd({ type: 'box-text', text: value.slice(0, 4000) });
    }, BOX_TEXT_MS);
  }

  function tbSetMinimised(min) {
    if (!tbView) return;
    if (!min) tbLocal.expanded = true;
    // Written into the local copy at once; the server's next push says the same.
    var view = tbView;
    var was = view.minimised;
    view.minimised = min;
    tbRender();
    sendOptimistic({ type: 'toolbar', command: 'minimise', minimised: min }, function () {
      if (tbView !== view) return;
      view.minimised = was;
      tbRender();
    });
    tbAnnounce(min ? 'Toolbar minimised' : 'Toolbar opened');
  }

  // ── Commands shown before the server agrees ────────────────────────────

  /**
   * Send a command whose effect this page shows at once, before the server
   * agrees (Pause, minimise, a dock, Esc out of pick mode, a step leaving the
   * box). Anything but `{ ok: true }` takes the change back: a refusal that
   * carries the state gets that state; no answer — none in time, a document
   * with no token, a message the server did not take as this document's —
   * puts back what the page had, unless the server has sent a state since,
   * which already said what is true. Without this a Pause the server never
   * took left the bar saying Paused, and the page recording nothing, for good.
   */
  function sendOptimistic(message, revert) {
    var seq = serverSeq;
    var done = false;
    var timer = 0;
    var finish = function (answer) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (answer && answer.ok === true) return;
      if (answer && answer.state && typeof answer.state === 'object') {
        applyState(answer.state);
        return;
      }
      if (serverSeq === seq) revert();
    };
    timer = setTimeout(function () { finish(null); }, COMMAND_ANSWER_MS);
    void sendCmd(message).then(finish, function () { finish(null); });
  }

  /** Pause here, now: typing still open is reported first, and from this
   *  moment nothing more is — before the server's push confirms it. */
  function pauseLocally() {
    settleEnter();
    flushAllExcept(null);
    var was = { paused: state.paused, pick: state.pick };
    state.paused = true;
    state.pick = false;
    pickApply();
    sendOptimistic({ type: 'toolbar', command: 'pause' }, function () {
      state.paused = was.paused;
      state.pick = state.recording && !state.paused && was.pick;
      pickApply();
      if (IS_TOP) tbRender();
    });
  }

  function tbCommand(cmd, el) {
    if (cmd === 'close') {
      tbLocal.closedByUser = true;
      tbRemove();
      return;
    }
    if (!tbView || tbView.phase !== 'recording') return;
    var id = el && el.getAttribute ? el.getAttribute('data-id') : null;
    switch (cmd) {
      case 'row-edit':
        if (id) tbStartEdit(id, false);
        break;
      case 'row-delete':
        if (id) tbDeleteRow(id);
        break;
      case 'row-restore':
        if (id) tbRestoreRow(id);
        break;
      case 'row-insert':
        if (id) tbInsertAt(id);
        break;
      case 'pause':
        if (state.paused) void sendCmd({ type: 'toolbar', command: 'resume' });
        else pauseLocally();
        tbRender();
        break;
      case 'check':
        if (state.paused) return;
        settleEnter();
        flushAllExcept(null);
        void sendCmd({ type: 'toolbar', command: state.pick ? 'cancel-check' : 'check' });
        break;
      case 'step':
        if (tbLocal.box) tbCloseBox();
        else tbOpenBox();
        break;
      case 'add':
        tbSubmitBox();
        break;
      case 'undo':
        settleEnter();
        flushAllExcept(null);
        void sendCmd({ type: 'toolbar', command: 'undo' });
        break;
      case 'restore':
        void sendCmd({ type: 'toolbar', command: 'restore' });
        break;
      case 'stop':
        settleEnter();
        flushAllExcept(null);
        void sendCmd({ type: 'toolbar', command: 'stop' });
        break;
      case 'cancel':
        tbLocal.confirm = true;
        tbLocal.box = false;
        tbRender();
        break;
      case 'discard':
        tbLocal.confirm = false;
        void sendCmd({ type: 'toolbar', command: 'cancel' });
        tbRender();
        break;
      case 'keep':
        tbLocal.confirm = false;
        tbRender();
        break;
      case 'minimise':
        tbSetMinimised(true);
        break;
      case 'expand':
        tbSetMinimised(false);
        break;
      case 'drawer':
        tbLocal.drawer = !tbLocal.drawer;
        tbRender();
        break;
    }
  }

  function tbNearestDock(cx, cy) {
    var col = cx < window.innerWidth / 3 ? 'l' : (cx > window.innerWidth * 2 / 3 ? 'r' : 'c');
    var row = cy < window.innerHeight / 2 ? 't' : 'b';
    return row + col;
  }

  function tbSetDock(dock) {
    if (!tbView || !DOCKS[dock]) return;
    var view = tbView;
    var was = view.dock;
    view.dock = dock;
    tbRender();
    sendOptimistic({ type: 'toolbar', command: 'dock', dock: dock }, function () {
      if (tbView !== view) return;
      view.dock = was;
      tbRender();
    });
  }

  function tbDragStart(event, handle) {
    var r = tb.host.getBoundingClientRect();
    tbLocal.drag = {
      id: event.pointerId, handle: handle, sx: event.clientX, sy: event.clientY,
      ox: event.clientX - r.left, oy: event.clientY - r.top, x: r.left, y: r.top, moved: false,
    };
    try { tb.host.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
  }

  function tbDragMove(event) {
    var d = tbLocal.drag;
    if (!d || event.pointerId !== d.id) return;
    if (!d.moved) {
      if (Math.abs(event.clientX - d.sx) + Math.abs(event.clientY - d.sy) < 4) return;
      d.moved = true;
      tb.wrap.classList.add('dragging');
    }
    var w = tb.host.offsetWidth;
    var h = tb.host.offsetHeight;
    d.x = Math.min(Math.max(8, event.clientX - d.ox), Math.max(8, window.innerWidth - w - 8));
    d.y = Math.min(Math.max(8, event.clientY - d.oy), Math.max(8, window.innerHeight - h - 8));
    important(tb.host, 'left', d.x + 'px');
    important(tb.host, 'top', d.y + 'px');
    important(tb.host, 'right', 'auto');
    important(tb.host, 'bottom', 'auto');
    important(tb.host, 'transform', 'none');
  }

  function tbDragEnd(event) {
    var d = tbLocal.drag;
    if (!d || (event.pointerId !== undefined && event.pointerId !== d.id)) return;
    tbLocal.drag = null;
    try { tb.host.releasePointerCapture(d.id); } catch (err) { /* ignore */ }
    tb.wrap.classList.remove('dragging');
    if (!d.moved) return;
    tbLocal.suppressClick = true;
    setTimeout(function () { tbLocal.suppressClick = false; }, 0);
    // Docked by where the pointer let go: the bar can be wider than a third
    // of the window, and then its middle never reaches the left or right third.
    // (A cancelled pointer has no place of its own: the bar's middle then.)
    var released = event.type === 'pointerup';
    var x = released ? event.clientX : d.x + tb.host.offsetWidth / 2;
    var y = released ? event.clientY : d.y + tb.host.offsetHeight / 2;
    tbSetDock(tbNearestDock(x, y));
    tbAnnounce('Toolbar moved');
  }

  var GRIP_MOVES = {
    ArrowUp: function (d) { return 't' + d.charAt(1); },
    ArrowDown: function (d) { return 'b' + d.charAt(1); },
    ArrowLeft: function (d) { return d.charAt(0) + ({ r: 'c', c: 'l', l: 'l' })[d.charAt(1)]; },
    ArrowRight: function (d) { return d.charAt(0) + ({ l: 'c', c: 'r', r: 'r' })[d.charAt(1)]; },
  };

  function tbRovingButtons() {
    var all = tb.main.querySelectorAll('button');
    var out = [];
    for (var i = 0; i < all.length; i++) if (!all[i].disabled) out.push(all[i]);
    return out;
  }

  function tbKey(event) {
    var active = tb.root.activeElement;
    if (active === tb.input) {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        // Its keyup lands wherever focus went back to: the page's, not heard.
        swallowKeyUp = event.code;
        tbSubmitBox();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        swallowKeyUp = event.code;
        tbCloseBox();
      }
      // Every other key types into the box: its default action is untouched.
      return;
    }
    if (tbLocal.editing && active === tbLocal.editing.input) {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        swallowKeyUp = event.code;
        tbFinishEdit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        swallowKeyUp = event.code;
        tbFinishEdit(false);
      } else if (event.key === 'Tab') {
        // Stays in the edit: Enter or Esc ends it.
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      swallowKeyUp = event.code;
      if (tbLocal.confirm) {
        tbLocal.confirm = false;
        tbRender();
      }
      tbGiveFocusBack();
      return;
    }
    var cmd = active && active.getAttribute ? active.getAttribute('data-cmd') : null;
    if (cmd === 'grip' && GRIP_MOVES[event.key]) {
      event.preventDefault();
      tbSetDock(GRIP_MOVES[event.key](tbDock()));
      try { active.focus(); } catch (err) { /* ignore */ }
      return;
    }
    if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && tb.main.contains(active)) {
      var list = tbRovingButtons();
      var i = list.indexOf(active);
      if (i < 0) return;
      event.preventDefault();
      var next = list[(i + (event.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
      try { next.focus(); } catch (err) { /* ignore */ }
      return;
    }
    // The drawer: Enter (or F2) changes the focused step, Delete removes it,
    // Up and Down move from row to row.
    if (active && tb.list.contains(active)) {
      var li = active.closest ? active.closest('li') : null;
      var rowId = active.getAttribute('data-row-id');
      var live = rowId !== null && active.classList.contains('live');
      if (live && (event.key === 'Enter' || event.key === 'F2')) {
        event.preventDefault();
        swallowKeyUp = event.code;
        tbStartEdit(rowId, true);
        return;
      }
      if (live && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        swallowKeyUp = event.code;
        tbDeleteRow(rowId);
        return;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && li) {
        var rows = Array.prototype.slice.call(tb.list.querySelectorAll('li.row:not(.pending)'));
        var down = event.key === 'ArrowDown';
        var from = rows.indexOf(li);
        if (from < 0) {
          // A gap's +: the row above it, or the one below.
          var sib = down ? li.nextElementSibling : li.previousElementSibling;
          from = rows.indexOf(sib);
          if (from >= 0) from += down ? -1 : 1;
        }
        var to = from + (down ? 1 : -1);
        event.preventDefault();
        if (to >= 0 && to < rows.length) tbFocusIn(rows[to]);
        return;
      }
    }
    // Tab moves round the bar — its buttons, the status row, the drawer — and
    // never out into the page (its buttons are out of the page's Tab order,
    // so a recorded Tab lands where a run's does). Esc gives focus back.
    if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      var stops = tbFocusStops();
      if (stops.length === 0) return;
      event.preventDefault();
      var at = stops.indexOf(active);
      var goTo = at < 0 ? 0 : (at + (event.shiftKey ? stops.length - 1 : 1)) % stops.length;
      tbFocusIn(stops[goTo]);
    }
  }

  function tbClick(event) {
    if (tbLocal.suppressClick) {
      tbLocal.suppressClick = false;
      return;
    }
    // A click from the keyboard (Enter or Space on a focused button) has no
    // point; the focused button is the one.
    var el = event.detail === 0 ? tb.root.activeElement : tbAt(event.clientX, event.clientY);
    var button = el ? tbCmdOf(el) : null;
    if (!button || button.disabled) return;
    var cmd = button.getAttribute('data-cmd');
    if (cmd === 'grip') return;
    tbCommand(cmd, button);
  }

  function tbPointerDown(event) {
    if (event.button !== 0) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    var el = tbAt(event.clientX, event.clientY);
    // Pointing at the toolbar finishes the typing in the page field, as
    // pointing anywhere does: a field typed just before Pause, Add check or
    // Add step is reported before them, in the order they happened.
    if (state.recording && !state.paused) {
      settleEnter();
      flushAllExcept(null);
    }
    if (tbIsTextBox(el)) return;
    // The buttons do not take focus: the app's field keeps it, and its open
    // menu stays open.
    if (event.cancelable) event.preventDefault();
    var button = el ? tbCmdOf(el) : null;
    var cmd = button ? button.getAttribute('data-cmd') : null;
    if (cmd === 'grip' || cmd === 'expand') tbDragStart(event, cmd);
  }

  /** Everything the bar does with an event from inside it. The gate has
   *  already stopped it; nothing else hears it. */
  function tbEvent(event) {
    if (!tb) return;
    switch (event.type) {
      case 'pointerdown':
        tbPointerDown(event);
        break;
      case 'pointermove':
        tbDragMove(event);
        if (pk) pickHide();
        break;
      case 'pointerup':
      case 'pointercancel':
        tbDragEnd(event);
        break;
      case 'mousedown':
        if (!tbIsTextBox(tbAt(event.clientX, event.clientY)) && event.cancelable) event.preventDefault();
        break;
      case 'focusout':
        // An edit in place the author clicked away from: kept open when they
        // changed something (their words are not thrown away by a stray
        // click), closed when they did not.
        setTimeout(function () {
          var e = tbLocal.editing;
          if (!e || !tb || tb.root.activeElement === e.input) return;
          if (e.input.value === e.original) tbFinishEdit(false);
        }, 0);
        break;
      case 'click':
        tbClick(event);
        break;
      case 'keydown':
        tbKey(event);
        break;
      case 'input':
        tbBoxInput();
        break;
      case 'contextmenu':
        if (!tbIsTextBox(tb.root.activeElement) && event.cancelable) event.preventDefault();
        break;
    }
  }

  /** The step box, or a step being edited in the drawer: where typing,
   *  selecting and the caret are the author's. */
  function tbIsTextBox(el) {
    return !!el && (el === tb.input || (tbLocal.editing !== null && el === tbLocal.editing.input));
  }

  // ── The shortcuts, in every frame ──────────────────────────────────────

  function onShortcut(event) {
    if (!state.recording || !state.bar || !event.isTrusted) return false;
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return false;
    // The physical key: on macOS Option turns the letters into symbols.
    var cmd = SHORTCUTS[event.code];
    if (!cmd) return false;
    swallow(event);
    swallowKeyUp = event.code;
    if (event.repeat) return true;
    if (cmd === 'pause' || cmd === 'check' || cmd === 'undo') {
      settleEnter();
      flushAllExcept(null);
    }
    if (IS_TOP && tb && tbView && tbView.phase === 'recording') {
      if (cmd === 'minimise') tbSetMinimised(!tbMinimised());
      else if (cmd === 'focus') tbFocusBar();
      else tbCommand(cmd);
      return true;
    }
    // A frame, or a top document whose bar has not come up: the server acts,
    // and puts the box or the focus into this tab's top document.
    if (cmd === 'pause') {
      if (state.paused) void sendCmd({ type: 'toolbar', command: 'resume' });
      else pauseLocally();
    } else if (cmd === 'check') {
      if (!state.paused) void sendCmd({ type: 'toolbar', command: state.pick ? 'cancel-check' : 'check' });
    } else if (cmd === 'undo') {
      void sendCmd({ type: 'toolbar', command: 'undo' });
    } else if (cmd === 'step') {
      void sendCmd({ type: 'toolbar', command: 'open-step' });
    } else if (cmd === 'focus') {
      void sendCmd({ type: 'toolbar', command: 'focus-bar' });
    } else if (cmd === 'minimise') {
      void sendCmd({ type: 'toolbar', command: 'toggle-minimised' });
    }
    return true;
  }

  /** Esc with pick mode armed goes to the recorder, not the page: a dialog
   *  the author was about to check stays open. */
  function onPickEscape(event) {
    if (event.key !== 'Escape' || !event.isTrusted || !state.recording) return false;
    if (state.pick) {
      swallow(event);
      swallowKeyUp = event.code;
      state.pick = false;
      pickApply();
      sendOptimistic({ type: 'toolbar', command: 'cancel-check' }, function () {
        state.pick = state.recording && !state.paused;
        pickApply();
        if (IS_TOP) tbRender();
      });
      return true;
    }
    if (IS_TOP && tb && tbLocal.confirm) {
      swallow(event);
      swallowKeyUp = event.code;
      tbLocal.confirm = false;
      tbRender();
      return true;
    }
    return false;
  }

  // ── The gate: the recorder's first window listener ─────────────────────
  //
  // Registered before every other listener in this script, which is an init
  // script and so runs before the page's: listeners on the same node in the
  // same phase run in registration order, so this one hears every event
  // first. For an event from the bar it calls stopImmediatePropagation():
  // the page's listeners (an app's "/" to search, its "click outside to
  // close") and the recorder's own never hear it, and the default action —
  // the text going into the step box — still happens.
  var GATE_EVENTS = [
    'pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'pointerover', 'pointerout', 'pointerenter',
    'pointerleave', 'gotpointercapture', 'lostpointercapture', 'mousedown', 'mouseup', 'mousemove', 'mouseover',
    'mouseout', 'mouseenter', 'mouseleave', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart',
    'touchmove', 'touchend', 'touchcancel', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'compositionstart', 'compositionupdate', 'compositionend', 'focusin', 'focusout', 'focus', 'blur', 'paste',
    'copy', 'cut', 'dragstart', 'drag', 'dragend', 'dragenter', 'dragover', 'dragleave', 'drop', 'selectstart',
  ];

  function onGate(event) {
    if (event.type === 'keydown') {
      if (onShortcut(event)) return;
      if (!isOurs(event) && onPickEscape(event)) return;
    }
    if (event.type === 'keyup' && swallowKeyUp !== null && event.code === swallowKeyUp) {
      swallowKeyUp = null;
      swallow(event);
      return;
    }
    if (!isOurs(event)) return;
    event.stopImmediatePropagation();
    // A page script can dispatch events at the host; only the author's own
    // input moves the bar.
    if (!event.isTrusted) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    tbEvent(event);
  }

  function installGate() {
    for (var i = 0; i < GATE_EVENTS.length; i++) {
      window.addEventListener(GATE_EVENTS[i], onGate, { capture: true });
    }
  }

  // ── Check-in ───────────────────────────────────────────────────────────
  //
  // The top frame asks the server every few seconds whether it is there. Two
  // unanswered in a row: "The recorder isn't answering". It clears on its
  // own when an answer comes.

  function tbCheckIn() {
    if (!IS_TOP || !state.recording || !state.bar) return;
    // A document with no token cannot send the recorder anything: every
    // check-in it cannot make is one missed, so its bar says so rather than
    // sitting there looking fine and doing nothing.
    if (token === null) {
      tbMissedCheckIn();
      return;
    }
    if (tbCheck.pending) {
      tbMissedCheckIn();
      // A question lost for good is not waited on for ever.
      if (tbCheck.missed < MISSED_FOR_OFFLINE * 2) return;
    }
    tbCheck.pending = true;
    var mine = {};
    tbCheck.asked = mine;
    void sendCmd({ type: 'checkin' }).then(function (answer) {
      if (tbCheck.asked !== mine) return;
      tbCheck.pending = false;
      if (answer && answer.ok === true) {
        tbCheck.missed = 0;
        if (tbLocal.offline) {
          tbLocal.offline = false;
          tbRender();
        }
      } else {
        // Refused — the recorder does not know this document — is as good
        // as unanswered.
        tbMissedCheckIn();
      }
    });
  }

  function tbMissedCheckIn() {
    tbCheck.missed++;
    if (tbCheck.missed >= MISSED_FOR_OFFLINE && !tbLocal.offline) {
      tbLocal.offline = true;
      tbAnnounce('Not connected');
      tbRender();
    }
  }

  function checkInSchedule() {
    var want = IS_TOP && state.recording && state.bar;
    if (!want) {
      if (tbCheck.timer) clearInterval(tbCheck.timer);
      tbCheck.timer = 0;
      tbCheck.pending = false;
      tbCheck.missed = 0;
      tbLocal.offline = false;
      return;
    }
    var every = tbView && typeof tbView.checkInMs === 'number' && tbView.checkInMs > 0
      ? tbView.checkInMs
      : DEFAULT_CHECK_IN_MS;
    if (tbCheck.timer && tbCheck.every === every) return;
    if (tbCheck.timer) clearInterval(tbCheck.timer);
    tbCheck.every = every;
    tbCheck.timer = setInterval(tbCheckIn, every);
  }

  /** "Typing hidden": only yes or no crosses, never a value — from any
   *  frame; the top frame's bar shows it. */
  function reportFocus(el, focused) {
    if (!state.recording || !state.bar || token === null) return;
    var secret = !!(focused && el && isTextEntry(el) && isSecretNow(el));
    if (secret === tbLocal.lastFocusSecret) return;
    tbLocal.lastFocusSecret = secret;
    void sendCmd({ type: 'focus', secret: secret });
  }

  /**
   * Where focus is now, said once this document is connected to a recording
   * — recording, with a bar, and its token in hand. A field that already had
   * focus then (an autofocused password box; the one the author was in when
   * Record was pressed; a page busy at load whose token came late) fired its
   * focus event before anyone was listening. The recorder forgets a
   * document's report between recordings, so the last one sent is no guide.
   */
  function focusReportAfterConnect() {
    if (!state.recording || !state.bar || token === null) return;
    var el = null;
    try {
      el = document.hasFocus() ? focusedElement() : null;
    } catch (err) {
      el = null;
    }
    tbLocal.lastFocusSecret = false;
    reportFocus(el, el !== null);
  }

  // ── Pick mode: the outline and its label, in every frame ───────────────

  var pk = null;
  var pickTarget = null;
  var crosshairSheet = null;

  function pickBuild() {
    var host = document.createElement(PICK_TAG);
    resetHost(host, 'none');
    important(host, 'left', '0');
    important(host, 'top', '0');
    important(host, 'width', '0');
    important(host, 'height', '0');
    var root;
    try {
      root = host.attachShadow({ mode: 'closed' });
    } catch (err) {
      return null;
    }
    var sheet = tbSheetOf(PICK_CSS);
    if (sheet) {
      try { root.adoptedStyleSheets = [sheet]; } catch (err) { /* ignore */ }
    }
    try { host.setAttribute('popover', 'manual'); } catch (err) { /* ignore */ }
    var outline = tbEl('div', 'outline');
    var label = tbEl('div', 'label');
    var text = tbEl('span');
    label.appendChild(text);
    root.appendChild(outline);
    root.appendChild(label);
    return { host: host, root: root, outline: outline, label: label, text: text };
  }

  function crosshair(on) {
    try {
      var sheets = document.adoptedStyleSheets;
      if (!sheets) return;
      if (on) {
        if (!crosshairSheet) crosshairSheet = tbSheetOf(CROSSHAIR_CSS);
        if (crosshairSheet && sheets.indexOf(crosshairSheet) === -1) {
          document.adoptedStyleSheets = sheets.concat([crosshairSheet]);
        }
      } else if (crosshairSheet && sheets.indexOf(crosshairSheet) !== -1) {
        document.adoptedStyleSheets = sheets.filter(function (s) { return s !== crosshairSheet; });
      }
    } catch (err) { /* no adopted sheets on documents: the pointer stays as it is */ }
  }

  function pickApply() {
    var on = state.recording && state.pick && !state.paused;
    crosshair(on);
    if (!on) pickHide();
  }

  function pickHide() {
    pickTarget = null;
    if (!pk || !pk.host.parentNode) return;
    try {
      if (pk.host.matches(':popover-open')) pk.host.hidePopover();
    } catch (err) { /* ignore */ }
    pk.host.parentNode.removeChild(pk.host);
  }

  var CONTAINER_WORDS = {
    region: 'panel', section: 'panel', complementary: 'panel', article: 'article', group: 'group',
    fieldset: 'group', dialog: 'dialog', alertdialog: 'dialog', form: 'form', status: 'status', alert: 'alert',
  };

  function cut(text, max) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /** What the click will pick, in words, built from what the model is given:
   *  role, name, container, and the current text or value. */
  function pickPreview(el) {
    var tag = el.tagName.toLowerCase();
    var name = cut(accessibleName(el), 60);
    var parts = [];
    if (isToggle(el)) {
      parts.push((name || 'this') + (inputType(el) === 'radio' ? ' radio button' : ' checkbox'));
      parts.push(el.checked ? 'ticked' : 'not ticked');
    } else if (tag === 'select') {
      var chosen = [];
      for (var i = 0; i < el.options.length; i++) if (el.options[i].selected) chosen.push(cut(clip(el.options[i].text, 60), 40));
      parts.push((name || 'this') + ' list');
      parts.push(chosen.length ? '"' + chosen.join('", "') + '"' : 'nothing chosen');
    } else if (isTextEntry(el)) {
      parts.push((name || 'this') + ' field');
      parts.push(isSecretNow(el) ? 'value hidden' : '"' + cut(clip(currentValue(el), 60), 60) + '"');
    } else {
      var box = el.parentElement && el.parentElement.closest(CONTAINERS);
      if (box && box !== document.body) {
        var role = roleOf(box) || box.tagName.toLowerCase();
        var cname = cut(nameOrHeading(box), 50);
        parts.push((CONTAINER_WORDS[role] || role) + (cname ? ' "' + cname + '"' : ''));
      } else {
        var r = roleOf(el);
        var word = CONTAINER_WORDS[r] || r;
        if (name) parts.push((word ? word + ' ' : '') + '"' + name + '"');
      }
      var text = cut(visibleText(el, 60), 60);
      if (text) parts.push('"' + text + '"');
      var ariaChecked = el.getAttribute('aria-checked');
      if (ariaChecked === 'true' || ariaChecked === 'false') parts.push(ariaChecked === 'true' ? 'ticked' : 'not ticked');
    }
    if (parts.length === 0) parts.push(tag);
    return 'Check · ' + parts.join(' · ');
  }

  function pickShow(el) {
    if (!pk) pk = pickBuild();
    if (!pk || !document.documentElement) return;
    pickTarget = el;
    if (pk.host.parentNode !== document.documentElement) {
      try { document.documentElement.appendChild(pk.host); } catch (err) { return; }
    }
    try {
      if (pk.host.matches(':popover-open')) pk.host.hidePopover();
      pk.host.showPopover();
    } catch (err) { /* z-index only */ }
    var r;
    try { r = el.getBoundingClientRect(); } catch (err) { return; }
    important(pk.outline, 'left', (r.left - 3) + 'px');
    important(pk.outline, 'top', (r.top - 3) + 'px');
    important(pk.outline, 'width', (r.width + 6) + 'px');
    important(pk.outline, 'height', (r.height + 6) + 'px');
    pk.text.textContent = pickPreview(el);
    var lr = pk.label.getBoundingClientRect();
    var top = r.top - lr.height - 8;
    if (top < 6) top = r.bottom + 8;
    var left = Math.min(Math.max(6, r.left - 3), Math.max(6, window.innerWidth - lr.width - 8));
    important(pk.label, 'left', left + 'px');
    important(pk.label, 'top', top + 'px');
  }

  function onPickHover(event) {
    if (!state.recording || !state.pick || state.paused || !event.isTrusted) return;
    if (isOurs(event)) {
      pickHide();
      return;
    }
    var t = realTarget(event);
    if (!t || isOurHost(t)) return;
    var el = actionable(t) || t;
    if (el === document.documentElement || el === document.body) {
      pickHide();
      return;
    }
    if (el !== pickTarget) pickShow(el);
  }

  function onPickScroll() {
    if (pickTarget && state.pick) pickShow(pickTarget);
  }

  function onPickLeave(event) {
    if (state.pick && !event.relatedTarget) pickHide();
  }

  /** Where the bar is, for the crop to paint out (fieldRects): the same
   *  fail-closed rule as a secret field — a bar that is there and cannot
   *  say where makes the crop go. */
  function toolbarBoxes() {
    if (!tb || !tb.host.isConnected) return { boxes: [], unknown: false };
    var b = boxOf(tb.host);
    if (!b) return { boxes: [], unknown: true };
    if (b.width === 0 && b.height === 0) return { boxes: [], unknown: false };
    return { boxes: [b], unknown: false };
  }
