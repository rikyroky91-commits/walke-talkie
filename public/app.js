'use strict';

/*
 * Walkie-Talkie su WebSocket — zero WebRTC.
 *
 * Invio:     getUserMedia (AEC/NS/AGC disattivati) -> MediaRecorder webm/opus a chunk
 *            da TIMESLICE ms -> WebSocket (frame binari).
 * Ricezione: WebSocket -> [id 8 byte | chunk] -> MediaSource/SourceBuffer -> <audio>.
 *            Un <audio> per ogni voce attiva (fino a PLAYER_SLOTS in contemporanea):
 *            su Android Chrome li mixa sul canale media (STREAM_MUSIC), non come chiamata.
 * Mic:       aperto solo con la pagina visibile; su visibilitychange(hidden) le tracce
 *            vengono fermate, gli <audio> continuano a suonare in background.
 */

const TIMESLICE = 60;         // ms per chunk: Chrome codifica opus a frame da 60 ms, sotto non serve
const BITRATE = 32000;        // bps opus mono, ottimo per la voce
// La pipeline MSE di Chrome vuole ~200 ms di audio davanti a sé: sotto va in underrun
// (glitch udibile) e dopo ogni underrun alza da sola la soglia di avvio.
const TARGET_LAG = 0.22;      // s: buffer da mantenere
const FAST_LAG = 0.4;         // s: oltre, accelera la riproduzione (1.15x, pitch invariato)
const MAX_LAG = 0.8;          // s: oltre, salta in avanti (glitch udibile, solo in casi estremi)
const PLAYER_SLOTS = 4;       // voci contemporanee (uguale a MAX_SPEAKERS del server)
const DUCK_VOLUME = 0.2;      // volume degli altri mentre parli senza cuffie
const VOX_HANG_MS = 900;      // la trasmissione VOX resta aperta dopo l'ultima voce
const VOX_RX_GUARD_MS = 600;  // niente VOX subito dopo una ricezione (coda dell'altoparlante)
const ID_LEN = 8;             // byte di id di chi parla in testa a ogni frame audio
const PLAY_MIME = 'audio/webm;codecs=opus';
const REC_MIME = ['audio/webm;codecs=opus', 'audio/webm']
  .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
const MSE = window.MediaSource || window.ManagedMediaSource;

const $ = (s) => document.querySelector(s);
const el = {
  join: $('#join'), radio: $('#radio'), joinForm: $('#joinForm'), joinError: $('#joinError'),
  name: $('#name'), channel: $('#channel'), code: $('#code'), compat: $('#compat'),
  chName: $('#chName'), conn: $('#conn'), leave: $('#leave'), status: $('#status'),
  ptt: $('#ptt'), pttLabel: $('#pttLabel'), vox: $('#vox'), mic: $('#mic'),
  voxPanel: $('#voxPanel'), meterBar: $('#meterBar'), meterThr: $('#meterThr'),
  voxThr: $('#voxThr'), voxThrVal: $('#voxThrVal'), volume: $('#volume'),
  headphones: $('#headphones'), keepAlive: $('#keepAlive'),
  users: $('#users'), userCount: $('#userCount'), rtt: $('#rtt'), lag: $('#lag'),
  players: $('#players'), ka: $('#ka'), toast: $('#toast'),
};

const state = {
  joined: false,
  connected: false,
  ws: null,
  backoff: 500,
  myId: null,
  channel: '',
  users: [],
  talkers: new Map(), // id -> {name, player, rx}: chi sta parlando (escluso me)
  rxEndedAt: 0,
  stream: null,
  micOpening: null,
  tx: null,           // trasmissione corrente
  awaiting: [],       // trasmissioni in attesa di floor_granted/denied (FIFO)
  vox: false,
  voxThr: -42,
  voxLastLoud: 0,
  audioCtx: null,
  analyser: null,
  analyserSrc: null,
  busyUntil: 0,
};

/* ---------------------------------------------------------------- Player MSE */

class StreamPlayer {
  constructor() {
    this.audio = document.createElement('audio');
    this.audio.playsInline = true;
    el.players.append(this.audio);
    this.owner = null;    // id di chi sta usando questo lettore
    this.freedAt = 0;
    this.queue = [];
    this.reset();
  }

