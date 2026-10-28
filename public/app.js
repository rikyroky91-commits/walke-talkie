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
const DUCK_VOLUME = 0.2;      // volume degli altri mentre parli, se "Abbassa gli altri" è attivo
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
  duck: $('#duck'), headphones: $('#headphones'), keepAlive: $('#keepAlive'),
  users: $('#users'), userCount: $('#userCount'), rtt: $('#rtt'), lag: $('#lag'),
  players: $('#players'), ka: $('#ka'), toast: $('#toast'),
  modeRadio: $('#modeRadio'), modeCall: $('#modeCall'), callHint: $('#callHint'), voxRow: $('#voxRow'),
  diag: $('#diag'), diagOut: $('#diagOut'), bgMic: $('#bgMic'),
};

const state = {
  joined: false,
  connected: false,
  ws: null,
  backoff: 500,
  myId: null,
  channel: '',
  users: [],
  mode: 'radio',      // 'radio' = tieni premuto, 'call' = microfono sempre aperto
  callMuted: false,
  callRetryAt: 0,
  talkers: new Map(), // id -> {name, player, rx, bytes}: chi sta parlando (escluso me)
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
  const duck = el.duck.checked && tx && tx.source !== 'call' && tx.granted && !tx.stopped;
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
    if ((document.hidden && !keepMicInBackground()) || !state.joined) {
      s.getTracks().forEach((t) => t.stop());
      return null;
    }
    state.stream = s;
    watchTrack(s);
    logEvent('mic aperto' + (document.hidden ? ' (in background)' : ''));
    attachAnalyser();
    ensureCall();
    render();
    return s;
  }).catch((e) => {
    logEvent('mic non disponibile: ' + e.name);
    toast('Microfono non disponibile: ' + e.message);
    return null;
  }).finally(() => {
    state.micOpening = null;
  });
  return state.micOpening;
}

