'use strict';

/*
 * Walkie-Talkie su WebSocket — zero WebRTC.
 *
 * Invio:     getUserMedia (filtri VoIP spenti) -> AudioWorklet (blocchi da 10 ms)
 *            -> AudioEncoder opus -> WebSocket, un pacchetto ogni 10 ms
 *            [istante audio in unità da 10 ms, 2 byte | opus].
 * Ricezione: WebSocket -> [id 8 byte | istante | opus] -> AudioDecoder (uno per voce)
 *            -> AudioWorklet con jitter buffer e mix -> uscita dell'AudioContext.
 *            L'obiettivo del buffer è il jitter misurato sugli arrivi degli ultimi 10 s.
 *            Su Android l'AudioContext esce sul canale media (STREAM_MUSIC), non come chiamata.
 * Mic:       aperto solo con la pagina visibile, salvo le opzioni della modalità Chiamata.
 */

const SAMPLE_RATE = 48000;
const FRAME_MS = 10;          // durata di un pacchetto: meno attesa prima di partire
const UNIT_US = 10000;        // l'istante nel pacchetto è in unità da 10 ms
const BITRATE = 32000;        // bps opus mono, ottimo per la voce
const JIT_WINDOW_MS = 10000;  // finestra su cui si misura il jitter
const JIT_PERCENTILE = 0.97;  // il buffer copre il 97% dei ritardi d'arrivo...
const JIT_MARGIN = 0.01;      // ...più 10 ms
const ENC_BACKLOG = 8 * 1024; // byte in uscita oltre cui si scartano pacchetti (meglio un buco che il ritardo)
const MAX_VOICES = 4;         // voci contemporanee (uguale a MAX_SPEAKERS del server)
const DUCK_VOLUME = 0.2;      // volume degli altri mentre parli, se "Abbassa gli altri" è attivo
const VOX_HANG_MS = 900;      // la trasmissione VOX resta aperta dopo l'ultima voce
const VOX_RX_GUARD_MS = 600;  // niente VOX subito dopo una ricezione (coda dell'altoparlante)
const ID_LEN = 8;             // byte di id di chi parla in testa a ogni pacchetto
const HDR_LEN = ID_LEN + 2;   // id + istante audio
const DEC_CONFIG = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 };
const SUPPORTED = !!(window.AudioEncoder && window.AudioDecoder && window.AudioWorkletNode);

const $ = (s) => document.querySelector(s);
const el = {
  join: $('#join'), radio: $('#radio'), joinForm: $('#joinForm'), joinError: $('#joinError'),
  name: $('#name'), channel: $('#channel'), code: $('#code'), compat: $('#compat'),
  chName: $('#chName'), conn: $('#conn'), leave: $('#leave'), status: $('#status'),
  ptt: $('#ptt'), pttLabel: $('#pttLabel'), vox: $('#vox'), mic: $('#mic'),
  voxPanel: $('#voxPanel'), meterBar: $('#meterBar'), meterThr: $('#meterThr'),
  voxThr: $('#voxThr'), voxThrVal: $('#voxThrVal'), volume: $('#volume'),
  duck: $('#duck'), headphones: $('#headphones'), gate: $('#gate'), keepAlive: $('#keepAlive'),
  users: $('#users'), userCount: $('#userCount'), rtt: $('#rtt'), lag: $('#lag'),
  ka: $('#ka'), toast: $('#toast'),
  modeRadio: $('#modeRadio'), modeCall: $('#modeCall'), callHint: $('#callHint'), voxRow: $('#voxRow'),
  diag: $('#diag'), diagOut: $('#diagOut'), bgMic: $('#bgMic'),
  pipAuto: $('#pipAuto'), pipVideo: $('#pipVideo'),
  otherBrowser: $('#otherBrowser'), openChrome: $('#openChrome'), pipNow: $('#pipNow'),
  needChrome: $('#needChrome'), gotoChrome: $('#gotoChrome'), stayHere: $('#stayHere'),
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
  talkers: new Map(), // id -> {name, dec, ts, seq, bytes, lost}: chi sta parlando (escluso me)
  rxEndedAt: 0,
  stream: null,
  micOpening: null,
  tx: null,           // trasmissione corrente
  awaiting: [],       // trasmissioni in attesa di floor_granted/denied (FIFO)
  vox: false,
  voxThr: -42,
  voxLastLoud: 0,
  ac: null,           // AudioContext unico: cattura, misura del livello e riproduzione
  audioReady: null,   // Promise: worklet caricato
  capture: null,      // AudioWorkletNode wt-capture
  playback: null,     // AudioWorkletNode wt-playback
  outGain: null,
  micSrc: null,
  highpass: null,     // taglia il rombo sotto gli 80 Hz (vento, motori, scrivania)
  gateInfo: null,     // stato del gate di rumore (dal thread audio)
  analyser: null,
  encConfig: null,
  pbStats: {},        // statistiche del jitter buffer per voce (dal thread audio)
  rtt: 0,
  busyUntil: 0,
};

