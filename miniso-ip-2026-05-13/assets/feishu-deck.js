/* ============================================================================
   feishu-deck-h5 · runtime
   - Scale-to-fit each .slide to its frame (1920×1080 design canvas)
   - Auto-detect mobile / narrow viewport → scroll mode (vertical card stack)
   - Desktop default → present mode (one slide per viewport, ←/→/space, wheel)
   - Keyboard: ←/→/PgUp/PgDn/Space/Home/End  ·  URL hash sync (#3)
   - Mode toggle button: 演示 ↔ 浏览  (entering 演示 also requests fullscreen)
   - F-key + bottom button: fullscreen toggle
   - Auto-fade chrome after 2.5s idle (mousemove throttled to 100ms)
   - All listeners bound through a single AbortController → clean destroy()
   - Single document-level ResizeObserver (was 1 per frame)
   ============================================================================ */
(function () {
  'use strict';

  const DESIGN_W = 1920;
  const DESIGN_H = 1080;
  const MOBILE_BREAKPOINT = 900;
  const MODE_KEY  = 'fs-deck-mode';
  const IDLE_MS   = 2500;
  const NUDGE_THROTTLE_MS = 100;
  const FS_REFIT_DEBOUNCE = 80;

  let activeController = null;       // tracks the current init's AbortController

  function init() {
    const deck = document.querySelector('.deck');
    if (!deck) return null;

    // If a previous init is still alive, destroy it first (idempotent)
    if (activeController) activeController.abort();
    activeController = new AbortController();
    const signal = activeController.signal;

    // ---- Resolve mode (cache localStorage value at init only — no IO in hot path) ----
    const url = new URL(location.href);
    const queryMode = url.searchParams.get('mode');
    let storedMode = null;
    try { storedMode = localStorage.getItem(MODE_KEY); } catch (e) { /* private/blocked */ }
    const auto = window.matchMedia('(max-width: ' + MOBILE_BREAKPOINT + 'px)').matches
                   ? 'scroll' : 'present';
    setMode(deck, queryMode || storedMode || auto);

    // ---- Build UI overlay ----
    const ui = buildUI();
    document.body.appendChild(ui);

    // ---- Set up frames + reveal-animation child indices ----
    const frames = Array.from(deck.querySelectorAll('.slide-frame'));
    frames.forEach((frame, i) => {
      frame.dataset.idx = String(i);
      const slide = frame.querySelector('.slide');
      if (!slide) return;
      // (Per-slide .footer/.pageno retired 2026-05 — pager UI in present
      //  mode shows the page number; no per-slide DOM read needed.)
      // Reveal animation: assign --child-i 1..N to direct children for staggered delay
      Array.prototype.forEach.call(slide.children, (child, idx) => {
        child.style.setProperty('--child-i', String(Math.min(idx + 1, 7)));
      });
      // Click-to-present in scroll mode
      frame.addEventListener('click', () => {
        if (deck.dataset.mode === 'scroll') goTo(deck, frames, i, true);
      }, { signal });
    });

    // ---- Single document-level ResizeObserver (was 1 per frame = 12) ----
    let pendingRefit = false;
    const ro = new ResizeObserver(() => {
      if (pendingRefit) return;
      pendingRefit = true;
      requestAnimationFrame(() => {
        pendingRefit = false;
        frames.forEach(scaleFrame);
      });
    });
    ro.observe(document.documentElement);
    signal.addEventListener('abort', () => ro.disconnect());
    frames.forEach(scaleFrame);   // initial scale

    // ---- Keyboard nav (present mode) + F = fullscreen (any mode) ----
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault(); toggleFullscreen(); nudgeIdle(); return;
      }
      if (deck.dataset.mode !== 'present') return;
      const cur = currentIdx(frames);
      switch (e.key) {
        case 'ArrowRight': case 'PageDown': case ' ': case 'Spacebar':
          e.preventDefault(); goTo(deck, frames, Math.min(cur + 1, frames.length - 1)); break;
        case 'ArrowLeft':  case 'PageUp':
          e.preventDefault(); goTo(deck, frames, Math.max(cur - 1, 0)); break;
        case 'Home':
          e.preventDefault(); goTo(deck, frames, 0); break;
        case 'End':
          e.preventDefault(); goTo(deck, frames, frames.length - 1); break;
        case 'Escape':
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
          break;
      }
      nudgeIdle();
    }, { signal });

    // ---- Fullscreen change handler (debounced single refit, was 3 refits) ----
    let fsRefitTimer;
    function onFsChange() {
      clearTimeout(fsRefitTimer);
      fsRefitTimer = setTimeout(() => {
        frames.forEach(scaleFrame);
        updateUI(deck, frames);
      }, FS_REFIT_DEBOUNCE);
    }
    document.addEventListener('fullscreenchange',       onFsChange, { signal });
    document.addEventListener('webkitfullscreenchange', onFsChange, { signal });

    // ---- Wheel nav (present, debounced 600ms) ----
    let wheelLock = 0;
    deck.addEventListener('wheel', (e) => {
      if (deck.dataset.mode !== 'present') return;
      const now = Date.now();
      if (now - wheelLock < 600) return;
      if (Math.abs(e.deltaY) < 30) return;
      wheelLock = now;
      const cur = currentIdx(frames);
      const next = e.deltaY > 0
        ? Math.min(cur + 1, frames.length - 1)
        : Math.max(cur - 1, 0);
      goTo(deck, frames, next);
    }, { signal, passive: true });

    // ---- Touch swipe (present mode) ----
    let touchStartY = null;
    deck.addEventListener('touchstart', (e) => {
      if (deck.dataset.mode !== 'present') return;
      touchStartY = e.touches[0].clientY;
    }, { signal, passive: true });
    deck.addEventListener('touchend', (e) => {
      if (deck.dataset.mode !== 'present' || touchStartY == null) return;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartY = null;
      if (Math.abs(dy) < 50) return;
      const cur = currentIdx(frames);
      const next = dy < 0
        ? Math.min(cur + 1, frames.length - 1)
        : Math.max(cur - 1, 0);
      goTo(deck, frames, next);
    }, { signal, passive: true });

    // ---- Hash sync — #3 (1-based slide index) OR #<slide-key>
    // (data-slide-key slug, e.g. #cover / #cup-journey). Slug form is
    // how the slide-library viewer deep-links into a specific slide.
    function readHash() {
      const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
      if (!raw) return false;
      if (/^\d+$/.test(raw)) {
        const idx = Math.max(0, Math.min(frames.length - 1, parseInt(raw, 10) - 1));
        goTo(deck, frames, idx, false);
        return true;
      }
      // data-slide-key / id live on the inner .slide, not on .slide-frame
      const idx = frames.findIndex(f => {
        const slide = f.querySelector('.slide');
        return slide && (slide.dataset.slideKey === raw || slide.id === raw);
      });
      if (idx >= 0) {
        goTo(deck, frames, idx, false);
        return true;
      }
      return false;
    }
    window.addEventListener('hashchange', readHash, { signal });
    if (!readHash()) goTo(deck, frames, 0, false);

    // ---- Auto-idle (chrome fades after 2.5s of no input) ----
    let idleTimer;
    function nudgeIdle() {
      const u = document.querySelector('.deck-ui');
      if (!u) return;
      u.classList.remove('is-idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (deck.dataset.mode === 'present') u.classList.add('is-idle');
      }, IDLE_MS);
    }
    // mousemove is throttled — fires up to 100×/sec normally, we only need ~10
    let lastNudge = 0;
    function throttledNudge() {
      const now = performance.now();
      if (now - lastNudge < NUDGE_THROTTLE_MS) return;
      lastNudge = now; nudgeIdle();
    }
    document.addEventListener('mousemove',  throttledNudge, { signal, passive: true });
    document.addEventListener('keydown',    nudgeIdle,      { signal, passive: true });
    document.addEventListener('wheel',      nudgeIdle,      { signal, passive: true });
    document.addEventListener('touchstart', nudgeIdle,      { signal, passive: true });
    document.addEventListener('click',      nudgeIdle,      { signal, passive: true });
    nudgeIdle();   // start the timer

    // ---- UI button wires (prev/next + fullscreen) ----
    // 2026-05-06 · removed top-right .mode-toggle button. Bottom-pill .fs button
    // already handles present-mode entry via fullscreen request, and mobile
    // scroll mode is auto-detected via viewport. Toggle button became redundant
    // and added noise to top-right corner where the brand logo sits.
    ui.querySelector('.ctl.prev').addEventListener('click', () => {
      goTo(deck, frames, Math.max(0, currentIdx(frames) - 1));
    }, { signal });
    ui.querySelector('.ctl.next').addEventListener('click', () => {
      goTo(deck, frames, Math.min(frames.length - 1, currentIdx(frames) + 1));
    }, { signal });
    ui.querySelector('.ctl.fs').addEventListener('click', toggleFullscreen, { signal });

    // ---- Window resize / orientation ----
    let resizeTimer;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        // Auto-flip mode on the fly only if user hasn't pinned it
        if (!storedMode && !queryMode) {
          const want = window.matchMedia('(max-width: ' + MOBILE_BREAKPOINT + 'px)').matches
                         ? 'scroll' : 'present';
          if (deck.dataset.mode !== want) setMode(deck, want);
        }
        frames.forEach(scaleFrame);
        updateUI(deck, frames);
        maybePortraitToast();
      }, 100);
    }
    window.addEventListener('resize',            onResize, { signal });
    window.addEventListener('orientationchange', onResize, { signal });

    maybePortraitToast();
    updateUI(deck, frames);

    // ---- Return destroy() so SPA hosts can clean up ----
    return {
      destroy() {
        if (activeController) {
          activeController.abort();
          activeController = null;
        }
        const u = document.querySelector('.deck-ui');
        if (u && u.parentNode) u.parentNode.removeChild(u);
        clearTimeout(fsRefitTimer);
        clearTimeout(resizeTimer);
        clearTimeout(idleTimer);
      },
      goTo: (i) => goTo(deck, frames, i),
      setMode: (m) => setMode(deck, m),
    };
  }

  // ---- Helpers ----
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function setMode(deck, mode) {
    deck.dataset.mode = mode === 'scroll' ? 'scroll' : 'present';
  }

  function scaleFrame(frame) {
    const slide = frame.querySelector('.slide');
    if (!slide) return;
    const w = frame.clientWidth, h = frame.clientHeight;
    if (!w || !h) return;
    // 2026-05-06 · always use contain (Math.min) to preserve all slide content.
    // History:
    //   v1 (current) · contain. On 16:10 viewports there are small letterbox
    //                  bars top/bottom, but every pixel of the 1920×1080 slide
    //                  is visible — including wordmark in the top-right corner
    //                  and page-no UI at the bottom-center.
    //   v2 (rejected) · cover (Math.max) on fullscreen. Eliminated bars, but on
    //                   16:10 monitors clipped ~106px from each side, eating
    //                   into the master 96px content padding and clipping
    //                   wordmark / corner content. User reported "显示不全".
    // Conclusion: bars are the correct visual behavior; 16:9-content-on-16:10-
    // viewport can't be both "no bars" AND "no clipping". Keep contain.
    const scale = Math.min(w / DESIGN_W, h / DESIGN_H);
    slide.style.setProperty('--fs-scale', String(scale));
  }

  function currentIdx(frames) {
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].classList.contains('is-current')) return i;
    }
    return 0;
  }

  function goTo(deck, frames, idx, updateHash) {
    if (idx < 0 || idx >= frames.length) return;
    // After the first navigation, arm the reveal animation for subsequent
    // slide changes. The CSS suppresses the staggered reveal on the very
    // first slide load so initial paint isn't ~700 ms of stagger animation.
    if (deck.hasAttribute('data-nav-armed')) {
      // Already armed — normal flow, animations will run on slide change.
    } else if (idx !== 0 || frames[idx].classList.contains('is-current')) {
      // First non-zero nav OR re-asserting current: arm.
      deck.setAttribute('data-nav-armed', '');
    }
    for (let i = 0; i < frames.length; i++) {
      frames[i].classList.toggle('is-current', i === idx);
    }
    if (deck.dataset.mode === 'present') {
      scaleFrame(frames[idx]);
    } else {
      frames[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (updateHash !== false) {
      const newHash = '#' + (idx + 1);
      if (location.hash !== newHash) history.replaceState(null, '', newHash);
    }
    updateUI(deck, frames);
  }

  function buildUI() {
    const ui = document.createElement('div');
    ui.className = 'deck-ui';
    // 2026-05-06 · top-right .mode-toggle button removed (redundant with bottom
    // .ctl.fs and auto mobile scroll detection). Don't re-add — see updateUI().
    ui.innerHTML =
      '<div class="deck-progress" aria-hidden="true"><div class="bar"></div></div>' +
      '<div class="deck-controls" role="group" aria-label="Slide controls">' +
        '<button class="ctl prev" type="button" title="上一页 (←)" aria-label="Previous slide">' +
          '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M15 18l-6-6 6-6"/></svg>' +
        '</button>' +
        '<span class="indicator"><span class="cur">01</span><span class="sep"> / </span><span class="total">01</span></span>' +
        '<button class="ctl next" type="button" title="下一页 (→ / Space)" aria-label="Next slide">' +
          '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M9 6l6 6-6 6"/></svg>' +
        '</button>' +
        '<span class="ctl-sep"></span>' +
        '<button class="ctl fs" type="button" title="全屏 (F)" aria-label="Toggle fullscreen">' +
          '<svg class="i-enter" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4"/></svg>' +
          '<svg class="i-exit"  viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M9 21v-4a2 2 0 0 0-2-2H3M15 21v-4a2 2 0 0 1 2-2h4"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="nav-hint">← →   翻页  ·  F 全屏</div>';
    return ui;
  }

  function updateUI(deck, frames) {
    const ui = document.querySelector('.deck-ui');
    if (!ui) return;
    const cur = currentIdx(frames);
    const total = frames.length;
    const isPresent = deck.dataset.mode === 'present';
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);

    ui.querySelector('.cur').textContent   = pad(cur + 1);
    ui.querySelector('.total').textContent = pad(total);
    const pct = total > 0 ? ((cur + 1) / total) * 100 : 0;
    ui.querySelector('.deck-progress .bar').style.width = pct + '%';
    ui.querySelector('.ctl.fs .i-enter').style.display = isFullscreen ? 'none'  : 'block';
    ui.querySelector('.ctl.fs .i-exit').style.display  = isFullscreen ? 'block' : 'none';
    ui.querySelector('.deck-progress').style.display = isPresent ? 'block' : 'none';
    ui.querySelector('.deck-controls').style.display = isPresent ? 'flex'  : 'none';
    ui.querySelector('.nav-hint').style.display      = isPresent ? 'block' : 'none';
    ui.querySelector('.ctl.prev').disabled = cur <= 0;
    ui.querySelector('.ctl.next').disabled = cur >= total - 1;
  }

  function requestFullscreen() {
    const root = document.documentElement;
    if (root.requestFullscreen) {
      root.requestFullscreen().catch(() => {});
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    }
  }
  function toggleFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      requestFullscreen();
    }
  }

  function maybePortraitToast() {
    const isPortrait = window.matchMedia('(orientation: portrait) and (max-width: 900px)').matches;
    if (isPortrait) document.body.classList.add('fs-portrait-warn');
    else document.body.classList.remove('fs-portrait-warn');
  }

  // ---- Boot ----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Expose programmatic API for SPA hosts
  if (typeof window !== 'undefined') {
    window.feishuDeck = { init };
  }
})();
