// Portal Meter landing page. Everything here is progressive: the page is complete without it.
// 1. copy buttons  2. the seller's live health line  3. the cost chart grows into view  4. the hero replay of block 282559
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---------------------------------------------------------------- 1. copy
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

  // ---------------------------------------------------------------- 2. live health (same origin, read-only)
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

  // ---------------------------------------------------------------- 3. chart bars grow when seen
  const chart = document.getElementById('chart');
  if (chart) {
    if (!('IntersectionObserver' in window) || reduced.matches) chart.classList.add('in');
    else {
      const io = new IntersectionObserver(es => {
        if (es.some(e => e.isIntersecting)) { chart.classList.add('in'); io.disconnect(); }
      }, { threshold: 0.35 });
      io.observe(chart);
    }
  }

  // ---------------------------------------------------------------- 4. the meter: a replay of block 282559
  // The batch's real numbers, from the seller's public /v1/batches: three sessions, 137 requests at 0.01 pUSD each,
  // redeemed in one Ethereum transaction. Session 0x08de… settled vouchers 64 to 80, the other two from voucher 1.
  // The interleaving of the calls is illustrative (the caption says so); counts, ids and totals are not.
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
  const feed = document.getElementById('meter-feed');
  const lanes = $$('.lane', meter);
  const count = document.getElementById('meter-count');
  const sum = document.getElementById('meter-sum');
  const state = document.getElementById('meter-state');
  const settle = document.getElementById('meter-settle');
  const settleTitle = $('.ms-text b', settle);
  const toggle = document.getElementById('meter-toggle');
  const STATIC_STATE = state.textContent;
  const TICK = 55, FEED_EVERY = 5, HOLD = 3800, SEND = 900, LEAD_IN = 1600, GAP = 700;

  const row = (si, n) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="mono fn">voucher ${n}</span><span class="mono fs">${SESSIONS[si].id}</span><span class="steps"><i>402</i><i>signed</i><i class="ok">200</i></span>`;
    return li;
  };
  function pushRow(si, n) {
    const rows = [...feed.children].filter(li => !li.classList.contains('gone'));
    for (const li of rows) {
      const i = Number(li.style.getPropertyValue('--i')) + 1;
      li.style.setProperty('--i', String(i));
      if (i >= 4) { li.classList.add('gone'); setTimeout(() => li.remove(), 450); }
    }
    const li = row(si, n);
    li.style.setProperty('--i', '0');
    li.classList.add('enter');
    feed.prepend(li);
  }
  function setCounts(done, k) {
    lanes.forEach((lane, i) => {
      const t = SESSIONS[i].total;
      lane.style.setProperty('--p', String(done[i] / t));
      $('.ln b', lane).textContent = String(done[i]);
    });
    count.textContent = String(k);
    sum.textContent = (k / 100).toFixed(2);
  }

  let timer = 0, phase = 'idle', k = TOTAL, done = SESSIONS.map(() => 0), paused = false, visible = true;
  const clear = () => { clearTimeout(timer); timer = 0; };
  const schedule = (fn, ms) => { clear(); timer = setTimeout(fn, ms); };

  function reset() {
    k = 0; done = SESSIONS.map(() => 0);
    settle.classList.remove('is-on');
    settleTitle.textContent = 'Next: one transaction for the batch';
    state.textContent = 'Vouchers waiting for the next batch';
    for (const li of [...feed.children]) {
      li.style.setProperty('--i', String(Number(li.style.getPropertyValue('--i')) + 4));
      li.classList.add('gone'); setTimeout(() => li.remove(), 450);
    }
    setCounts(done, 0);
  }
  function step() {
    if (k < TOTAL) {
      const [si, n] = ORDER[k];
      done[si] += 1; k += 1;
      setCounts(done, k);
      if (k % FEED_EVERY === 1 || k === TOTAL) pushRow(si, n);
      phase = 'collect';
      schedule(step, TICK);
      return;
    }
    if (phase === 'collect') {
      phase = 'send';
      state.textContent = 'Settling in one transaction…';
      schedule(step, SEND);
      return;
    }
    if (phase === 'send') {
      phase = 'hold';
      settle.classList.add('is-on');
      settleTitle.textContent = 'Settled in one Ethereum transaction';
      state.textContent = STATIC_STATE;
      schedule(step, HOLD);
      return;
    }
    // hold over: start again
    phase = 'gap';
    reset();
    schedule(() => { phase = 'collect'; step(); }, GAP);
  }
  const running = () => !paused && visible && !document.hidden && !reduced.matches;
  function resume() {
    if (!running() || timer) return;
    if (phase === 'idle') { phase = 'hold'; schedule(step, LEAD_IN); return; }
    schedule(phase === 'gap' ? () => { phase = 'collect'; step(); } : step, TICK);
  }
  function halt() { clear(); }

  if (reduced.matches) { toggle?.remove(); return; }
  if (toggle) {
    toggle.addEventListener('click', () => {
      paused = !paused;
      toggle.setAttribute('aria-pressed', String(paused));
      toggle.setAttribute('aria-label', paused ? 'Play the replay' : 'Pause the replay');
      $('use', toggle).setAttribute('href', paused ? '#i-play' : '#i-pause');
      if (paused) halt(); else resume();
    });
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(es => {
      visible = es.some(e => e.isIntersecting);
      if (visible) resume(); else halt();
    }, { threshold: 0.2 }).observe(meter);
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? halt() : resume()));
  reduced.addEventListener?.('change', () => { if (reduced.matches) { halt(); toggle?.remove(); } });
  resume();
})();