/* ------------------------------------------------------------------- Audio */

// Va chiamata dentro un gesto dell'utente (sblocca l'audio).
function setupAudio() {
  if (state.ac) {
    state.ac.resume();
    return state.audioReady;
  }
  let ac;
  try {
    ac = new AudioContext({ latencyHint: 'interactive', sampleRate: SAMPLE_RATE });
  } catch {
    ac = new AudioContext({ latencyHint: 'interactive' });
  }
  state.ac = ac;
  ac.addEventListener('statechange', () => logEvent('audio: ' + ac.state));
  state.audioReady = Promise.all([ac.audioWorklet.addModule('audio-worklet.js'), pickEncoderConfig(ac.sampleRate)])
    .then(([, cfg]) => {
      state.encConfig = cfg;
      state.capture = new AudioWorkletNode(ac, 'wt-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { frame: Math.round(ac.sampleRate * FRAME_MS / 1000) },
      });
      state.capture.port.onmessage = (e) => {
        if (e.data instanceof Float32Array) onMicFrame(e.data);
        else state.gateInfo = e.data;
      };
      state.capture.port.postMessage({ gate: el.gate.checked });
      state.highpass = ac.createBiquadFilter();
      state.highpass.type = 'highpass';
      state.highpass.frequency.value = 80;
      state.highpass.connect(state.capture);
      state.capture.connect(ac.destination);  // esce solo silenzio: serve perché il nodo venga elaborato
      state.playback = new AudioWorkletNode(ac, 'wt-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      state.playback.port.onmessage = (e) => { if (e.data.t === 'stats') state.pbStats = e.data.voices; };
      state.outGain = ac.createGain();
      state.playback.connect(state.outGain).connect(ac.destination);
      state.analyser = ac.createAnalyser();
      state.analyser.fftSize = 1024;
      applyVolume();
      attachMic();
    })
    .catch((e) => {
      logEvent('audio non disponibile: ' + e.message);
      toast('Audio non disponibile: ' + e.message);
    });
  ac.resume();
  return state.audioReady;
}

// Opus a frame da 10 ms (20 ms se il browser non li fa). Le opzioni opus avanzate
// non ci sono su tutti i Chrome. Il ricevitore si regola sull'istante nel pacchetto,
// quindi la durata dei frame può cambiare senza problemi.
async function pickEncoderConfig(sampleRate) {
  const base = { codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: BITRATE };
  const opus = (frameDuration) => ({ ...base, opus: { frameDuration, complexity: 5, application: 'voip', signal: 'voice' } });
  for (const cfg of [opus(FRAME_MS * 1000), { ...base, opus: { frameDuration: FRAME_MS * 1000 } }, opus(20000), base]) {
    try {
      if ((await AudioEncoder.isConfigSupported(cfg)).supported) return cfg;
    } catch { /* prova la successiva */ }
  }
  throw new Error('questo browser non codifica opus');
}

function applyVolume() {
  if (!state.outGain) return;
  const tx = state.tx;
  const duck = el.duck.checked && tx && tx.source !== 'call' && tx.granted && !tx.stopped;
  const v = Number(el.volume.value) * (duck ? DUCK_VOLUME : 1);
  state.outGain.gain.setTargetAtTime(v, state.ac.currentTime, 0.02);
}

/* ------------------------------------------------------------- Ricezione */

