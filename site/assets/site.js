// Portal Meter landing page. Everything here is progressive: the page is complete without it.
// 1. theme switch  2. copy buttons  3. the seller's live health line  4. the sessions story follows the scroll
// 5. the phone's thumb bar  6. the hero: one request franked, then the batch of block 282559 sent in one transaction
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;

  // ---------------------------------------------------------------- 1. theme: system by default, the choice remembered
  const themeBtn = document.getElementById('theme-btn');
  const isDark = () => (root.getAttribute('data-theme') || (darkMQ.matches ? 'dark' : 'light')) === 'dark';
  const syncBtn = () => {
    if (!themeBtn) return;
    const d = isDark();
    themeBtn.setAttribute('aria-pressed', String(d));
    themeBtn.setAttribute('aria-label', d ? 'Switch to light mode' : 'Switch to dark mode');
    const meta = document.querySelectorAll('meta[name="theme-color"]');
    for (const m of meta) m.setAttribute('content', d ? '#0a0d19' : '#f4f6f9');
  };
  syncBtn();
  themeBtn?.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    const apply = () => {
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('pm-theme', next); } catch { /* private mode: this page only */ }
      syncBtn();
      // the engraved plate redraws after the new colours have painted
      requestAnimationFrame(() => setTimeout(() => dispatchEvent(new Event('pm-theme')), 60));
    };
    apply();
  });
  darkMQ.addEventListener?.('change', () => { syncBtn(); dispatchEvent(new Event('pm-theme')); });

  // ---------------------------------------------------------------- 2. copy
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
  for (const b of $$('[data-copy], [data-copy-from]')) {
    b.addEventListener('click', async () => {
      const from = b.getAttribute('data-copy-from');
      const text = from ? (document.getElementById(from)?.value || '') : b.getAttribute('data-copy');
      if (!text || !(await copyText(text))) return;
      b.classList.add('copied');
      const label = b.getAttribute('aria-label');
      b.setAttribute('aria-label', 'Copied');
      setTimeout(() => { b.classList.remove('copied'); b.setAttribute('aria-label', label); }, 1600);
    });
  }

  // ---------------------------------------------------------------- 3. live health (same origin, read-only)
  const live = document.getElementById('live-health');
  if (live) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    fetch('health', { cache: 'no-store', signal: ctl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(h => {
        if (!h || !Number.isFinite(h.requestsSettled) || !Number.isFinite(h.batches)) return;
        const n = v => Number(v).toLocaleString('en-US');
        const waiting = Number.isFinite(h.requestsWaitingForSettlement) ? h.requestsWaitingForSettlement : 0;
        live.innerHTML = `Live from the seller: <b>${n(h.requestsSettled)}</b> requests settled in <b>${n(h.batches)}</b> transactions, <b>${n(waiting)}</b> waiting for the next batch. <a class="link" href="health">health</a>`;
      })
      .catch(() => { /* keep the publish-time numbers */ })
      .finally(() => clearTimeout(t));
  }

  // ---------------------------------------------------------------- 4. the sessions story: the chapter in the middle of the screen is the active one
  const story = document.getElementById('story');
  if (story) {
    const chapters = $$('.chapter', story);
    story.setAttribute('data-active', '1');
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => {
        for (const e of es) if (e.isIntersecting) story.setAttribute('data-active', e.target.closest('.chapter').dataset.step);
      }, { rootMargin: '-42% 0px -42% 0px' });
      for (const c of chapters) io.observe($('.ch-text', c));
    }
    // the pulse runs the length of the voucher chain
    const chain = $('.chain', story);
    const rail = $('.links-row', story);
    if (chain && rail) {
      const fit = () => story.style.setProperty('--chain-h', `${Math.max(60, rail.offsetHeight - 8)}px`);
      fit(); addEventListener('resize', fit, { passive: true });
    }
  }

  // ---------------------------------------------------------------- 5. the thumb bar on phones, once the hero's buttons are off screen
  const bar = document.querySelector('.actionbar');
  const heroCta = document.getElementById('hero-cta');
  const closing = document.querySelector('footer.closing .close-inner');
  if (bar && heroCta && 'IntersectionObserver' in window) {
    let heroOut = false, closeIn = false;
    const set = () => bar.classList.toggle('show', heroOut && !closeIn);
    new IntersectionObserver(es => { heroOut = !es[0].isIntersecting && es[0].boundingClientRect.top < 0; set(); }).observe(heroCta);
    if (closing) new IntersectionObserver(es => { closeIn = es[0].isIntersecting; set(); }).observe(closing);
  }

  // ---------------------------------------------------------------- 6. the hero: a replay of block 282559
  // The batch's real numbers, from the seller's public /v1/batches: three sessions, 137 requests at 0.01 pUSD each,
  // redeemed in one Ethereum transaction. Session 0x08de… settled vouchers 64 to 80, the other two from voucher 1.
  // The interleaving of the calls is illustrative (the note in the frame says so); counts, ids and totals are not.
  const meter = document.getElementById('meter');
  if (!meter) return;
  const SESSIONS = [
    { id: '0x08de…94c9', first: 64, total: 17 },
    { id: '0x58bb…8bc2', first: 1, total: 100 },
    { id: '0x8ccb…0b37', first: 1, total: 20 },
  ];
  const TOTAL = SESSIONS.reduce((n, s) => n + s.total, 0); // 137
  // proportional interleave, deterministic: the session furthest behind its share goes next
  const ORDER = [];
  {
    const done = SESSIONS.map(() => 0);
    for (let k = 0; k < TOTAL; k++) {
      let best = -1, bestShare = Infinity;
      SESSIONS.forEach((s, i) => { const share = (done[i] + 1) / s.total; if (done[i] < s.total && share < bestShare) { best = i; bestShare = share; } });
      ORDER.push([best, SESSIONS[best].first + done[best]]);
      done[best] += 1;
    }
  }
  const lanes = $$('.lane', meter);
  const count = document.getElementById('meter-count');
  const sum = document.getElementById('meter-sum');
  const state = document.getElementById('meter-state');
  const title = document.getElementById('meter-title');
  const settle = document.getElementById('meter-settle');
  const envSession = document.getElementById('env-session');
  const envVoucher = document.getElementById('env-voucher');
  const stamp = document.getElementById('stamp');
  const envelope = document.getElementById('env');
  const toggle = document.getElementById('meter-toggle');
  const STATIC = { state: state.textContent, title: title.textContent };

  const setCounts = (done, k) => {
    lanes.forEach((lane, i) => {
      lane.style.setProperty('--p', String(done[i] / SESSIONS[i].total));
      $('.ln b', lane).textContent = String(done[i]);
    });
    count.textContent = String(k);
    sum.textContent = (k / 100).toFixed(2);
  };
  const setEnvelope = (si, n) => { envSession.textContent = SESSIONS[si].id; envVoucher.textContent = String(n); };
  const phase = p => meter.setAttribute('data-phase', p);

  // a small envelope flies from the meter to its session's lane (transform and opacity only)
  function fly(si) {
    if (!meter.animate) return;
    const m = meter.getBoundingClientRect();
    const a = stamp.getBoundingClientRect();
    const b = $('.lb', lanes[si]).getBoundingClientRect();
    const chip = document.createElement('span');
    chip.className = 'drop-chip';
    chip.style.left = `${a.left - m.left + a.width / 2 - 11}px`;
    chip.style.top = `${a.top - m.top + a.height / 2 - 7}px`;
    meter.append(chip);
    const dx = b.left - a.left - a.width / 2 + b.width * (0.2 + Math.random() * 0.6);
    const dy = b.top - a.top - a.height / 2 + b.height / 2;
    chip.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.6}px, ${dy * 0.35}px) scale(0.8) rotate(-8deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 },
    ], { duration: 460, easing: 'cubic-bezier(0.5, 0, 0.3, 1)' }).finished.then(() => chip.remove(), () => chip.remove());
  }

  // the timeline: [phase, ms to stay]; 'fill' runs the 137 vouchers, 'hold' rests on the settled batch
  const SCRIPT = [['ready', 900], ['press', 260], ['quote', 650], ['stamp', 750], ['ok', 800], ['drop', 520], ['fill', 0], ['send', 700], ['settled', 4200]];
  let i = 0, k = 0, done = SESSIONS.map(() => 0), timer = 0, paused = false, visible = true, started = false;
  const clear = () => { clearTimeout(timer); timer = 0; };
  const schedule = (fn, ms) => { clear(); timer = setTimeout(fn, ms); };

  function reset() {
    k = 0; done = SESSIONS.map(() => 0);
    setCounts(done, 0);
    setEnvelope(...ORDER[0]);
    meter.classList.remove('settled', 'settling');
    settle.classList.remove('is-on');
    title.textContent = 'Next: one transaction for the batch';
    state.textContent = 'Vouchers waiting for the next batch';
  }
  function tick() {
    // one voucher franked and filed; the first came through the whole exchange above
    const [si, n] = ORDER[k];
    done[si] += 1; k += 1;
    setCounts(done, k);
    if (k % 3 === 0 || k === TOTAL) { setEnvelope(si, n); stamp.classList.remove('thunk'); void stamp.offsetWidth; stamp.classList.add('thunk'); }
    if (k % 6 === 2) fly(si);
    if (k < TOTAL) schedule(tick, k < 10 ? 70 : 22);
    else schedule(next, 380);
  }
  function enter(p) {
    phase(p);
    if (p === 'ready') reset();
    if (p === 'drop') { done[ORDER[0][0]] = 0; }
    if (p === 'fill') {
      // the first request lands in its lane, then the rest of the batch follows at speed
      envelope.style.transition = 'none';
      requestAnimationFrame(() => { envelope.style.transition = ''; });
      fly(ORDER[0][0]);
      schedule(tick, 120);
      return;
    }
    if (p === 'send') { state.textContent = 'Settling in one transaction…'; }
    if (p === 'settled') {
      meter.classList.add('settled', 'settling');
      settle.classList.add('is-on');
      title.textContent = STATIC.title;
      state.textContent = STATIC.state;
    }
    schedule(next, SCRIPT[i][1]);
  }
  function next() { i = (i + 1) % SCRIPT.length; enter(SCRIPT[i][0]); }

  const running = () => !paused && visible && !document.hidden && !reduced.matches;
  function resume() {
    if (!running() || timer) return;
    if (!started) { started = true; meter.classList.remove('is-static'); i = 0; schedule(() => enter('ready'), 400); return; }
    const p = SCRIPT[i][0];
    if (p === 'fill' && k < TOTAL) schedule(tick, 60); else schedule(next, 300);
  }
  const halt = () => clear();

  if (reduced.matches) { toggle?.remove(); return; }
  toggle?.addEventListener('click', () => {
    paused = !paused;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? 'Play the replay' : 'Pause the replay');
    $('use', toggle).setAttribute('href', paused ? '#i-play' : '#i-pause');
    if (paused) halt(); else resume();
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(es => {
      visible = es.some(e => e.isIntersecting);
      if (visible) resume(); else halt();
    }, { threshold: 0.2 }).observe(meter);
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? halt() : resume()));
  reduced.addEventListener?.('change', () => {
    if (!reduced.matches) return;
    halt(); toggle?.remove();
    meter.classList.add('is-static', 'settled'); settle.classList.add('is-on');
    setCounts(SESSIONS.map(s => s.total), TOTAL); title.textContent = STATIC.title; state.textContent = STATIC.state;
  });
  resume();
})();