// Android può mettere in muto o chiudere la traccia (altra app che prende il mic,
// telefonata, risparmio energetico): se la chiude, la riapriamo e la chiamata riparte.
function watchTrack(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  track.addEventListener('mute', () => logEvent('mic messo in muto dal sistema'));
  track.addEventListener('unmute', () => logEvent('mic riattivato dal sistema'));
  track.addEventListener('ended', () => {
    if (state.stream !== stream) return;
    logEvent('mic chiuso dal sistema: riapro');
    state.stream = null;
    detachAnalyser();
    stopTx();
    if (state.joined && (!document.hidden || keepMicInBackground())) openMic();
  });
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

// Opzione della modalità Chiamata: il microfono resta aperto anche fuori dal browser
// (Chrome Android mantiene la cattura in background con la sua notifica "microfono in uso").
function keepMicInBackground() {
  return state.joined && state.mode === 'call' && !state.callMuted && el.bgMic.checked;
}

document.addEventListener('visibilitychange', () => {
  logEvent(document.hidden ? 'pagina in background' : 'pagina in primo piano');
  if (document.hidden) {
    if (!keepMicInBackground()) closeMic();
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
  rec.onerror = (e) => logEvent('registrazione: errore ' + (e.error?.name || ''));
  rec.onstop = () => {
    tx.stopped = true;
    if (tx.granted) send({ t: 'ptt_stop' });
    if (state.tx === tx) state.tx = null;
    ensureCall();
    render();
  };

  // Registra subito (per non perdere la prima sillaba) e invia appena il server dà il via.
  send({ t: 'ptt_start', mode: source === 'call' ? 'call' : 'ptt' });
  rec.start(TIMESLICE);
  if (source !== 'call') vibrate(25);
  render();
}

// Modalità chiamata: finché la pagina è visibile (o il mic resta attivo in background)
// e il mic non è silenziato si trasmette sempre. Riparte da sola dopo un resync,
// una riconnessione o il ritorno in primo piano.
function ensureCall() {
  if (state.mode !== 'call' || state.callMuted || state.tx || !state.joined || !state.connected
    || !state.stream || (document.hidden && !keepMicInBackground())
    || Date.now() < state.callRetryAt) return;
  startTx('call');
}
setInterval(ensureCall, 500);

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
  if (tx.source === 'call') logEvent('in onda' + (document.hidden ? ' (in background)' : ''));
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
  if (tx.source === 'call') {
    // Canale pieno: riprova tra qualche secondo senza tempestare di avvisi.
    state.callRetryAt = Date.now() + 5000;
    state.busyUntil = state.callRetryAt;
  }
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
  if (!state.vox || !an || state.mode === 'call') {
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
  if (!t) return;
  t.bytes = (t.bytes || 0) + buf.byteLength;
  if (t.rx) t.player.push(buf.slice(ID_LEN));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(proto + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    logEvent('server collegato');
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
        ensureCall();
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
          // "stop" è la conferma di un mio ptt_stop: arriva quando potrei già essere
          // ripartito con una nuova trasmissione, che non va chiusa.
          if (m.reason !== 'stop') {
            logEvent('il server ha chiuso la mia trasmissione: ' + m.reason);
            stopTx();
          }
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
      case 'resync':
        // È entrato qualcuno: riparto con uno stream nuovo (onstop -> ensureCall) così sente anche me.
        if (state.tx?.source === 'call' && state.tx.granted) stopTx();
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
    logEvent('server scollegato: riconnetto');
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

  const call = state.mode === 'call';
  el.modeRadio.classList.toggle('on', !call);
  el.modeCall.classList.toggle('on', call);
  el.callHint.hidden = !call;
  el.voxRow.hidden = call;
  el.voxPanel.hidden = call || !state.vox;

  const tx = state.tx;
  const names = talkerNames();
  const onAir = tx && tx.granted && !tx.stopped;
  let status = 'In ascolto';
  let cls = '';
  let label = 'Tieni premuto<br>per parlare';
  if (!state.connected) {
    status = 'Connessione…';
  } else if (call) {
    label = state.callMuted ? 'Tocca per<br>riattivare' : 'Tocca per<br>silenziare';
    if (state.callMuted) {
      status = '🔇 Microfono silenziato' + (names.length ? ' · parlano ' + names.join(', ') : '');
      cls = 'busy';
    } else if (onAir) {
      status = '📞 In chiamata' + (names.length ? ' con ' + names.join(', ') : ' · nessun altro collegato');
      cls = 'tx';
    } else if (Date.now() < state.busyUntil) {
      status = 'Canale pieno: riprovo…';
      cls = 'busy';
    } else {
      status = state.stream ? 'Collegamento…' : 'Microfono chiuso';
    }
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

// Registro degli ultimi eventi (mostrato nella diagnostica, sopravvive al background).
const events = [];
function logEvent(msg) {
  const t = new Date().toLocaleTimeString('it-IT');
  events.push(`${t} ${msg}`);
  if (events.length > 14) events.shift();
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
  if (el.diag.checked) ensureMeter();
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
// In modalità chiamata lo stesso tasto silenzia / riattiva il microfono.
let pttHeld = false;
el.ptt.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state.mode === 'call') {
    state.callMuted = !state.callMuted;
    if (state.callMuted) stopTx();
    else ensureCall();
    vibrate(25);
    render();
    return;
  }
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
  if (e.code !== 'Space' || e.repeat || !state.joined || state.mode === 'call'
    || e.target.matches('input, textarea, button')) return;
  e.preventDefault();
  pttHeld = true;
  startTx('ptt');
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') pttRelease();
});

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  store('mode', mode);
  state.callMuted = false;
  state.callRetryAt = 0;
  if (state.tx) stopTx();  // onstop -> ensureCall riparte in modalità chiamata
  ensureCall();
  render();
}
el.modeRadio.addEventListener('click', () => setMode('radio'));
el.modeCall.addEventListener('click', () => setMode('call'));

// Livello del mio microfono. Silenzio *assoluto* (-inf dB) con il mic aperto vuol dire
// che è Android a passare zeri a Chrome: succede quando l'app in background perde il
// diritto al microfono. Un mic vero, anche in una stanza silenziosa, ha sempre rumore.
const levelBuf = new Float32Array(1024);
let silentSince = 0;
function micLevel() {
  if (!state.analyser) return null;
  state.analyser.getFloatTimeDomainData(levelBuf);
  let sum = 0;
  for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
  return sum === 0 ? -Infinity : 10 * Math.log10(sum / levelBuf.length);
}

// Diagnostica: cosa sta facendo ogni lettore, per capire i problemi sui telefoni.
let diagLast = performance.now();
setInterval(() => {
  if (!el.diag.checked || !state.joined) return;
  const now = performance.now();
  const secs = (now - diagLast) / 1000;
  diagLast = now;
  const track = state.stream?.getAudioTracks()[0];
  const tx = state.tx;
  const level = micLevel();
  if (level === -Infinity && state.stream) {
    if (!silentSince) silentSince = now;
    else if (now - silentSince > 2000 && silentSince > 0) {
      logEvent('mic: silenzio assoluto, Android sta silenziando Chrome');
      silentSince = -1;  // registrato, non ripetere finché torna il suono
    }
  } else if (level !== null) {
    if (silentSince === -1) logEvent('mic: torna il suono');
    silentSince = 0;
  }
  const lines = [
    `modo ${state.mode}${state.callMuted ? ' (muto)' : ''} · ws ${state.connected ? 'ok' : 'giù'} · visibile ${!document.hidden}`,
    `mic ${track ? track.readyState + (track.muted ? ' MUTED' : '') + ' ' + JSON.stringify(track.getSettings().echoCancellation) : 'chiuso'}`
      + ` · tx ${tx ? (tx.granted ? 'ON' : tx.denied ? 'rifiutata' : 'attesa') + ' ' + tx.source + ' rec=' + tx.rec.state : '-'}`,
    `livello mic ${level === null ? '?' : level === -Infinity ? 'SILENZIO ASSOLUTO' : Math.round(level) + ' dB'}`
      + ` · audioCtx ${state.audioCtx?.state ?? '-'}`,
  ];
  state.talkers.forEach((t, id) => {
    const kbps = Math.round(((t.bytes || 0) * 8) / 1000 / secs);
    t.bytes = 0;
    lines.push(`voce ${t.name}: ${t.rx ? 'ricevo' : 'in attesa'} ${kbps} kbit/s · lettore ${t.player ? players.indexOf(t.player) : '-'}`);
  });
  players.forEach((p, i) => {
    const a = p.audio;
    lines.push(`#${i} ${p.owner ? state.talkers.get(p.owner)?.name ?? '?' : 'libero'} ${a.paused ? 'PAUSA' : 'play'} rs=${a.readyState}`
      + ` t=${a.currentTime.toFixed(1)} lag=${Math.round(p.lag() * 1000)} vol=${a.volume} x${a.playbackRate}`
      + ` ms=${p.ms.readyState}${a.error ? ' ERR ' + a.error.message : ''}`);
  });
  lines.push('— eventi —', ...events);
  el.diagOut.textContent = lines.join('\n');
}, 1000);
el.bgMic.addEventListener('change', () => store('bgMic', el.bgMic.checked ? '1' : '0'));
// Serve un AudioContext (solo per misurare, non collegato all'uscita): va creato in un gesto.
function ensureMeter() {
  if (!state.audioCtx) state.audioCtx = new AudioContext();
  state.audioCtx.resume();
  attachAnalyser();
}

el.diag.addEventListener('change', () => {
  el.diagOut.hidden = !el.diag.checked;
  store('diag', el.diag.checked ? '1' : '0');
  if (el.diag.checked) ensureMeter();
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
el.duck.addEventListener('change', () => {
  store('duck', el.duck.checked ? '1' : '0');
  applyVolume();
});
el.headphones.addEventListener('change', () => {
  store('headphones', el.headphones.checked ? '1' : '0');
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
  state.mode = load('mode') === 'call' ? 'call' : 'radio';
  el.diag.checked = load('diag') === '1';
  el.bgMic.checked = load('bgMic') === '1';
  el.diagOut.hidden = !el.diag.checked;
  el.duck.checked = load('duck') === '1';
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