function makeDecoder(id) {
  const dec = new AudioDecoder({
    output: (ad) => {
      const pcm = new Float32Array(ad.numberOfFrames);
      ad.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
      ad.close();
      state.playback?.port.postMessage({ t: 'pcm', id, pcm }, [pcm.buffer]);
    },
    error: (e) => logEvent('decodifica: ' + e.message),
  });
  dec.configure(DEC_CONFIG);
  return dec;
}

function startVoice(id, name) {
  let t = state.talkers.get(id);
  if (!t) {
    t = { name, dec: null, seq: -1, unit: 0, step: 0, arrivals: [], bytes: 0, lost: 0 };
    state.talkers.set(id, t);
  }
  t.name = name || t.name;
  t.seq = -1;
  t.arrivals = [];
  state.playback?.port.postMessage({ t: 'start', id });
}

function endVoice(id) {
  const t = state.talkers.get(id);
  if (!t) return;
  state.talkers.delete(id);
  const dec = t.dec;
  // Il thread audio suona quello che resta solo dopo gli ultimi pacchetti decodificati.
  const done = () => {
    state.playback?.port.postMessage({ t: 'end', id });
    try { dec?.close(); } catch { /* già chiuso */ }
  };
  if (dec?.state === 'configured') dec.flush().then(done, done);
  else done();
}

function clearTalkers() {
  [...state.talkers.keys()].forEach(endVoice);
  state.playback?.port.postMessage({ t: 'reset' });
}

function onAudio(buf) {
  if (buf.byteLength <= HDR_LEN) return;
  const id = String.fromCharCode(...new Uint8Array(buf, 0, ID_LEN));
  const t = state.talkers.get(id);
  if (!t) return;
  const now = performance.now();
  const seq = new DataView(buf).getUint16(ID_LEN);
  if (t.seq >= 0) {
    const diff = (seq - t.seq) & 0xffff;
    if (diff === 0 || diff > 0x8000) return;  // doppione o fuori ordine: non succede su TCP
    if (!t.step || diff < t.step) t.step = diff;
    if (diff > t.step) t.lost += Math.round(diff / t.step) - 1;  // scartati dal server per rete lenta
    t.unit += diff;
  } else {
    t.unit = 0;
  }
  t.seq = seq;
  t.bytes += buf.byteLength;
  // Quanto in ritardo arriva il pacchetto rispetto al suo istante audio (a meno di una costante).
  t.arrivals.push(now, now - t.unit * UNIT_US / 1000);
  if (!t.dec || t.dec.state === 'closed') t.dec = makeDecoder(id);
  t.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: t.unit * UNIT_US, data: new Uint8Array(buf, HDR_LEN) }));
}

// Obiettivo del buffer = jitter d'arrivo degli ultimi 10 s (97° percentile) + margine.
// Scende da solo appena la rete si calma, invece di restare alto per minuti.
function updateJitterTargets() {
  const now = performance.now();
  state.talkers.forEach((t, id) => {
    const a = t.arrivals;
    let k = 0;
    while (k < a.length && a[k] < now - JIT_WINDOW_MS) k += 2;
    if (k) a.splice(0, k);
    if (a.length < 40) return;
    const delays = [];
    for (let i = 1; i < a.length; i += 2) delays.push(a[i]);
    delays.sort((x, y) => x - y);
    t.jitter = (delays[Math.floor((delays.length - 1) * JIT_PERCENTILE)] - delays[0]) / 1000;
    state.playback?.port.postMessage({ t: 'target', id, value: t.jitter + JIT_MARGIN });
  });
}
setInterval(updateJitterTargets, 500);

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
  navigator.mediaSession.setActionHandler('play', () => { state.ac?.resume(); updateKeepAlive(); });
  navigator.mediaSession.setActionHandler('pause', () => { state.ac?.suspend(); el.ka.pause(); });
}

/* --------------------------------------------------------------- Microfono */