  reset() {
    this.queue = [];
    this.sb = null;
    this.audio.playbackRate = 1;
    if ('latencyHint' in this.audio) this.audio.latencyHint = 0;  // Chrome sperimentale: buffer minimo
    this.ms = new MSE();
    if (window.ManagedMediaSource && this.ms instanceof window.ManagedMediaSource) {
      this.audio.disableRemotePlayback = true;
    }
    const url = URL.createObjectURL(this.ms);
    this.ms.addEventListener('sourceopen', () => {
      URL.revokeObjectURL(url);
      try {
        this.sb = this.ms.addSourceBuffer(PLAY_MIME);
      } catch (e) {
        toast('Formato audio non supportato: ' + e.message);
        return;
      }
      // "sequence": ogni trasmissione riparte da 0 ma viene accodata alla precedente,
      // così l'<audio> non si ferma mai e riprende da solo quando arrivano dati.
      this.sb.mode = 'sequence';
      this.sb.addEventListener('updateend', () => { this.catchUp(); this.pump(); });
      this.pump();
    }, { once: true });
    this.audio.src = url;
    this.play();
  }

  play() {
    if (this.audio.paused) this.audio.play().catch(() => {});
  }

  // Ogni trasmissione è un nuovo file webm (nuovo header EBML).
  // - Pagina visibile: MediaSource nuova -> pipeline fresca, primo audio in ~0.35 s.
  // - Pagina in background: non si cambia src (un nuovo play() potrebbe essere bloccato),
  //   si accoda allo stesso SourceBuffer resettando il parser con abort(). Funziona sempre
  //   ma Chrome, dopo ogni buffer vuoto, alza la soglia di avvio (~0.6 s).
  beginSegment() {
    if (!document.hidden) { this.reset(); return; }
    this.queue.push('NEW_SEGMENT');
    this.play();
    this.pump();
  }

  push(buf) {
    this.queue.push(buf);
    this.pump();
  }

  pump() {
    const sb = this.sb;
    if (!sb || sb.updating || this.ms.readyState !== 'open') return;
    while (this.queue.length) {
      const item = this.queue.shift();
      if (item === 'NEW_SEGMENT') {
        try { sb.abort(); } catch { /* già pulito */ }
        continue;
      }
      try {
        sb.appendBuffer(item);
      } catch (e) {
        if (e.name === 'QuotaExceededError') {
          this.queue.unshift(item);
          this.evict(true);
        } else {
          console.warn('appendBuffer', e);
          this.reset();
        }
      }
      return;
    }
    this.evict(false);
  }

  // Tiene la latenza vicino a TARGET_LAG: piccoli ritardi si recuperano accelerando
  // (impercettibile), quelli grandi saltando in avanti.
  catchUp() {
    const a = this.audio;
    const b = a.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    const lag = end - a.currentTime;
    if (lag > MAX_LAG) {
      a.currentTime = Math.max(b.start(b.length - 1), end - TARGET_LAG);
    } else if (lag > FAST_LAG) {
      a.playbackRate = 1.15;
    } else if (lag > TARGET_LAG + 0.08) {
      a.playbackRate = Math.max(a.playbackRate === 1.15 ? 1.15 : 1, 1.05);
    } else if (lag < TARGET_LAG) {
      a.playbackRate = 1;
    }
    this.play();
  }

  // Libera l'audio già riprodotto per non far crescere la memoria all'infinito.
  evict(force) {
    const sb = this.sb;
    const t = this.audio.currentTime;
    if (!sb || sb.updating || !sb.buffered.length) return;
    const start = sb.buffered.start(0);
    if (t - start > (force ? 2 : 30)) sb.remove(start, t - 1);
  }

  lag() {
    const b = this.audio.buffered;
    return b.length ? Math.max(0, b.end(b.length - 1) - this.audio.currentTime) : 0;
  }
}

const players = [];

