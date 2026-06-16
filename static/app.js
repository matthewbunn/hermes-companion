/* Hermes Companion PWA */
'use strict';

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
};
const fmtTime = (t) => { if (!t) return '—'; const d = new Date(t); return isNaN(d) ? String(t) : d.toLocaleString(); };
const ago = (t) => {
  if (!t) return '';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (isNaN(s)) return '';
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};
const fmtBytes = (n) => {
  if (n == null) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i];
};

function toast(msg, bad = false) {
  const t = el('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- API ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
  if (!r.ok) throw Object.assign(new Error('http ' + r.status), { status: r.status, body });
  return body;
}
const apiGET = (p) => api('/api' + p);
const apiPOST = (p, b) => api('/api' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
const apiPUT = (p, b) => api('/api' + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
const apiDEL = (p) => api('/api' + p, { method: 'DELETE' });

// ---------- Login ----------
function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }

async function doLogin() {
  const pw = $('#login-pw').value;
  $('#login-err').textContent = '';
  try {
    const r = await fetch('/__login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw }), credentials: 'same-origin',
    });
    if (!r.ok) { $('#login-err').textContent = 'Incorrect passphrase'; return; }
    showApp(); boot();
  } catch (e) { $('#login-err').textContent = 'Connection error'; }
}

// ---------- Markdown-lite (safe) ----------
function mdLite(s) {
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = s.split(/```/);
  let out = '';
  blocks.forEach((b, i) => {
    if (i % 2) { out += '<pre>' + esc(b.replace(/^[a-z]*\n/i, '')) + '</pre>'; return; }
    let t = esc(b)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, '<br>');
    out += t;
  });
  return out;
}

// ---------- View routing ----------
const TITLES = { chat: 'Chat', status: 'Status', ops: 'Ops', settings: 'Settings', more: 'More' };
let currentView = 'chat';

function setView(name) {
  currentView = name;
  $('#view-title').textContent = TITLES[name] || 'Hermes';
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  const v = $('#view'); v.innerHTML = '';
  v.style.padding = name === 'chat' ? '0' : '';
  ({ chat: viewChat, status: viewStatus, ops: viewOps, settings: viewSettings, more: viewMore }[name] || viewStatus)(v);
}

function loading(container) { container.append(el('div', { class: 'spinner' })); }
function errCard(e) { return el('div', { class: 'card' }, el('div', { class: 'muted' }, 'Error: ' + (e?.message || e))); }

// ---------- CHAT (multimodal: text, images, video frames, voice notes, TTS) ----------
// message shape: { role, content (API: string|parts[]), media:[{kind,url,transcript}] }
const chatState = { messages: [], streaming: false, atts: [], rec: null };

function viewChat(v) {
  const wrap = el('div', { class: 'chat' });
  const log = el('div', { class: 'chat-log', id: 'chat-log' });
  const tray = el('div', { class: 'att-tray', id: 'att-tray' });
  const fileInput = el('input', { type: 'file', accept: 'image/*,video/*', multiple: '', id: 'att-file', style: 'display:none' });
  const attBtn = el('button', { class: 'comp-btn', id: 'att-btn', title: 'Attach photo/video' }, '＋');
  const micBtn = el('button', { class: 'comp-btn', id: 'mic-btn', title: 'Voice note' }, '🎤');
  const ta = el('textarea', { id: 'chat-input', rows: '1', placeholder: 'Message Hermes…', enterkeyhint: 'send' });
  const send = el('button', { class: 'send', id: 'chat-send' }, '↑');
  const composer = el('div', { class: 'composer' }, attBtn, micBtn, ta, send);
  wrap.append(log, tray, composer, fileInput);
  v.append(wrap);

  chatState.messages.forEach(m => log.append(renderMessage(m)));
  log.scrollTop = log.scrollHeight;
  if (!chatState.messages.length)
    log.append(el('div', { class: 'empty' }, 'Talk to Hermes. Send text, photos, video or a voice note.'));

  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  send.addEventListener('click', sendChat);
  attBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', onFilesPicked);
  micBtn.addEventListener('click', toggleRecord);
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    micBtn.classList.add('disabled'); micBtn.title = 'Voice recording needs HTTPS';
  }
  // On focus, scroll to the latest message. The tab bar is hidden ONLY when the
  // keyboard actually opens (handled by setupViewport via visualViewport), so the
  // nav bar never vanishes on desktop where focusing brings up no keyboard.
  ta.addEventListener('focus', () => setTimeout(() => { const l = $('#chat-log'); if (l) l.scrollTop = l.scrollHeight; }, 300));
  renderAttTray();
}

// ----- media helpers -----
function fileToDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function resizeImage(file, max = 1280, quality = 0.85) {
  return new Promise(async (res) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}
// Robust on iOS: video must be in the DOM, muted, playsinline, primed with play/pause;
// each seek has a timeout fallback that captures the current frame; hard overall cap.
function sampleVideo(file, n = 3, max = 1000) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const vid = document.createElement('video');
    vid.muted = true; vid.defaultMuted = true; vid.playsInline = true;
    vid.setAttribute('playsinline', ''); vid.setAttribute('webkit-playsinline', ''); vid.setAttribute('muted', '');
    vid.preload = 'auto';
    vid.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(vid);
    const frames = []; let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { document.body.removeChild(vid); } catch {}
      URL.revokeObjectURL(url);
      resolve({ thumb: frames[0] || null, frames });
    };
    const capture = () => {
      try {
        let w = vid.videoWidth, h = vid.videoHeight;
        if (!w || !h) return;
        if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(vid, 0, 0, w, h);
        frames.push(c.toDataURL('image/jpeg', 0.8));
      } catch {}
    };
    const seekTo = (t) => new Promise((res) => {
      let to = setTimeout(() => { vid.removeEventListener('seeked', onSeek); capture(); res(); }, 1800);
      const onSeek = () => { clearTimeout(to); vid.removeEventListener('seeked', onSeek); capture(); res(); };
      vid.addEventListener('seeked', onSeek);
      try { vid.currentTime = t; } catch { clearTimeout(to); capture(); res(); }
    });
    setTimeout(finish, 15000); // hard cap
    vid.onerror = finish;
    vid.onloadeddata = async () => {
      try { await vid.play().catch(() => {}); vid.pause(); } catch {}
      const dur = isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 0;
      if (dur <= 0) { capture(); return finish(); }
      const times = Array.from({ length: n }, (_, i) => Math.min(dur * (i + 0.5) / n, Math.max(0, dur - 0.1)));
      for (const t of times) { if (done) break; await seekTo(t); }
      finish();
    };
    vid.src = url;
    vid.load();
  });
}

async function onFilesPicked(e) {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) {
    if (f.type.startsWith('image/')) {
      const url = await resizeImage(f);
      if (url) chatState.atts.push({ kind: 'image', url });
    } else if (f.type.startsWith('video/')) {
      toast('Processing video…');
      const { thumb, frames } = await sampleVideo(f);
      if (frames.length) chatState.atts.push({ kind: 'video', url: thumb, frames });
      else toast('Could not read video', true);
    }
  }
  renderAttTray();
}

function renderAttTray() {
  const tray = $('#att-tray'); if (!tray) return;
  tray.innerHTML = '';
  tray.style.display = chatState.atts.length ? 'flex' : 'none';
  chatState.atts.forEach((a, i) => {
    const chip = el('div', { class: 'att-chip' },
      el('img', { src: a.url }),
      a.kind === 'video' ? el('span', { class: 'att-badge' }, '▶') : null,
      el('button', { class: 'att-x', onclick: () => { chatState.atts.splice(i, 1); renderAttTray(); } }, '×'));
    tray.append(chip);
  });
}

// ----- voice recording -----
async function toggleRecord() {
  const btn = $('#mic-btn');
  if (chatState.rec) { chatState.rec.stop(); return; }
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    toast('Voice recording needs HTTPS (see Settings)', true); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording'); chatState.rec = null;
      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      const dataUrl = await fileToDataURL(blob);
      toast('Transcribing…');
      try {
        const r = await apiPOST('/audio/transcribe', { data_url: dataUrl, mime_type: blob.type });
        const text = r.transcript || r.text || '';
        if (!text) { toast('No speech detected', true); return; }
        sendChat({ text, media: [{ kind: 'audio', url: dataUrl, transcript: text }] });
      } catch (err) { toast('Transcription failed', true); }
    };
    chatState.rec = mr; mr.start(); btn.classList.add('recording'); toast('Recording… tap 🎤 to stop');
  } catch (e) { toast('Mic permission denied', true); }
}

// ----- rendering -----
function renderMessage(m) {
  const isUser = m.role === 'user';
  const box = el('div', { class: 'msg ' + (isUser ? 'user' : 'bot') });
  const text = typeof m.content === 'string' ? m.content
    : (m.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  (m.media || []).forEach(med => {
    if (med.kind === 'image') box.append(el('img', { class: 'msg-img', src: med.url }));
    else if (med.kind === 'video') box.append(el('div', { class: 'msg-video' }, el('img', { class: 'msg-img', src: med.url }), el('span', { class: 'att-badge' }, '▶ video')));
    else if (med.kind === 'audio') {
      const a = new Audio(med.url);
      box.append(el('button', { class: 'voice-bubble', onclick: () => { a.currentTime = 0; a.play(); } }, '▶ Voice note'));
    }
  });
  if (text) {
    if (isUser) box.append(el('div', {}, text));
    else box.append(el('div', { class: 'bot-text', html: mdLite(text) }));
  }
  if (!isUser && text) box.append(speakBtn(text));
  return box;
}

function speakBtn(text) {
  const b = el('button', { class: 'speak-btn', title: 'Play aloud' }, '🔊');
  b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '…';
    try {
      const r = await apiPOST('/audio/speak', { text });
      if (r.data_url) { const a = new Audio(r.data_url); a.play(); }
    } catch { toast('TTS failed', true); }
    finally { b.disabled = false; b.textContent = '🔊'; }
  });
  return b;
}

// ----- send -----
async function sendChat(voice) {
  if (chatState.streaming) return;
  const ta = $('#chat-input');
  const text = voice ? voice.text : (ta ? ta.value.trim() : '');
  const atts = voice ? [] : chatState.atts.slice();
  const media = voice ? voice.media : [];
  if (!text && !atts.length) return;
  const log = $('#chat-log');
  $('.empty', log)?.remove();
  if (ta && !voice) { ta.value = ''; ta.style.height = 'auto'; }

  // build API content
  let content;
  const imgParts = [];
  atts.forEach(a => {
    if (a.kind === 'image') imgParts.push({ type: 'image_url', image_url: { url: a.url } });
    else if (a.kind === 'video') a.frames.forEach(f => imgParts.push({ type: 'image_url', image_url: { url: f } }));
  });
  if (imgParts.length) {
    const parts = [];
    const hasVideo = atts.some(a => a.kind === 'video');
    parts.push({ type: 'text', text: text || (hasVideo ? 'Here is a video (sampled frames).' : 'Here is an image.') });
    parts.push(...imgParts);
    content = parts;
  } else content = text;

  // display media: thumbnails for images, video thumb; voice bubble
  const dispMedia = voice ? media : atts.map(a => ({ kind: a.kind, url: a.url }));
  const userMsg = { role: 'user', content, media: dispMedia };
  chatState.messages.push(userMsg);
  log.append(renderMessage(userMsg));
  chatState.atts = []; renderAttTray();
  log.scrollTop = log.scrollHeight;

  chatState.streaming = true;
  const botMsg = { role: 'assistant', content: '' };
  const botEl = renderMessage(botMsg);
  const botText = el('div', { class: 'bot-text' });
  const typing = el('div', { class: 'typing' }, '…');
  log.append(typing); log.scrollTop = log.scrollHeight;

  let acc = '';
  try {
    const apiMessages = chatState.messages.map(m => ({ role: m.role, content: m.content }));
    const r = await fetch('/__chat', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: apiMessages, stream: true }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) throw new Error('gateway ' + r.status);
    typing.remove();
    const shell = el('div', { class: 'msg bot' });
    const toolSteps = el('div', { class: 'tool-steps' });  // shows the agent's tool calls live
    shell.append(toolSteps, botText);
    log.append(shell);
    const stepEls = {};
    const handleTool = (p) => {
      toolSteps.classList.add('show');
      let s = stepEls[p.toolCallId];
      if (!s) {
        s = el('div', { class: 'tool-step running' },
          el('span', { class: 'ts-emoji' }, p.emoji || '🔧'),
          el('span', { class: 'ts-label' }, p.label || p.tool || 'tool'),
          el('span', { class: 'ts-stat' }));
        stepEls[p.toolCallId || ('s' + toolSteps.children.length)] = s;
        toolSteps.append(s);
      }
      if (p.status === 'completed' || p.status === 'error') {
        s.classList.remove('running');
        s.classList.add(p.status === 'error' ? 'err' : 'done');
      }
      log.scrollTop = log.scrollHeight;
    };
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    let curEvent = 'message';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t === '') { curEvent = 'message'; continue; }
        if (t.startsWith('event:')) { curEvent = t.slice(6).trim(); continue; }
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim(); if (data === '[DONE]') continue;
        if (curEvent === 'hermes.tool.progress') {
          try { handleTool(JSON.parse(data)); } catch {}
        } else {
          try { const j = JSON.parse(data); const d = j.choices?.[0]?.delta?.content; if (d) { acc += d; botText.innerHTML = mdLite(acc); log.scrollTop = log.scrollHeight; } } catch {}
        }
      }
    }
    if (acc) shell.append(speakBtn(acc));
  } catch (e) {
    typing.remove();
    log.append(el('div', { class: 'msg bot', html: mdLite('⚠️ ' + (e.message || 'error')) }));
  } finally {
    chatState.streaming = false;
    if (acc) chatState.messages.push({ role: 'assistant', content: acc });
    log.scrollTop = log.scrollHeight;
  }
}

// ---------- STATUS ----------
async function viewStatus(v) {
  loading(v);
  try {
    const [st, sys, mem] = await Promise.all([
      apiGET('/status').catch(() => null),
      apiGET('/system/stats').catch(() => null),
      apiGET('/memory').catch(() => null),
    ]);
    v.innerHTML = '';

    const gwState = st?.gateway_state || 'unknown';
    setStatusDot(gwState === 'running' ? 'good' : 'bad');

    v.append(el('div', { class: 'stat-grid' },
      stat('Gateway', gwState, gwState === 'running' ? 'good' : 'bad'),
      stat('Active sessions', st?.active_sessions ?? '—'),
    ));

    // platforms
    const plats = st?.gateway_platforms || {};
    const pcard = el('div', { class: 'card' }, el('h2', {}, 'Channels'));
    if (Object.keys(plats).length) {
      for (const [name, info] of Object.entries(plats)) {
        const ok = info.state === 'connected';
        pcard.append(el('div', { class: 'row' },
          el('span', { class: 'k' }, name),
          el('span', { class: 'pill ' + (ok ? 'good' : 'bad') }, info.state + (info.error_message ? ' · ' + info.error_message : ''))));
      }
    } else pcard.append(el('div', { class: 'muted' }, 'No channel data'));
    v.append(pcard);

    // version / paths
    v.append(card('System', [
      ['Version', st?.version], ['Released', st?.release_date],
      ['Config version', (st?.config_version) + ' / ' + (st?.latest_config_version)],
      ['Hermes home', st?.hermes_home], ['Gateway PID', st?.gateway_pid],
    ]));

    if (sys) {
      const rows = [];
      const cpu = sys.cpu_percent ?? sys.cpu;
      const m = sys.memory || sys.mem || {};
      if (cpu != null) rows.push(['CPU', (typeof cpu === 'number' ? cpu.toFixed(0) + '%' : cpu)]);
      if (m.percent != null) rows.push(['Memory', m.percent + '%']);
      if (m.used != null) rows.push(['Mem used', fmtBytes(m.used) + (m.total ? ' / ' + fmtBytes(m.total) : '')]);
      const disk = sys.disk || {};
      if (disk.percent != null) rows.push(['Disk', disk.percent + '%']);
      if (sys.uptime != null) rows.push(['Uptime', typeof sys.uptime === 'number' ? Math.floor(sys.uptime / 3600) + 'h' : sys.uptime]);
      if (rows.length) v.append(card('Host', rows));
      else v.append(dumpCard('Host stats', sys));
    }

    if (mem) {
      const provider = mem.provider || mem.backend || mem.type;
      v.append(card('Long-term memory', [
        ['Provider', provider], ['Status', mem.status || mem.state || (mem.healthy ? 'healthy' : '')],
        ['Records', mem.count ?? mem.records ?? mem.total],
      ]));
    }
  } catch (e) { v.innerHTML = ''; v.append(errCard(e)); }
}

function setStatusDot(cls) { const d = $('#status-dot'); d.className = 'dot ' + cls; }
function stat(label, value, cls) {
  return el('div', { class: 'stat' }, el('div', { class: 'label' }, label),
    el('div', { class: 'value' + (cls ? ' ' : ''), style: cls ? `color:var(--${cls})` : '' }, String(value)));
}
function card(title, rows) {
  const c = el('div', { class: 'card' }, el('h2', {}, title));
  for (const [k, val] of rows) {
    if (val == null || val === '' || String(val).includes('undefined')) continue;
    c.append(el('div', { class: 'row' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, String(val))));
  }
  return c;
}
function dumpCard(title, obj) {
  return el('div', { class: 'card' }, el('h2', {}, title), el('pre', {}, JSON.stringify(obj, null, 2)));
}

// ---------- OPS ----------
let opsTab = 'crons';
async function viewOps(v) {
  const seg = el('div', { class: 'seg' });
  ['crons', 'gateway', 'sessions', 'maint'].forEach(t => {
    seg.append(el('button', { class: opsTab === t ? 'active' : '', onclick: () => { opsTab = t; setView('ops'); } },
      ({ crons: 'Crons', gateway: 'Gateway', sessions: 'Sessions', maint: 'Maint' })[t]));
  });
  v.append(seg);
  const body = el('div', {}); v.append(body); loading(body);  // spinner stays until data arrives
  try {
    if (opsTab === 'crons') await opsCrons(body);
    else if (opsTab === 'gateway') await opsGateway(body);
    else if (opsTab === 'sessions') await opsSessions(body);
    else await opsMaint(body);
  } catch (e) { body.innerHTML = ''; body.append(errCard(e)); }
}

async function opsCrons(body) {
  const data = await apiGET('/cron/jobs');
  body.innerHTML = '';
  const jobs = Array.isArray(data) ? data : (data.jobs || []);
  if (!jobs.length) { body.append(el('div', { class: 'empty' }, 'No cron jobs')); return; }
  for (const j of jobs) {
    const id = j.id || j.job_id || j.name;
    const status = (j.last_status || j.last_run_status || '').toLowerCase();
    const ok = ['ok', 'success', 'succeeded'].includes(status);
    const paused = j.paused || j.enabled === false;
    const c = el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('span', { class: 'v', style: 'text-align:left' }, j.name || id),
        el('span', { class: 'pill ' + (paused ? 'warn' : ok ? 'good' : status ? 'bad' : '') }, paused ? 'paused' : (status || 'idle'))),
      card('', [
        ['Schedule', j.schedule_display || j.schedule?.display || j.schedule?.expr || j.cron || j.interval],
        ['Model', j.model],
        ['Last run', (j.last_run_at || j.last_run) ? fmtTime(j.last_run_at || j.last_run) + ' (' + ago(j.last_run_at || j.last_run) + ')' : null],
        ['Script', j.script || j.command],
      ]),
    );
    const btns = el('div', { class: 'btn-grid' });
    btns.append(el('button', { class: 'btn primary', onclick: () => actOps(`/cron/jobs/${id}/trigger`, 'Triggered') }, '▶ Run now'));
    if (paused) btns.append(el('button', { class: 'btn', onclick: () => actOps(`/cron/jobs/${id}/resume`, 'Resumed') }, 'Resume'));
    else btns.append(el('button', { class: 'btn', onclick: () => actOps(`/cron/jobs/${id}/pause`, 'Paused') }, 'Pause'));
    c.append(btns);
    body.append(c);
  }
}

async function actOps(path, okMsg) {
  try { await apiPOST(path); toast(okMsg); setView(currentView); }
  catch (e) { toast(e.message || 'failed', true); }
}

async function opsGateway(body) {
  const st = await apiGET('/status').catch(() => ({}));
  body.innerHTML = '';
  body.append(card('Gateway', [['State', st.gateway_state], ['PID', st.gateway_pid]]));
  const g = el('div', { class: 'btn-grid' },
    el('button', { class: 'btn primary', onclick: () => confirmAct('/gateway/restart', 'Restart gateway?', 'Restarting') }, '⟳ Restart'),
    el('button', { class: 'btn', onclick: () => confirmAct('/gateway/start', 'Start gateway?', 'Starting') }, '▶ Start'),
    el('button', { class: 'btn bad', onclick: () => confirmAct('/gateway/stop', 'Stop gateway?', 'Stopping') }, '■ Stop'),
  );
  body.append(el('div', { class: 'card' }, el('h2', {}, 'Controls'), g));

  // update check
  body.append(el('div', { class: 'card' }, el('h2', {}, 'Updates'),
    el('button', { class: 'btn block', onclick: async () => {
      try { const u = await apiGET('/hermes/update/check'); toast(u.update_available ? 'Update available: ' + (u.latest || '') : 'Up to date'); }
      catch (e) { toast(e.message, true); }
    } }, 'Check for Hermes update')));
}

async function confirmAct(path, q, okMsg) {
  if (!confirm(q)) return;
  try { await apiPOST(path); toast(okMsg); setTimeout(() => setView(currentView), 1500); }
  catch (e) { toast(e.message || 'failed', true); }
}

async function opsSessions(body) {
  const data = await apiGET('/sessions');
  body.innerHTML = '';
  const sessions = Array.isArray(data) ? data : (data.sessions || data.items || []);
  body.append(el('div', { class: 'btn-grid' },
    el('button', { class: 'btn', onclick: async () => { try { const c = await apiGET('/sessions/empty/count'); if (confirm(`Delete ${c.count ?? c} empty sessions?`)) { await apiDEL('/sessions/empty'); toast('Pruned'); setView('ops'); } } catch (e) { toast(e.message, true); } } }, 'Prune empty'),
    el('button', { class: 'btn', onclick: () => setView('ops') }, '⟳ Reload'),
  ));
  if (!sessions.length) { body.append(el('div', { class: 'empty' }, 'No sessions')); return; }
  for (const s of sessions.slice(0, 40)) {
    const id = s.id || s.session_id;
    const c = el('div', { class: 'card', onclick: () => openSession(id, s) });
    c.append(el('div', { class: 'row' },
      el('span', { class: 'v', style: 'text-align:left' }, s.title || s.name || id?.slice(0, 12)),
      el('span', { class: 'pill' }, (s.message_count ?? s.messages ?? '?') + ' msgs')));
    c.append(el('div', { class: 'muted', style: 'font-size:13px' },
      (s.channel || s.platform || '') + ' · ' + ago(s.updated_at || s.last_active || s.created_at)));
    body.append(c);
  }
}

async function openSession(id, s) {
  const body = $('#view'); body.innerHTML = '';
  body.append(el('button', { class: 'btn', onclick: () => setView('ops') }, '‹ Back'));
  const head = el('div', { class: 'card' }, el('h2', {}, s.title || s.name || 'Session'));
  head.append(el('button', { class: 'btn bad block', onclick: async () => { if (confirm('Delete this session?')) { await apiDEL('/sessions/' + id); toast('Deleted'); setView('ops'); } } }, 'Delete session'));
  body.append(head);
  loading(body);
  try {
    const data = await apiGET('/sessions/' + id + '/messages');
    const msgs = Array.isArray(data) ? data : (data.messages || []);
    $('.spinner', body)?.remove();
    msgs.slice(-60).forEach(m => {
      const role = m.role || m.author || 'assistant';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      body.append(el('div', { class: 'msg ' + (role === 'user' ? 'user' : 'bot'), html: role === 'user' ? null : mdLite(content) }, role === 'user' ? content : null));
    });
  } catch (e) { $('.spinner', body)?.remove(); body.append(errCard(e)); }
}

async function opsMaint(body) {
  body.innerHTML = '';
  const ops = [
    ['/ops/doctor', 'Run Doctor', 'Diagnostics'],
    ['/ops/backup', 'Run Backup', 'Backup config + state'],
    ['/ops/security-audit', 'Security Audit', 'Scan for risks'],
    ['/curator/run', 'Run Curator', 'Memory curation'],
  ];
  const grid = el('div', { class: 'card' }, el('h2', {}, 'Maintenance'));
  ops.forEach(([p, label, desc]) => {
    grid.append(el('button', { class: 'btn block', style: 'margin-bottom:8px', onclick: async () => {
      toast('Running ' + label + '…'); try { const r = await apiPOST(p); showResult(label, r); } catch (e) { toast(e.message, true); }
    } }, label));
  });
  body.append(grid);

  // logs
  body.append(el('div', { class: 'card' }, el('h2', {}, 'Logs'),
    el('button', { class: 'btn block', onclick: async () => {
      try { const l = await apiGET('/logs?lines=200'); showResult('Logs', l); } catch (e) { toast(e.message, true); }
    } }, 'View recent logs')));
}

function showResult(title, data) {
  const body = $('#view'); body.innerHTML = '';
  body.append(el('button', { class: 'btn', onclick: () => setView(currentView) }, '‹ Back'));
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  body.append(el('div', { class: 'card' }, el('h2', {}, title), el('pre', {}, text)));
}

// ---------- SETTINGS (menu -> detail panels) ----------
let settingsDetail = null;
const SETTINGS_CATS = [
  ['models', '🧠', 'Models', 'Default + auxiliary routing', () => setModels],
  ['tools', '🧰', 'Tools', 'Enable/disable toolsets', () => setTools],
  ['skills', '✨', 'Skills', 'Toggle agent skills', () => setSkills],
  ['mcp', '🔌', 'MCP servers', 'External tool servers', () => setMcp],
  ['memory', '🧩', 'Memory', 'Long-term memory provider', () => setMemory],
  ['channels', '📡', 'Channels', 'Messaging platforms', () => setChannels],
  ['env', '🔑', 'Environment', 'Env vars & secrets', () => setEnv],
  ['config', '📄', 'Config', 'Raw config.yaml', () => setConfig],
  ['curator', '🗂️', 'Curator', 'Memory maintenance', () => setCurator],
  ['notify', '🔔', 'Notifications', 'Push alerts', () => setNotify],
];

function viewSettings(v) {
  const cat = SETTINGS_CATS.find(c => c[0] === settingsDetail);
  if (cat) {
    v.append(el('button', { class: 'btn', style: 'margin-bottom:12px', onclick: () => { settingsDetail = null; setView('settings'); } }, '‹ Settings'));
    v.append(el('h2', { style: 'margin:0 0 12px; font-size:20px' }, cat[2]));
    const body = el('div', {}); v.append(body); loading(body);
    cat[4]()(body).catch(e => { body.innerHTML = ''; body.append(errCard(e)); });
    return;
  }
  const list = el('div', { class: 'card' });
  SETTINGS_CATS.forEach(([id, icon, name, desc]) => {
    list.append(el('div', { class: 'menu-row', onclick: () => { settingsDetail = id; setView('settings'); } },
      el('span', { class: 'mr-icon' }, icon),
      el('div', { class: 'mr-body' }, el('div', { class: 'mr-name' }, name), el('div', { class: 'mr-desc' }, desc)),
      el('span', { class: 'mr-chev' }, '›')));
  });
  v.append(list);
}

// A toggle switch that calls onToggle(newValue) then lets the caller re-render.
function toggleSwitch(enabled, onToggle) {
  const t = el('button', { class: 'toggle' + (enabled ? ' on' : '') });
  t.addEventListener('click', async () => {
    if (t.classList.contains('busy')) return;
    t.classList.add('busy');
    try { await onToggle(!enabled); } catch (e) { toast(e.message || 'failed', true); t.classList.remove('busy'); }
  });
  return t;
}
const reSettings = () => setView('settings');

async function setModels(body) {
  const [info, opts, aux] = await Promise.all([
    apiGET('/model/info').catch(() => ({})),
    apiGET('/model/options').catch(() => ({})),
    apiGET('/model/auxiliary').catch(() => ({})),
  ]);
  body.innerHTML = '';
  body.append(card('Default model', [
    ['Model', info.model], ['Provider', info.provider],
    ['Context', info.effective_context_length ? Math.round(info.effective_context_length / 1000) + 'k' : null],
  ]));
  if (aux.tasks && aux.tasks.length) {
    const c = el('div', { class: 'card' }, el('h2', {}, `Auxiliary models (${aux.tasks.length})`));
    aux.tasks.forEach(t => c.append(el('div', { class: 'row' },
      el('span', { class: 'k' }, t.task), el('span', { class: 'v' }, t.model || '—'))));
    body.append(c);
  }
  const provs = opts.providers || [];
  if (provs.length) {
    const c = el('div', { class: 'card' }, el('h2', {}, `Switch model — ${provs.length} providers`));
    provs.forEach(p => {
      const row = el('div', { class: 'menu-row', onclick: () => showProviderModels(p) },
        el('div', { class: 'mr-body' }, el('div', { class: 'mr-name' }, (p.name || p.slug) + (p.is_current ? ' ✓' : '')),
          el('div', { class: 'mr-desc' }, (p.total_models ?? (p.models || []).length) + ' models')),
        el('span', { class: 'mr-chev' }, '›'));
      c.append(row);
    });
    body.append(c);
  }
}
function showProviderModels(p) {
  const v = $('#view'); v.innerHTML = '';
  v.append(el('button', { class: 'btn', style: 'margin-bottom:12px', onclick: reSettings }, '‹ Back'));
  v.append(el('h2', { style: 'margin:0 0 10px' }, p.name || p.slug));
  const models = (p.models || []).map(m => typeof m === 'string' ? m : (m.id || m.slug || m.name)).filter(Boolean);
  const c = el('div', { class: 'card' });
  const search = el('input', { placeholder: `Filter ${models.length} models…`, oninput: (e) => {
    const q = e.target.value.toLowerCase();
    $$('.mdl-row', c).forEach(r => r.style.display = r.dataset.m.includes(q) ? '' : 'none');
  } });
  v.append(el('label', { class: 'field' }, search));
  models.slice(0, 300).forEach(id => {
    c.append(el('div', { class: 'row mdl-row', 'data-m': id.toLowerCase() },
      el('span', { class: 'k', style: 'color:var(--text);font-size:13px' }, id),
      el('button', { class: 'pill', onclick: async () => {
        if (!confirm('Set the default routing model to ' + id + '?')) return;
        try { await apiPOST('/model/set', { scope: 'default', provider: p.slug, model: id }); toast('Default model set'); settingsDetail = 'models'; reSettings(); }
        catch (e) { toast(e.message, true); }
      } }, 'set')));
  });
  v.append(c);
}

async function setTools(body) {
  const data = await apiGET('/tools/toolsets');
  body.innerHTML = '';
  const list = Array.isArray(data) ? data : (data.toolsets || []);
  const c = el('div', { class: 'card' }, el('h2', {}, `Toolsets (${list.length})`));
  list.forEach(ts => {
    const sub = (ts.tools ? ts.tools.length : 0) + ' tools'
      + (ts.available === false ? ' · unavailable' : '') + (ts.configured === false ? ' · not configured' : '');
    c.append(el('div', { class: 'row' },
      el('div', { class: 'mr-body' }, el('div', { class: 'mr-name' }, ts.label || ts.name), el('div', { class: 'mr-desc' }, sub)),
      toggleSwitch(!!ts.enabled, async (val) => { await apiPUT('/tools/toolsets/' + encodeURIComponent(ts.name), { enabled: val }); toast((ts.label || ts.name) + (val ? ' enabled' : ' disabled')); reSettings(); })));
  });
  body.append(c);
}

async function setSkills(body) {
  const data = await apiGET('/skills');
  body.innerHTML = '';
  const skills = Array.isArray(data) ? data : (data.skills || []);
  const c = el('div', { class: 'card' }, el('h2', {}, `Skills (${skills.length})`));
  const search = el('input', { placeholder: 'Filter skills…', oninput: (e) => {
    const q = e.target.value.toLowerCase(); $$('.sk-row', c).forEach(r => r.style.display = r.dataset.n.includes(q) ? '' : 'none');
  } });
  c.append(el('label', { class: 'field' }, search));
  skills.forEach(s => {
    const name = s.name || s.id; const enabled = s.enabled ?? s.active ?? false;
    c.append(el('div', { class: 'row sk-row', 'data-n': String(name).toLowerCase() },
      el('div', { class: 'mr-body' }, el('div', { class: 'mr-name', style: 'font-size:14px' }, name)),
      toggleSwitch(!!enabled, async (val) => { await apiPUT('/skills/toggle', { name, enabled: val }); toast(name + (val ? ' on' : ' off')); reSettings(); })));
  });
  body.append(c);
}

async function setMcp(body) {
  const data = await apiGET('/mcp/servers');
  body.innerHTML = '';
  const servers = data.servers || [];
  const c = el('div', { class: 'card' }, el('h2', {}, `MCP servers (${servers.length})`));
  if (!servers.length) c.append(el('div', { class: 'muted' }, 'No MCP servers configured'));
  servers.forEach(s => {
    c.append(el('div', { class: 'row' },
      el('div', { class: 'mr-body' }, el('div', { class: 'mr-name' }, s.name), el('div', { class: 'mr-desc' }, (s.transport || '') + ' · ' + ((s.tools || []).length) + ' tools')),
      toggleSwitch(!!s.enabled, async (val) => { await apiPUT('/mcp/servers/' + encodeURIComponent(s.name) + '/enabled', { enabled: val }); toast(s.name + (val ? ' enabled' : ' disabled')); reSettings(); })));
    c.append(el('div', { class: 'btn-grid', style: 'margin:6px 0 4px' },
      el('button', { class: 'btn', onclick: async () => { toast('Testing ' + s.name + '…'); try { const r = await apiPOST('/mcp/servers/' + encodeURIComponent(s.name) + '/test'); toast(r && r.ok === false ? 'Test failed' + (r.error ? ': ' + r.error : '') : 'Test OK'); } catch (e) { toast(e.message, true); } } }, 'Test'),
      el('button', { class: 'btn bad', onclick: async () => { if (!confirm('Remove MCP server ' + s.name + '?')) return; try { await apiDEL('/mcp/servers/' + encodeURIComponent(s.name)); toast('Removed'); reSettings(); } catch (e) { toast(e.message, true); } } }, 'Remove')));
  });
  body.append(c);
}

async function setMemory(body) {
  const data = await apiGET('/memory');
  body.innerHTML = '';
  body.append(card('Memory', [['Active provider', data.active]]));
  const provs = data.providers || [];
  const c = el('div', { class: 'card' }, el('h2', {}, `Providers (${provs.length})`));
  provs.forEach(p => {
    const cur = p.name === data.active;
    c.append(el('div', { class: 'row' },
      el('div', { class: 'mr-body' }, el('div', { class: 'mr-name' }, p.name + (cur ? ' ✓' : '')), el('div', { class: 'mr-desc' }, (p.description || '') + (p.configured === false ? ' · not configured' : ''))),
      cur ? el('span', { class: 'pill good' }, 'active')
        : el('button', { class: 'pill', onclick: async () => { if (!confirm('Switch memory provider to ' + p.name + '?')) return; try { await apiPUT('/memory/provider', { provider: p.name }); toast('Memory provider set'); reSettings(); } catch (e) { toast(e.message, true); } } }, 'use')));
  });
  body.append(c);
  body.append(el('div', { class: 'card' }, el('h2', {}, 'Maintenance'),
    el('button', { class: 'btn bad block', onclick: async () => { if (!confirm('Reset long-term memory? This can erase stored memories.')) return; try { await apiPOST('/memory/reset'); toast('Memory reset'); } catch (e) { toast(e.message, true); } } }, 'Reset memory')));
}

async function setChannels(body) {
  const data = await apiGET('/messaging/platforms');
  body.innerHTML = '';
  const plats = data.platforms || [];
  const search = el('input', { placeholder: `Filter ${plats.length} channels…`, oninput: (e) => {
    const q = e.target.value.toLowerCase(); $$('.ch-row', body).forEach(r => r.style.display = r.dataset.n.includes(q) ? '' : 'none');
  } });
  body.append(el('label', { class: 'field' }, search));
  const c = el('div', { class: 'card' });
  plats.forEach(p => {
    const sub = (p.state ? p.state : (p.configured ? 'configured' : 'not configured')) + (p.error_message ? ' · ' + p.error_message : '');
    c.append(el('div', { class: 'row ch-row', 'data-n': (p.name + ' ' + p.id).toLowerCase() },
      el('div', { class: 'mr-body' }, el('div', { class: 'mr-name', style: 'font-size:14px' }, p.name), el('div', { class: 'mr-desc' }, sub)),
      toggleSwitch(!!p.enabled, async (val) => { await apiPUT('/messaging/platforms/' + encodeURIComponent(p.id), { enabled: val }); toast(p.name + (val ? ' enabled' : ' disabled')); reSettings(); })));
  });
  body.append(c);
}

async function setEnv(body) {
  const data = await apiGET('/env');
  body.innerHTML = '';
  const names = Array.isArray(data) ? data : Object.keys(data || {});
  // add / set a variable
  const k = el('input', { placeholder: 'KEY', style: 'text-transform:uppercase' });
  const val = el('input', { placeholder: 'value' });
  body.append(el('div', { class: 'card' }, el('h2', {}, 'Set variable'),
    el('label', { class: 'field' }, k), el('label', { class: 'field' }, val),
    el('button', { class: 'btn primary block', onclick: async () => {
      if (!k.value.trim()) return;
      if (!confirm('Set ' + k.value + '? Hermes may need a restart to pick it up.')) return;
      try { await apiPUT('/env', { key: k.value.trim(), value: val.value }); toast('Saved ' + k.value); reSettings(); } catch (e) { toast(e.message, true); }
    } }, 'Save variable')));
  const c = el('div', { class: 'card' }, el('h2', {}, `Environment (${names.length})`));
  const search = el('input', { placeholder: 'Filter…', oninput: (e) => {
    const q = e.target.value.toLowerCase(); $$('.env-row', c).forEach(r => r.style.display = r.dataset.name.includes(q) ? '' : 'none');
  } });
  c.append(el('label', { class: 'field' }, search));
  names.sort().forEach(name => {
    c.append(el('div', { class: 'row env-row', 'data-name': name.toLowerCase() },
      el('span', { class: 'k', style: 'color:var(--text);font-size:13px' }, name),
      el('button', { class: 'pill', onclick: async (e) => {
        try { const r = await apiPOST('/env/reveal', { key: name }); e.target.textContent = (r.value ?? '(empty)'); e.target.style.color = 'var(--accent)'; }
        catch (err) { toast(err.message, true); }
      } }, 'reveal')));
  });
  body.append(c);
}

async function setConfig(body) {
  const raw = await apiGET('/config/raw');
  body.innerHTML = '';
  const text = typeof raw === 'string' ? raw : (raw.content || raw.raw || JSON.stringify(raw, null, 2));
  const ta = el('textarea', { rows: '20', style: 'font-family:monospace;font-size:12px' }, text);
  body.append(el('div', { class: 'card' }, el('h2', {}, 'config.yaml (raw)'), ta,
    el('button', { class: 'btn primary block', style: 'margin-top:10px', onclick: async () => {
      if (!confirm('Save config.yaml? Hermes may reload.')) return;
      try { await apiPUT('/config/raw', { content: ta.value }); toast('Saved'); } catch (e) { toast(e.message, true); }
    } }, 'Save config')));
}

async function setCurator(body) {
  const d = await apiGET('/curator');
  body.innerHTML = '';
  body.append(card('Curator', [
    ['Enabled', String(d.enabled)],
    ['Interval', d.interval_hours ? d.interval_hours + 'h' : null],
    ['Last run', d.last_run_at ? fmtTime(d.last_run_at) + ' (' + ago(d.last_run_at) + ')' : null],
    ['Stale after', d.stale_after_days ? d.stale_after_days + 'd' : null],
    ['Archive after', d.archive_after_days ? d.archive_after_days + 'd' : null],
  ]));
  const c = el('div', { class: 'card' }, el('h2', {}, 'Controls'));
  c.append(el('div', { class: 'row' }, el('span', { class: 'k', style: 'color:var(--text)' }, 'Paused'),
    toggleSwitch(!!d.paused, async (val) => { await apiPUT('/curator/paused', { paused: val }); toast(val ? 'Paused' : 'Resumed'); reSettings(); })));
  c.append(el('button', { class: 'btn primary block', style: 'margin-top:10px', onclick: async () => {
    toast('Running curator…'); try { const r = await apiPOST('/curator/run'); showResult('Curator run', r); } catch (e) { toast(e.message, true); }
  } }, 'Run curator now'));
  body.append(c);
}

async function setNotify(body) {
  body.innerHTML = '';
  const c = el('div', { class: 'card' }, el('h2', {}, 'Push notifications'),
    el('p', { class: 'muted', style: 'margin-top:0' }, 'Get alerts when the gateway drops, a channel disconnects, or a cron fails. (Requires HTTPS.)'));
  c.append(el('button', { class: 'btn primary block', onclick: enablePush }, 'Enable on this device'));
  c.append(el('button', { class: 'btn block', style: 'margin-top:8px', onclick: async () => {
    try { const r = await fetch('/__push/test', { method: 'POST', credentials: 'same-origin' }); const j = await r.json(); toast(j.subs ? 'Sent to ' + j.subs + ' device(s)' : 'No devices subscribed'); }
    catch (e) { toast('failed', true); }
  } }, 'Send test notification'));
  body.append(c);
}

// ---------- MORE ----------
async function viewMore(v) {
  loading(v);
  try {
    // usage analytics
    const usage = await apiGET('/analytics/usage').catch(() => null);
    v.innerHTML = '';
    if (usage) v.append(dumpCard('Usage', usage));
    // session stats
    const ss = await apiGET('/sessions/stats').catch(() => null);
    if (ss) v.append(dumpCard('Session stats', ss));
  } catch (e) { v.innerHTML = ''; v.append(errCard(e)); }

  const links = el('div', { class: 'card' }, el('h2', {}, 'More'));
  [
    ['Kanban board', async () => { try { showResult('Kanban', await apiGET('/plugins/kanban/board')); } catch (e) { toast(e.message, true); } }],
    ['Profiles', async () => { try { showResult('Profiles', await apiGET('/profiles')); } catch (e) { toast(e.message, true); } }],
    ['Webhooks', async () => { try { showResult('Webhooks', await apiGET('/webhooks')); } catch (e) { toast(e.message, true); } }],
    ['MCP servers', async () => { try { showResult('MCP servers', await apiGET('/mcp/servers')); } catch (e) { toast(e.message, true); } }],
    ['Messaging platforms', async () => { try { showResult('Messaging', await apiGET('/messaging/platforms')); } catch (e) { toast(e.message, true); } }],
    ['Achievements', async () => { try { showResult('Achievements', await apiGET('/plugins/hermes-achievements/achievements')); } catch (e) { toast(e.message, true); } }],
  ].forEach(([label, fn]) => links.append(el('button', { class: 'btn block', style: 'margin-bottom:8px', onclick: fn }, label)));
  v.append(links);

  v.append(el('button', { class: 'btn bad block', onclick: async () => {
    await fetch('/__logout', { method: 'POST', credentials: 'same-origin' }); showLogin();
  } }, 'Log out'));
}

// ---------- Push ----------
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64); return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function enablePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('Push unsupported', true); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Permission denied', true); return; }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await (await fetch('/__push/key', { credentials: 'same-origin' })).json();
    if (!key) { toast('Push not configured on server', true); return; }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    await fetch('/__push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
    toast('Notifications enabled ✅');
  } catch (e) { toast('Push failed: ' + e.message, true); }
}

// ---------- Boot ----------
// Keep the app sized to the *visible* area (above the iOS keyboard) so the
// composer never hides behind it.
function setupViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  let baseH = 0;
  const apply = () => {
    baseH = Math.max(baseH, vv.height);
    document.documentElement.style.setProperty('--app-h', vv.height + 'px');
    // The on-screen keyboard is open only when the visible viewport is much
    // shorter than the tallest we've seen — NOT merely because an input is focused.
    const kbOpen = (baseH - vv.height) > 150;
    document.body.classList.toggle('kb-open', kbOpen);
    if (kbOpen) { const l = $('#chat-log'); if (l) l.scrollTop = l.scrollHeight; window.scrollTo(0, 0); }
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

let _booted = false;
function boot() {
  if (_booted) return; _booted = true;
  $$('.tab').forEach(t => t.addEventListener('click', () => { if (t.dataset.view === 'settings') settingsDetail = null; setView(t.dataset.view); }));
  $('#refresh-btn').addEventListener('click', () => setView(currentView));
  setupViewport();
  setView('chat');
}

$('#login-btn').addEventListener('click', doLogin);
$('#login-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // when a new version takes over, reload once so updates apply automatically
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return; refreshing = true; location.reload();
  });
}

// Paint the cached shell IMMEDIATELY (no network), then verify auth in the
// background — so the UI never waits on a slow request to appear.
showApp(); boot();
fetch('/__me', { credentials: 'same-origin' })
  .then(r => {
    if (r.status === 401) { showLogin(); return; }
    // set the header status dot without needing to open the Status tab
    apiGET('/status').then(st => setStatusDot(st?.gateway_state === 'running' ? 'good' : 'bad')).catch(() => {});
  })
  .catch(() => {});