function openMic() {
  if (state.stream) return Promise.resolve(state.stream);
  if (state.micOpening) return state.micOpening;
  state.micOpening = navigator.mediaDevices.getUserMedia({
    audio: {
      // Filtri VoIP spenti: Chrome non chiede il profilo VOICE_COMMUNICATION all'HAL.
      // Con la cancellazione d'eco accesa Android passerebbe in modalità chiamata
      // (e anche l'uscita audio diventerebbe "chiamata"): mai attivarla.
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
    attachMic();
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

// Collega il microfono al worklet di cattura e all'analizzatore (VOX, diagnostica).
function attachMic() {
  if (!state.capture || !state.stream || state.micSrc) return;
  state.micSrc = state.ac.createMediaStreamSource(state.stream);
  // Riduzione rumore tutta nella pagina (passa-alto + gate nel worklet): i filtri del
  // browser (noiseSuppression ecc.) metterebbero Android in modalità chiamata.
  state.micSrc.connect(state.highpass);
  state.micSrc.connect(state.analyser);
}

function detachMic() {
  state.micSrc?.disconnect();
  state.micSrc = null;
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
    detachMic();
    stopTx();
    if (state.joined && (!document.hidden || keepMicInBackground())) openMic();
  });
}

function closeMic() {
  stopTx();
  detachMic();
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  render();
}

// Opzione della modalità Chiamata: il microfono resta aperto anche fuori dal browser
// (Chrome Android mantiene la cattura in background con la sua notifica "microfono in uso").
function keepMicInBackground() {
  return state.joined && state.mode === 'call' && !state.callMuted && (el.bgMic.checked || el.pipAuto.checked);
}

/* ---------------------------------------------------------- Mini finestra */

// Android silenzia il microfono di Chrome appena la pagina va in background, ma non se
// Chrome resta visibile in Picture-in-Picture. Chrome Android entra da solo in PiP quando
// premi Home mentre un video riempie lo schermo intero: la pagina va a schermo intero con
// sotto un video invisibile che la copre, e nella finestrella si vede quel video.
let pipClip = null;

function pipWanted() {
  return state.joined && state.mode === 'call' && el.pipAuto.checked;
}

// Il PiP automatico all'uscita è una funzione di Chrome, non uno standard: il browser
// Xiaomi, Samsung Internet, Firefox, Opera ecc. non lo fanno. Lì si offre di riaprire
// la pagina in Chrome (link intent://, che ogni browser Android passa al sistema).
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const OTHER_BROWSERS = /MiuiBrowser|XiaoMi|SamsungBrowser|OPR\/|Opera|EdgA|Firefox|FxiOS|YaBrowser|UCBrowser|HuaweiBrowser|HeyTapBrowser|VivoBrowser|Brave|DuckDuckGo|; wv\)/i;
function isChrome() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  if (brands.length) return brands.includes('Google Chrome');
  return /Chrome\//.test(navigator.userAgent) && !OTHER_BROWSERS.test(navigator.userAgent);
}
const NEEDS_CHROME = IS_ANDROID && !isChrome();