// Il lettore libero da più tempo, così la coda audio di chi ha appena finito non viene tagliata.
function acquirePlayer(id) {
  const free = players.filter((p) => !p.owner).sort((a, b) => a.freedAt - b.freedAt)[0];
  if (free) free.owner = id;
  return free || null;
}

function releasePlayer(p) {
  if (!p) return;
  p.owner = null;
  p.freedAt = performance.now();
}

function applyVolume() {
  const tx = state.tx;
  const duck = !el.headphones.checked && tx && tx.granted && !tx.stopped;
  const v = Number(el.volume.value) * (duck ? DUCK_VOLUME : 1);
  players.forEach((p) => { p.audio.volume = v; });
}

/* ------------------------------------------------------------- Keep-alive */

// WAV di rumore a -60 dBFS (inudibile) in loop: la pagina resta "in riproduzione"
// anche tra una trasmissione e l'altra, così Android non la congela in background.
function keepAliveUrl(seconds = 2, rate = 8000, amp = 0.001) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, (Math.random() * 2 - 1) * amp * 32767, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function updateKeepAlive() {
  if (state.joined && el.keepAlive.checked) {
    if (!el.ka.src) el.ka.src = keepAliveUrl();
    el.ka.play().catch(() => {});
  } else {
    el.ka.pause();
  }
}

function talkerNames() {
  return [...state.talkers.values()].map((t) => t.name);
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const names = talkerNames();
  navigator.mediaSession.metadata = names.length
    ? new MediaMetadata({ title: names.join(', ') + (names.length > 1 ? ' parlano' : ' sta parlando'), artist: 'Canale ' + state.channel })
    : new MediaMetadata({ title: 'Canale ' + state.channel, artist: 'Walkie-Talkie' });
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  updateMediaSession();
  navigator.mediaSession.setActionHandler('play', () => { players.forEach((p) => p.play()); updateKeepAlive(); });
  navigator.mediaSession.setActionHandler('pause', () => { players.forEach((p) => p.audio.pause()); el.ka.pause(); });
}

/* --------------------------------------------------------------- Microfono */

function openMic() {
  if (state.stream) return Promise.resolve(state.stream);
  if (state.micOpening) return state.micOpening;
  state.micOpening = navigator.mediaDevices.getUserMedia({
    audio: {
      // Filtri VoIP spenti: Chrome non chiede il profilo VOICE_COMMUNICATION all'HAL.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  }).then((s) => {
    if (document.hidden || !state.joined) {
      s.getTracks().forEach((t) => t.stop());
      return null;
    }
    state.stream = s;
    attachAnalyser();
    render();
    return s;
  }).catch((e) => {
    toast('Microfono non disponibile: ' + e.message);
    return null;
  }).finally(() => {
    state.micOpening = null;
  });
  return state.micOpening;
}

function closeMic() {
  stopTx();
  detachAnalyser();
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  render();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    closeMic();
  } else if (state.joined) {
    openMic();
    players.forEach((p) => p.play());
    updateKeepAlive();
  }
});
window.addEventListener('pagehide', closeMic);

/* ---------------------------------------------------------- Trasmissione */

function startTx(source) {
  if (state.tx || !state.joined || !state.connected) return;
  if (!state.stream) {
    if (source === 'ptt') toast(state.micOpening ? 'Microfono in apertura…' : 'Microfono non disponibile');
    openMic();
    return;
  }

  const rec = new MediaRecorder(state.stream, { mimeType: REC_MIME, audioBitsPerSecond: BITRATE });
  const tx = { rec, source, granted: false, denied: false, stopped: false, pending: [] };
  state.tx = tx;
  state.awaiting.push(tx);

  rec.ondataavailable = (e) => {
    if (!e.data.size || tx.denied) return;
    if (tx.granted) state.ws.send(e.data);
    else tx.pending.push(e.data);
  };
  rec.onstop = () => {
    tx.stopped = true;
    if (tx.granted) send({ t: 'ptt_stop' });
    if (state.tx === tx) state.tx = null;
    render();
  };

  // Registra subito (per non perdere la prima sillaba) e invia appena il server dà il via.
  send({ t: 'ptt_start' });
  rec.start(TIMESLICE);
  vibrate(25);
  render();
}

function stopTx() {
  const tx = state.tx;
  if (!tx || tx.rec.state === 'inactive') return;
  tx.rec.stop();
  render();
}

function onFloorGranted() {
  const tx = state.awaiting.shift();
  if (!tx) return;
  tx.granted = true;
  tx.pending.forEach((b) => state.ws.send(b));
  tx.pending = [];
  if (tx.stopped) send({ t: 'ptt_stop' });
  render();
}

function onFloorDenied() {
  const tx = state.awaiting.shift();
  if (!tx) return;
  tx.denied = true;
  tx.pending = [];
  if (tx.rec.state !== 'inactive') tx.rec.stop();
  if (tx.source === 'ptt') busy();
}

function abortTx() {
  state.awaiting = [];
  if (state.tx) {
    state.tx.denied = true;
    if (state.tx.rec.state !== 'inactive') state.tx.rec.stop();
    state.tx = null;
  }
}

function busy() {
  state.busyUntil = Date.now() + 1500;
  vibrate([60, 40, 60]);
  toast(`Canale pieno: parlano già ${PLAYER_SLOTS} persone`);
  render();
  setTimeout(render, 1600);
}

/* --------------------------------------------------------------------- VOX */

function attachAnalyser() {
  if (!state.audioCtx || !state.stream || state.analyser) return;
  state.analyserSrc = state.audioCtx.createMediaStreamSource(state.stream);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 1024;
  state.analyserSrc.connect(state.analyser);
}

function detachAnalyser() {
  state.analyserSrc?.disconnect();
  state.analyserSrc = null;
  state.analyser = null;
}

const voxBuf = new Float32Array(1024);
function voxTick() {
  const an = state.analyser;
  if (!state.vox || !an) {
    el.meterBar.style.width = '0';
    return;
  }
  an.getFloatTimeDomainData(voxBuf);
  let sum = 0;
  for (let i = 0; i < voxBuf.length; i++) sum += voxBuf[i] * voxBuf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / voxBuf.length) + 1e-9);
  el.meterBar.style.width = Math.min(100, Math.max(0, (db + 70) / 60 * 100)) + '%';

  // In vivavoce il mic sente gli altri: il VOX li scambierebbe per la tua voce.
  const now = performance.now();
  const blocked = !el.headphones.checked
    && (state.talkers.size > 0 || Date.now() - state.rxEndedAt < VOX_RX_GUARD_MS);
  if (db > state.voxThr && !blocked) {
    state.voxLastLoud = now;
    if (!state.tx) startTx('vox');
  } else if (state.tx?.source === 'vox' && now - state.voxLastLoud > VOX_HANG_MS) {
    stopTx();
  }
}
setInterval(voxTick, 40);

/* --------------------------------------------------------------- WebSocket */