// Senza Chrome il sistema apre browser_fallback_url: la pagina di Chrome sul Play Store.
// "wt_chrome=1" segna la pagina aperta così: lì non si reindirizza mai più (niente giri
// infiniti se un giorno Chrome non venisse riconosciuto).
function chromeIntentUrl() {
  const fallback = 'https://play.google.com/store/apps/details?id=com.android.chrome';
  const params = new URLSearchParams(location.search);
  params.set('wt_chrome', '1');
  return `intent://${location.host}${location.pathname}?${params}#Intent;scheme=https;package=com.android.chrome;`
    + `S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

// Aperta da un browser Android che non è Chrome: al posto dell'accesso si mostra
// "Apri in Chrome" e si prova subito a passarci da soli. Alcuni browser chiedono
// conferma o bloccano il salto automatico: resta il tasto.
function redirectToChrome() {
  const params = new URLSearchParams(location.search);
  let stay = false;
  try { stay = !!sessionStorage.getItem('wt.stayHere'); } catch { /* storage non disponibile */ }
  if (!NEEDS_CHROME || params.has('wt_chrome') || stay) return false;
  el.gotoChrome.href = chromeIntentUrl();
  el.join.hidden = true;
  el.needChrome.hidden = false;
  el.stayHere.addEventListener('click', () => {
    try { sessionStorage.setItem('wt.stayHere', '1'); } catch { /* storage non disponibile */ }
    el.needChrome.hidden = true;
    el.join.hidden = false;
  });
  location.href = el.gotoChrome.href;
  return true;
}

function renderBrowserWarn() {
  el.otherBrowser.hidden = !(NEEDS_CHROME && state.mode === 'call');
  el.openChrome.href = chromeIntentUrl();
  // Se questo browser ha almeno l'API Picture-in-Picture, la finestrella si apre a mano.
  el.pipNow.hidden = !document.pictureInPictureEnabled;
}

el.pipNow.addEventListener('click', async () => {
  try {
    await pipUpdate();
    if (el.pipVideo.hidden) {
      // L'opzione automatica è spenta: prepariamo il video solo per questa volta.
      el.pipVideo.src = await makePipClip();
      el.pipVideo.hidden = false;
      await el.pipVideo.play();
    }
    await el.pipVideo.requestPictureInPicture();
    logEvent('mini finestra aperta a mano');
  } catch (e) {
    logEvent('mini finestra non disponibile: ' + e.name);
    toast('Questo browser non apre la finestrella: usa Chrome');
  }
});

// Un webm vero (Blob URL) registrato da un canvas, non un MediaStream: è il caso
// "video a schermo intero" che Chrome riconosce per il PiP automatico.
function makePipClip() {
  if (pipClip) return pipClip;
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  const g = c.getContext('2d');
  const draw = (blink) => {
    g.fillStyle = '#111418';
    g.fillRect(0, 0, c.width, c.height);
    g.textAlign = 'center';
    g.fillStyle = '#e8ecf1';
    g.font = '600 24px system-ui, sans-serif';
    g.fillText('📻 Walkie-Talkie', 160, 76);
    g.fillStyle = '#8b95a3';
    g.font = '15px system-ui, sans-serif';
    g.fillText('in chiamata · tocca per tornare', 160, 106);
    g.fillStyle = blink ? '#ef4444' : '#5a1d1d';  // pallino che lampeggia: il video "si muove"
    g.beginPath();
    g.arc(160, 140, 7, 0, 2 * Math.PI);
    g.fill();
  };
  pipClip = new Promise((resolve, reject) => {
    const stream = c.captureStream(10);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 150000 });
    const chunks = [];
    let n = 0;
    draw(true);
    const timer = setInterval(() => draw(Math.floor(++n / 5) % 2 === 0), 100);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => reject(e.error);
    rec.onstop = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
    };
    rec.start();
    setTimeout(() => rec.stop(), 2000);
  }).catch((e) => {
    pipClip = null;
    logEvent('mini finestra: video non creato ' + (e?.name || ''));
    return null;
  });
  return pipClip;
}

async function pipUpdate() {
  const v = el.pipVideo;
  if (!pipWanted()) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    v.pause();
    v.hidden = true;
    return;
  }
  const url = await makePipClip();
  if (!url || !pipWanted()) return;
  if (v.src !== url) v.src = url;
  v.hidden = false;
  v.play().catch((e) => logEvent('mini finestra: video fermo ' + e.name));
}

// Lo schermo intero si può chiedere solo dentro un gesto: lo richiediamo a ogni tocco,
// così tornando dalla finestrella basta toccare la pagina.
function pipFullscreen() {
  if (!pipWanted() || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    .catch((e) => logEvent('schermo intero non concesso: ' + e.name));
}

document.addEventListener('pointerdown', pipFullscreen, true);
document.addEventListener('fullscreenchange', () => {
  logEvent(document.fullscreenElement ? 'schermo intero' : 'fine schermo intero');
});
// La finestrella PiP rimpicciolisce la pagina: lo registriamo per la diagnostica.
let pipSmall = false;
window.addEventListener('resize', () => {
  const small = window.innerWidth < 300;
  if (small !== pipSmall) logEvent(small ? `mini finestra ${innerWidth}x${innerHeight}` : 'pagina a dimensione piena');
  pipSmall = small;
});

document.addEventListener('visibilitychange', () => {
  logEvent(document.hidden ? 'pagina in background' : 'pagina in primo piano');
  if (document.hidden) {
    if (!keepMicInBackground()) closeMic();
  } else if (state.joined) {
    state.ac?.resume();
    openMic();
    updateKeepAlive();
  }
});
window.addEventListener('pagehide', closeMic);

/* ---------------------------------------------------------- Trasmissione */

function startTx(source) {
  if (state.tx || !state.joined || !state.connected) return;
  if (!state.stream || !state.capture) {
    if (source === 'ptt') toast(state.micOpening ? 'Microfono in apertura…' : 'Microfono non disponibile');
    openMic();
    return;
  }

  const tx = { source, granted: false, denied: false, stopped: false, stopSent: false, pending: [], ts: 0, enc: null, sent: 0, dropped: 0 };
  tx.enc = new AudioEncoder({
    output: (chunk) => {
      if (tx.denied) return;
      const unit = Math.round(chunk.timestamp / UNIT_US) & 0xffff;
      const pkt = new Uint8Array(2 + chunk.byteLength);
      pkt[0] = unit >> 8;
      pkt[1] = unit & 0xff;
      chunk.copyTo(pkt.subarray(2));
      if (tx.granted) sendAudio(tx, pkt);
      else tx.pending.push(pkt);
    },
    error: (e) => {
      logEvent('codifica: ' + e.message);
      stopTx();
    },
  });
  tx.enc.configure(state.encConfig);
  state.tx = tx;
  state.awaiting.push(tx);

  // Cattura subito (per non perdere la prima sillaba) e invia appena il server dà il via.
  send({ t: 'ptt_start', mode: source === 'call' ? 'call' : 'ptt' });
  state.capture.port.postMessage({ on: true });
  if (source !== 'call') vibrate(25);
  render();
}

function onMicFrame(pcm) {
  const tx = state.tx;
  if (!tx || tx.stopped || tx.enc.state !== 'configured') return;
  const ad = new AudioData({
    format: 'f32-planar',
    sampleRate: state.ac.sampleRate,
    numberOfFrames: pcm.length,
    numberOfChannels: 1,
    timestamp: tx.ts,
    data: pcm,
  });
  tx.ts += (pcm.length / state.ac.sampleRate) * 1e6;
  tx.enc.encode(ad);
  ad.close();
}

// Con la rete in salita bloccata è meglio perdere qualche pacchetto che accumulare ritardo.
function sendAudio(tx, pkt) {
  const ws = state.ws;
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > ENC_BACKLOG) {
    tx.dropped++;
    return;
  }
  ws.send(pkt);
  tx.sent++;
}

// Modalità chiamata: finché la pagina è visibile (o il mic resta attivo in background)
// e il mic non è silenziato si trasmette sempre. Riparte da sola dopo una
// riconnessione o il ritorno in primo piano.
function ensureCall() {
  if (state.mode !== 'call' || state.callMuted || state.tx || !state.joined || !state.connected
    || !state.stream || (document.hidden && !keepMicInBackground())
    || Date.now() < state.callRetryAt) return;
  startTx('call');
}
setInterval(ensureCall, 500);

function sendStop(tx) {
  if (tx.stopSent) return;
  tx.stopSent = true;
  send({ t: 'ptt_stop' });
}

function stopTx() {
  const tx = state.tx;
  if (!tx || tx.stopped) return;
  tx.stopped = true;
  state.capture?.port.postMessage({ on: false });
  const finish = () => {
    try { tx.enc.close(); } catch { /* già chiuso */ }
    if (tx.granted && !tx.denied) sendStop(tx);
    if (state.tx === tx) state.tx = null;
    ensureCall();
    render();
  };
  // flush: gli ultimi 20 ms partono prima del ptt_stop.
  if (!tx.denied && tx.enc.state === 'configured') tx.enc.flush().then(finish, finish);
  else finish();
  render();
}

function onFloorGranted() {
  const tx = state.awaiting.shift();
  if (!tx) return;
  tx.granted = true;
  if (tx.source === 'call') logEvent('in onda' + (document.hidden ? ' (in background)' : ''));
  tx.pending.forEach((p) => sendAudio(tx, p));
  tx.pending = [];
  if (tx.stopped && state.tx !== tx) sendStop(tx);
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
  if (state.tx === tx) stopTx();
  if (tx.source === 'ptt') busy();
}

function abortTx() {
  state.awaiting = [];
  const tx = state.tx;
  if (!tx) return;
  tx.denied = true;
  tx.stopped = true;
  state.capture?.port.postMessage({ on: false });
  try { tx.enc.close(); } catch { /* già chiuso */ }
  state.tx = null;
}

function busy() {
  state.busyUntil = Date.now() + 1500;
  vibrate([60, 40, 60]);
  toast(`Canale pieno: parlano già ${MAX_VOICES} persone`);
  render();
  setTimeout(render, 1600);
}

/* --------------------------------------------------------------------- VOX */

const voxBuf = new Float32Array(1024);
function voxTick() {
  const an = state.analyser;
  if (!state.vox || !an || !state.micSrc || state.mode === 'call') {
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
        // I pacchetti opus sono indipendenti: chi sta già parlando si sente subito.
        m.talking.forEach((u) => startVoice(u.id, u.name));
        el.chName.textContent = m.channel;
        history.replaceState(null, '', '?c=' + encodeURIComponent(m.channel));
        setupMediaSession();
        ensureCall();
        break;
      case 'users':
        state.users = m.users;
        break;
      case 'talk_start':
        startVoice(m.id, m.name);
        updateMediaSession();
        break;
      case 'talk_end':
        if (m.id === state.myId) {
          // "stop" è la conferma di un mio ptt_stop: arriva quando potrei già essere
          // ripartito con una nuova trasmissione, che non va chiusa.
          if (m.reason !== 'stop') {
            logEvent('il server ha chiuso la mia trasmissione: ' + m.reason);
            stopTx();
          }
        } else {
          endVoice(m.id);
          state.rxEndedAt = Date.now();
          updateMediaSession();
        }
        break;
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
        state.rtt = performance.now() - m.ts;
        el.rtt.textContent = 'RTT ' + Math.round(state.rtt) + ' ms';
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

setInterval(() => send({ t: 'ping', ts: performance.now() }), 3000);

// Ritardo bocca-orecchio stimato, in ms, scomposto: pacchetto + rete (metà RTT) +
// jitter buffer + uscita audio. Manca la latenza d'ingresso del microfono (non misurabile).
function delayParts() {
  const bufs = Object.values(state.pbStats).map((v) => v.buf);
  if (!bufs.length) return null;
  const parts = {
    pacchetto: (state.encConfig?.opus?.frameDuration || 20000) / 1000,
    rete: state.rtt / 2,
    buffer: Math.max(...bufs) * 1000,
    uscita: ((state.ac?.outputLatency || 0) + (state.ac?.baseLatency || 0)) * 1000,
  };
  parts.totale = Object.values(parts).reduce((x, y) => x + y, 0);
  return parts;
}

setInterval(() => {
  if (!state.joined) return;
  const d = delayParts();
  el.lag.textContent = d === null ? 'ritardo —' : 'ritardo ~' + Math.round(d.totale) + ' ms';
}, 500);

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
  renderBrowserWarn();
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
    status = '🔊 ' + names.join(', ') + (names.length > 1 ? ' parlano' : ' sta parlando');
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
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3000);
}

function vibrate(p) {
  if (navigator.vibrate) navigator.vibrate(p);
}

function store(key, value) {
  try { localStorage.setItem('wt.' + key, value); } catch { /* storage non disponibile */ }
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
  // Siamo dentro un gesto dell'utente: sblocca l'AudioContext e il keep-alive.
  setupAudio();
  updateKeepAlive();
  openMic();
  state.audioReady.then(() => { if (state.joined && !state.ws) connect(); });
  pipUpdate();
  pipFullscreen();

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
  updateKeepAlive();
  pipUpdate();
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
  state.ac?.resume();
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
  stopTx();  // finish -> ensureCall riparte in modalità chiamata
  ensureCall();
  pipUpdate();
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
  if (!state.analyser || !state.micSrc) return null;
  state.analyser.getFloatTimeDomainData(levelBuf);
  let sum = 0;
  for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
  return sum === 0 ? -Infinity : 10 * Math.log10(sum / levelBuf.length);
}

// Diagnostica: cosa sta facendo l'audio, per capire i problemi sui telefoni.
let diagLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const secs = (now - diagLast) / 1000;
  diagLast = now;
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
  const tx = state.tx;
  const kbps = (bytes) => Math.round((bytes * 8) / 1000 / secs);
  if (!el.diag.checked || !state.joined) {
    state.talkers.forEach((t) => { t.bytes = 0; });
    if (tx) tx.sent = 0;
    return;
  }
  const track = state.stream?.getAudioTracks()[0];
  const ac = state.ac;
  const lines = [
    `modo ${state.mode}${state.callMuted ? ' (muto)' : ''} · ws ${state.connected ? 'ok' : 'giù'} · visibile ${!document.hidden}`,
    `mic ${track ? track.readyState + (track.muted ? ' MUTED' : '') + ' eco ' + JSON.stringify(track.getSettings().echoCancellation) : 'chiuso'}`
      + ` · tx ${tx ? (tx.granted ? 'ON' : tx.denied ? 'rifiutata' : 'attesa') + ' ' + tx.source + ` ${tx.sent} pkt/s scartati ${tx.dropped}` : '-'}`,
    `livello mic ${level === null ? '?' : level === -Infinity ? 'SILENZIO ASSOLUTO' : Math.round(level) + ' dB'}`
      + (state.gateInfo && el.gate.checked ? ` · gate ${state.gateInfo.open ? 'aperto' : 'chiuso'} fondo ${Math.round(20 * Math.log10(state.gateInfo.floor))} dB` : '')
      + ` · audio ${ac ? ac.state + ' ' + ac.sampleRate + ' Hz uscita ' + Math.round(((ac.outputLatency || 0) + (ac.baseLatency || 0)) * 1000) + ' ms' : '-'}`,
  ];
  if (tx) tx.sent = 0;
  state.talkers.forEach((t, id) => {
    const pb = state.pbStats[id];
    lines.push(`voce ${t.name}: ${kbps(t.bytes)} kbit/s · persi ${t.lost} · jitter ${t.jitter === undefined ? '?' : Math.round(t.jitter * 1000)} ms`
      + (pb ? ` · buffer ${Math.round(pb.buf * 1000)}/${Math.round(pb.target * 1000)} ms · interruzioni ${pb.underruns} · recuperati ${pb.dropped.toFixed(1)} s` : ''));
    t.bytes = 0;
  });
  const d = delayParts();
  if (d) lines.push('ritardo ' + Object.entries(d).map(([k, v]) => `${k} ${Math.round(v)}`).join(' · ') + ' ms');
  lines.push('— eventi —', ...events);
  el.diagOut.textContent = lines.join('\n');
}, 1000);

el.bgMic.addEventListener('change', () => store('bgMic', el.bgMic.checked ? '1' : '0'));
el.pipAuto.addEventListener('change', () => {
  store('pipAuto', el.pipAuto.checked ? '1' : '0');
  pipUpdate();
  pipFullscreen();
});

el.diag.addEventListener('change', () => {
  el.diagOut.hidden = !el.diag.checked;
  store('diag', el.diag.checked ? '1' : '0');
});

el.vox.addEventListener('change', () => {
  state.vox = el.vox.checked;
  el.voxPanel.hidden = !state.vox;
  state.ac?.resume();
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
el.gate.addEventListener('change', () => {
  store('gate', el.gate.checked ? '1' : '0');
  state.capture?.port.postMessage({ gate: el.gate.checked });
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
  el.pipAuto.checked = load('pipAuto') === '1';
  el.diagOut.hidden = !el.diag.checked;
  el.duck.checked = load('duck') === '1';
  el.headphones.checked = load('headphones') === '1';
  el.gate.checked = load('gate') !== '0';
  el.keepAlive.checked = load('keepAlive') !== '0';
  store('aec', '0');  // opzione tolta: chi l'aveva accesa torna senza
  showThr();

  const problems = [];
  if (!window.isSecureContext) problems.push('serve HTTPS (o localhost) per usare il microfono');
  if (!SUPPORTED) problems.push('questo browser non ha WebCodecs/AudioWorklet (usa Chrome aggiornato)');
  if (problems.length) {
    el.compat.textContent = 'Attenzione: ' + problems.join('; ') + '.';
    el.compat.hidden = false;
  }
  redirectToChrome();
})();