function send(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function clearTalkers() {
  state.talkers.forEach((t) => releasePlayer(t.player));
  state.talkers.clear();
}

function onAudio(buf) {
  const id = String.fromCharCode(...new Uint8Array(buf, 0, ID_LEN));
  const t = state.talkers.get(id);
  if (t?.rx) t.player.push(buf.slice(ID_LEN));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(proto + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    state.backoff = 500;
    send({ t: 'join', name: el.name.value.trim(), channel: el.channel.value.trim(), code: el.code.value });
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      onAudio(ev.data);
      return;
    }
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'joined':
        state.connected = true;
        state.myId = m.id;
        state.channel = m.channel;
        state.users = m.users;
        clearTalkers();
        // Chi sta già parlando lo ascolti dalla sua prossima trasmissione.
        m.talking.forEach((u) => state.talkers.set(u.id, { name: u.name, player: null, rx: false }));
        el.chName.textContent = m.channel;
        history.replaceState(null, '', '?c=' + encodeURIComponent(m.channel));
        setupMediaSession();
        break;
      case 'users':
        state.users = m.users;
        break;
      case 'talk_start': {
        const t = state.talkers.get(m.id) || { name: m.name, player: null, rx: false };
        t.player = t.player || acquirePlayer(m.id);
        t.rx = !!t.player;
        t.player?.beginSegment();
        state.talkers.set(m.id, t);
        applyVolume();
        updateMediaSession();
        break;
      }
      case 'talk_end':
        if (m.id === state.myId) {
          stopTx();
        } else {
          releasePlayer(state.talkers.get(m.id)?.player);
          state.talkers.delete(m.id);
          state.rxEndedAt = Date.now();
          updateMediaSession();
        }
        break;
      case 'talk_skip': {
        const t = state.talkers.get(m.id);
        if (t) t.rx = false;
        break;
      }
      case 'floor_granted':
        onFloorGranted();
        break;
      case 'floor_denied':
        onFloorDenied();
        break;
      case 'tx_limit':
        toast('Trasmissione troppo lunga, chiusa automaticamente');
        stopTx();
        break;
      case 'pong':
        el.rtt.textContent = 'RTT ' + Math.round(performance.now() - m.ts) + ' ms';
        break;
      case 'error':
        if (m.code === 'auth') {
          leave();
          el.joinError.textContent = m.msg;
          el.joinError.hidden = false;
          return;
        }
        toast(m.msg);
        break;
    }
    render();
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.connected = false;
    clearTalkers();
    abortTx();
    render();
    if (state.joined) {
      setTimeout(() => { if (state.joined) connect(); }, state.backoff);
      state.backoff = Math.min(state.backoff * 2, 8000);
    }
  };
}

setInterval(() => send({ t: 'ping', ts: performance.now() }), 5000);
setInterval(() => {
  if (!state.joined) return;
  let lag = 0;
  state.talkers.forEach((t) => {
    if (!t.rx) return;
    t.player.catchUp();
    lag = Math.max(lag, t.player.lag());
  });
  el.lag.textContent = 'buffer ' + Math.round(lag * 1000) + ' ms';
}, 100);

/* --------------------------------------------------------------------- UI */

function render() {
  el.conn.textContent = state.connected ? 'Online' : 'Offline';
  el.conn.className = 'pill ' + (state.connected ? 'ok' : 'bad');
  el.mic.textContent = state.stream ? '🎙 Mic attivo' : 'Mic chiuso';
  el.mic.className = 'pill ' + (state.stream ? 'ok' : '');

  const tx = state.tx;
  const names = talkerNames();
  const onAir = tx && tx.granted && !tx.stopped;
  let status = 'In ascolto';
  let cls = '';
  let label = 'Tieni premuto<br>per parlare';
  if (!state.connected) {
    status = 'Connessione…';
  } else if (onAir) {
    status = 'IN ONDA' + (names.length ? ' · con ' + names.join(', ') : '');
    cls = 'tx';
    label = tx.source === 'vox' ? 'VOX attivo' : 'Rilascia per<br>chiudere';
  } else if (tx && !tx.granted && !tx.denied) {
    status = 'Apertura…';
    cls = 'busy';
  } else if (names.length) {
    const late = [...state.talkers.values()].some((t) => !t.rx);
    status = '🔊 ' + names.join(', ') + (names.length > 1 ? ' parlano' : ' sta parlando')
      + (late ? ' (ascolti dalla prossima)' : '');
    cls = 'rx';
  } else if (Date.now() < state.busyUntil) {
    status = 'Canale pieno';
    cls = 'busy';
  }
  el.status.textContent = status;
  el.status.className = 'status ' + cls;
  el.ptt.className = 'ptt ' + (cls === 'tx' ? 'live' : cls === 'busy' ? 'pending' : cls);
  el.pttLabel.innerHTML = label;
  el.ptt.disabled = !state.connected;
  applyVolume();

  el.userCount.textContent = state.users.length ? '(' + state.users.length + ')' : '';
  el.users.replaceChildren(...state.users.map((u) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = u.name;
    li.append(name);
    if (u.id === state.myId) {
      const me = document.createElement('span');
      me.className = 'me';
      me.textContent = 'tu';
      li.append(me);
      if (onAir) li.className = 'me-talking';
    } else if (state.talkers.has(u.id)) {
      li.className = 'talking';
    }
    return li;
  }));
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2500);
}

function vibrate(p) {
  try { navigator.vibrate?.(p); } catch { /* non supportato */ }
}

function store(key, value) {
  try { localStorage.setItem('wt.' + key, value); } catch { /* storage bloccato */ }
}

function load(key) {
  try { return localStorage.getItem('wt.' + key); } catch { return null; }
}

/* ------------------------------------------------------------------- Flusso */

function join() {
  el.joinError.hidden = true;
  store('name', el.name.value.trim());
  store('channel', el.channel.value.trim());

  state.joined = true;
  // Siamo dentro un gesto dell'utente: sblocca l'autoplay di tutti gli <audio>.
  if (!players.length) {
    for (let i = 0; i < PLAYER_SLOTS; i++) players.push(new StreamPlayer());
  } else {
    players.forEach((p) => { releasePlayer(p); p.reset(); });
  }
  updateKeepAlive();
  openMic();
  connect();

  el.join.hidden = true;
  el.radio.hidden = false;
  render();
}

function leave() {
  state.joined = false;
  closeMic();
  abortTx();
  const ws = state.ws;
  state.ws = null;
  ws?.close();
  state.connected = false;
  clearTalkers();
  state.users = [];
  players.forEach((p) => p.audio.pause());
  updateKeepAlive();
  el.radio.hidden = true;
  el.join.hidden = false;
}

el.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  join();
});
el.leave.addEventListener('click', leave);

// PTT: tieni premuto (touch o mouse) oppure barra spaziatrice
let pttHeld = false;
el.ptt.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  el.ptt.setPointerCapture(e.pointerId);
  pttHeld = true;
  startTx('ptt');
});
const pttRelease = () => {
  if (!pttHeld) return;
  pttHeld = false;
  if (state.tx?.source === 'ptt') stopTx();
};
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => el.ptt.addEventListener(ev, pttRelease));
el.ptt.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || !state.joined || e.target.matches('input, textarea')) return;
  e.preventDefault();
  pttHeld = true;
  startTx('ptt');
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') pttRelease();
});

el.vox.addEventListener('change', async () => {
  state.vox = el.vox.checked;
  el.voxPanel.hidden = !state.vox;
  if (state.vox && !state.audioCtx) {
    // L'AudioContext serve solo per misurare il livello del mic (non è collegato all'uscita).
    state.audioCtx = new AudioContext();
    attachAnalyser();
  }
  state.audioCtx?.resume();
  if (!state.vox && state.tx?.source === 'vox') stopTx();
});

const showThr = () => {
  state.voxThr = Number(el.voxThr.value);
  el.voxThrVal.textContent = state.voxThr + ' dB';
  el.meterThr.style.left = ((state.voxThr + 70) / 60 * 100) + '%';
  store('voxThr', el.voxThr.value);
};
el.voxThr.addEventListener('input', showThr);
el.volume.addEventListener('input', applyVolume);
el.headphones.addEventListener('change', () => {
  store('headphones', el.headphones.checked ? '1' : '0');
  applyVolume();
});
el.keepAlive.addEventListener('change', () => {
  store('keepAlive', el.keepAlive.checked ? '1' : '0');
  updateKeepAlive();
});

/* -------------------------------------------------------------------- Avvio */

(function init() {
  const params = new URLSearchParams(location.search);
  el.name.value = load('name') || '';
  el.channel.value = params.get('c') || load('channel') || '';
  el.voxThr.value = load('voxThr') || el.voxThr.value;
  el.headphones.checked = load('headphones') === '1';
  el.keepAlive.checked = load('keepAlive') !== '0';
  showThr();

  const problems = [];
  if (!window.isSecureContext) problems.push('serve HTTPS (o localhost) per usare il microfono');
  if (!REC_MIME) problems.push('questo browser non registra in webm/opus (usa Chrome o Firefox)');
  if (!MSE || !MSE.isTypeSupported(PLAY_MIME)) problems.push('questo browser non riproduce webm/opus via MediaSource');
  if (problems.length) {
    el.compat.textContent = 'Attenzione: ' + problems.join('; ') + '.';
    el.compat.hidden = false;
  }
})();
