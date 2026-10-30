'use strict';

/*
 * Aracne: chiamata di gruppo e condivisione su WebSocket — zero WebRTC.
 *
 * Voce, invio:     getUserMedia (filtri VoIP spenti) -> AudioWorklet (blocchi da 10 ms)
 *                  -> AudioEncoder opus -> WebSocket, un pacchetto ogni 10 ms
 *                  [istante audio in unità da 10 ms, 2 byte | opus].
 * Voce, ricezione: WebSocket -> [id 8 byte | istante | opus] -> AudioDecoder (uno per voce)
 *                  -> AudioWorklet con jitter buffer e mix -> uscita dell'AudioContext.
 *                  L'obiettivo del buffer è il jitter misurato sugli arrivi degli ultimi 10 s.
 *                  Su Android l'AudioContext esce sul canale media (STREAM_MUSIC), non come chiamata.
 * Condivisi:       messaggi e link sul WebSocket; i file (anche APK) con POST /upload,
 *                  fuori dal WebSocket, così un file grande non rallenta la voce.
 * Mic:             sempre aperto finché la pagina è visibile (o nella mini finestra); il
 *                  tasto silenzia. MAI echoCancellation/noiseSuppression/autoGainControl:
 *                  Android passerebbe in modalità chiamata.
 */

const APP_NAME = 'Aracne';
const SAMPLE_RATE = 48000;
const FRAME_MS = 10;          // durata di un pacchetto: meno attesa prima di partire
const UNIT_US = 10000;        // l'istante nel pacchetto è in unità da 10 ms
const BITRATE = 32000;        // bps opus mono, ottimo per la voce
const JIT_WINDOW_MS = 10000;  // finestra su cui si misura il jitter
const JIT_PERCENTILE = 0.97;  // il buffer copre il 97% dei ritardi d'arrivo...
const JIT_MARGIN = 0.01;      // ...più 10 ms
const ENC_BACKLOG = 8 * 1024; // byte in uscita oltre cui si scartano pacchetti (meglio un buco che il ritardo)
const MAX_VOICES = 4;         // voci contemporanee (uguale a MAX_SPEAKERS del server)
const ID_LEN = 8;             // byte di id di chi parla in testa a ogni pacchetto
const HDR_LEN = ID_LEN + 2;   // id + istante audio
const DEC_CONFIG = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 };
const SUPPORTED = !!(window.AudioEncoder && window.AudioDecoder && window.AudioWorkletNode);

const $ = (s) => document.querySelector(s);
const el = {
  join: $('#join'), app: $('#app'), joinForm: $('#joinForm'), joinError: $('#joinError'),
  name: $('#name'), channel: $('#channel'), code: $('#code'), compat: $('#compat'),
  chName: $('#chName'), conn: $('#conn'), leave: $('#leave'), status: $('#status'),
  mute: $('#mute'), people: $('#people'), rtt: $('#rtt'), lag: $('#lag'),
  feed: $('#feed'), feedEmpty: $('#feedEmpty'), composer: $('#composer'), text: $('#text'), fileInput: $('#fileInput'),
  settings: $('#settings'), openSettings: $('#openSettings'), closeSettings: $('#closeSettings'),
  volume: $('#volume'), gate: $('#gate'), keepAlive: $('#keepAlive'), bgMic: $('#bgMic'),
  diag: $('#diag'), diagOut: $('#diagOut'), ka: $('#ka'), toast: $('#toast'),
  pipAuto: $('#pipAuto'), pipVideo: $('#pipVideo'),
  otherBrowser: $('#otherBrowser'), openChrome: $('#openChrome'), pipNow: $('#pipNow'),
  needChrome: $('#needChrome'), gotoChrome: $('#gotoChrome'), stayHere: $('#stayHere'),
  gotoChrome2: $('#gotoChrome2'), copyLink: $('#copyLink'),
};

const state = {
  joined: false,
  connected: false,
  ws: null,
  backoff: 500,
  myId: null,
  token: null,        // autorizza i caricamenti di file
  maxUpload: 100 * 1024 * 1024,
  channel: '',
  users: [],
  callMuted: false,
  callRetryAt: 0,
  talkers: new Map(), // id -> {name, dec, seq, unit, step, arrivals, bytes, lost}: chi è in chiamata (escluso me)
  levels: {},         // id -> livello della voce (dal thread audio), per illuminare chi parla
  stream: null,
  micOpening: null,
  tx: null,           // trasmissione corrente
  awaiting: [],       // trasmissioni in attesa di floor_granted/denied (FIFO)
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
      state.playback.port.onmessage = (e) => {
        if (e.data.t === 'stats') state.pbStats = e.data.voices;
        else if (e.data.t === 'levels') state.levels = e.data.levels;
      };
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
  state.outGain.gain.setTargetAtTime(Number(el.volume.value), state.ac.currentTime, 0.02);
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
// anche nelle pause, così Android non la congela in background.
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
  navigator.mediaSession.metadata = new MediaMetadata({
    title: names.length ? 'In chiamata con ' + names.join(', ') : 'Canale ' + state.channel,
    artist: APP_NAME,
  });
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

// Collega il microfono al worklet di cattura e all'analizzatore (livello, diagnostica).
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

// Il microfono resta aperto anche fuori dalla pagina con la mini finestra o con l'opzione
// "Microfono attivo anche fuori dal browser".
function keepMicInBackground() {
  return state.joined && !state.callMuted && (el.bgMic.checked || el.pipAuto.checked);
}

/* ---------------------------------------------------------- Mini finestra */

// Android silenzia il microfono di Chrome appena la pagina va in background, ma non se
// Chrome resta visibile in Picture-in-Picture. Chrome Android entra da solo in PiP quando
// premi Home mentre un video riempie lo schermo intero: la pagina va a schermo intero con
// sotto un video invisibile che la copre, e nella finestrella si vede quel video.
let pipClip = null;

function pipWanted() {
  return state.joined && el.pipAuto.checked;
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

// Indirizzo da aprire in Chrome, con il canale (Chrome non ha i dati salvati di questo
// browser). "wt_chrome=1" segna la pagina aperta così: lì non si reindirizza mai più
// (niente giri infiniti se un giorno Chrome non venisse riconosciuto).
function chromeTarget() {
  const params = new URLSearchParams(location.search);
  if (!params.get('c') && el.channel.value.trim()) params.set('c', el.channel.value.trim());
  params.set('wt_chrome', '1');
  return { path: `${location.host}${location.pathname}?${params}`, url: `https://${location.host}${location.pathname}?${params}` };
}

// Senza Chrome il sistema apre browser_fallback_url: la pagina di Chrome sul Play Store.
// action VIEW + BROWSABLE esplicite: alcuni browser senza aprono Chrome senza la pagina.
function chromeIntentUrl() {
  const fallback = 'https://play.google.com/store/apps/details?id=com.android.chrome';
  return `intent://${chromeTarget().path}#Intent;scheme=https;action=android.intent.action.VIEW;`
    + `category=android.intent.category.BROWSABLE;package=com.android.chrome;`
    + `S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

// Seconda via: lo schema googlechrome:// di Chrome Android, che passa l'indirizzo come
// parametro (non ha il ripiego sul Play Store).
function chromeSchemeUrl() {
  return 'googlechrome://navigate?url=' + encodeURIComponent(chromeTarget().url);
}

// Terza via: il link negli appunti, da incollare nella barra di Chrome.
function copyChromeLink() {
  const url = chromeTarget().url;
  navigator.clipboard?.writeText(url).catch(() => {});
  return url;
}
[el.gotoChrome, el.gotoChrome2, el.openChrome].forEach((a) => a.addEventListener('click', copyChromeLink));
el.copyLink.addEventListener('click', () => {
  copyChromeLink();
  toast('Link copiato: incollalo nella barra degli indirizzi di Chrome');
});

// Aperta da un browser Android che non è Chrome: al posto dell'accesso si mostra
// "Apri in Chrome" e si prova subito a passarci da soli. Alcuni browser chiedono
// conferma o bloccano il salto automatico: resta il tasto.
function redirectToChrome() {
  const params = new URLSearchParams(location.search);
  let stay = false;
  try { stay = !!sessionStorage.getItem('wt.stayHere'); } catch { /* storage non disponibile */ }
  if (!NEEDS_CHROME || params.has('wt_chrome') || stay) return false;
  el.gotoChrome.href = chromeIntentUrl();
  el.gotoChrome2.href = chromeSchemeUrl();
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
  el.otherBrowser.hidden = !NEEDS_CHROME;
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
    g.fillStyle = '#0e0f14';
    g.fillRect(0, 0, c.width, c.height);
    g.textAlign = 'center';
    g.fillStyle = '#eceef4';
    g.font = '700 26px system-ui, sans-serif';
    g.fillText('🕸 ' + APP_NAME, 160, 76);
    g.fillStyle = '#8a90a2';
    g.font = '15px system-ui, sans-serif';
    g.fillText('in chiamata · tocca per tornare', 160, 106);
    g.fillStyle = blink ? '#34d399' : '#14503b';  // pallino che lampeggia: il video "si muove"
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
// così tornando dalla finestrella basta toccare la pagina. Non mentre si scrive o si
// sceglie un file (la tastiera e il selettore di file escono dallo schermo intero).
function pipFullscreen(e) {
  if (!pipWanted() || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  if (e?.target?.closest?.('#composer, dialog')) return;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    .catch((err) => logEvent('schermo intero non concesso: ' + err.name));
}

document.addEventListener('pointerdown', pipFullscreen, true);
document.addEventListener('fullscreenchange', () => {
  logEvent(document.fullscreenElement ? 'schermo intero' : 'fine schermo intero');
  fitHeight();
  setTimeout(fitHeight, 300);  // alcuni telefoni ridimensionano dopo l'evento
});

// Altezza visibile reale (schermo intero, tastiera aperta, rotazione): 100dvh non
// sempre si aggiorna a schermo intero e la barra in basso finiva fuori dallo schermo.
function fitHeight() {
  const h = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
}
window.addEventListener('resize', fitHeight);
window.visualViewport?.addEventListener('resize', fitHeight);
fitHeight();
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

function startTx() {
  if (state.tx || !state.joined || !state.connected || !state.stream || !state.capture) return;

  const tx = { granted: false, denied: false, stopped: false, stopSent: false, pending: [], ts: 0, enc: null, sent: 0, dropped: 0 };
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
  send({ t: 'ptt_start', mode: 'call' });
  state.capture.port.postMessage({ on: true });
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

// Finché la pagina è visibile (o il mic resta attivo in background) e il mic non è
// silenziato si trasmette sempre. Riparte da sola dopo una riconnessione o il ritorno
// in primo piano.
function ensureCall() {
  if (state.callMuted || state.tx || !state.joined || !state.connected
    || !state.stream || (document.hidden && !keepMicInBackground())
    || Date.now() < state.callRetryAt) return;
  startTx();
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
  // flush: gli ultimi 10 ms partono prima del ptt_stop.
  if (!tx.denied && tx.enc.state === 'configured') tx.enc.flush().then(finish, finish);
  else finish();
  render();
}

function onFloorGranted() {
  const tx = state.awaiting.shift();
  if (!tx) return;
  tx.granted = true;
  logEvent('in onda' + (document.hidden ? ' (in background)' : ''));
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
  // Chiamata piena: riprova tra qualche secondo senza tempestare di avvisi.
  state.callRetryAt = Date.now() + 5000;
  state.busyUntil = state.callRetryAt;
  if (state.tx === tx) stopTx();
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

function toggleMute() {
  state.callMuted = !state.callMuted;
  if (state.callMuted) stopTx();
  else {
    state.callRetryAt = 0;
    state.ac?.resume();
    openMic();
    ensureCall();
  }
  vibrate(20);
  render();
}

/* --------------------------------------------------------------- Condivisi */

const seen = new Set();   // mid già mostrati (la cronologia arriva di nuovo a ogni riconnessione)

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

// Testo con i link cliccabili. Solo nodi di testo e <a> costruiti a mano: niente HTML
// da altri utenti nella pagina.
function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /\bhttps?:\/\/[^\s<>"]+/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    let url = m[0].replace(/[),.;:!?]+$/, '');
    frag.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
    last = m.index + url.length;
  }
  frag.append(text.slice(last));
  return frag;
}

function fileCard(f) {
  const card = document.createElement('div');
  card.className = 'file';
  const expired = f.expires && Date.now() > f.expires;
  if (expired) card.classList.add('expired');
  const isApk = /\.apk$/i.test(f.name);
  const isImg = /^image\/(png|jpeg|gif|webp)$/.test(f.type);

  const icon = document.createElement('div');
  icon.className = 'file-icon' + (isApk ? ' apk' : '');
  if (isApk) icon.textContent = 'APK';
  else icon.innerHTML = '<svg><use href="#i-file"/></svg>';

  const meta = document.createElement('div');
  meta.className = 'file-meta';
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = f.name;
  const sub = document.createElement('div');
  sub.className = 'file-sub';
  sub.textContent = fmtSize(f.size) + (expired ? ' · scaduto' : isApk ? ' · app Android' : '');
  meta.append(name, sub);

  const get = document.createElement('a');
  get.className = 'file-get';
  get.href = f.url;
  get.textContent = isApk ? 'Installa' : isImg ? 'Apri' : 'Scarica';
  if (isImg) {
    get.target = '_blank';
    get.rel = 'noopener';
  } else {
    get.setAttribute('download', f.name);
  }
  if (isApk) get.addEventListener('click', () => toast('Apri il file scaricato per installarla (Android chiede di consentire le app da fonti sconosciute)'));
  card.append(icon, meta, get);

  if (isImg && !expired) {
    const wrap = document.createElement('div');
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = f.url;
    img.loading = 'lazy';
    img.alt = f.name;
    const link = document.createElement('a');
    link.href = f.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.append(img);
    wrap.append(link);
    return [wrap, card];
  }
  return [card];
}

function addItem(m, scroll = true) {
  if (seen.has(m.mid)) return;
  seen.add(m.mid);
  const li = document.createElement('li');
  li.className = 'msg' + (m.from === state.myId ? ' mine' : '');
  const head = document.createElement('div');
  head.className = 'msg-head';
  const who = document.createElement('b');
  who.textContent = m.from === state.myId ? 'Tu' : m.name;
  head.append(who, ' · ' + fmtTime(m.ts));
  li.append(head);
  if (m.text) {
    const b = document.createElement('div');
    b.className = 'bubble';
    b.append(linkify(m.text));
    li.append(b);
  }
  if (m.file) li.append(...fileCard(m.file));
  el.feed.append(li);
  el.feedEmpty.hidden = true;
  if (scroll) li.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function onMessage(m) {
  const fresh = !seen.has(m.mid);
  addItem(m);
  if (fresh && m.from !== state.myId) {
    vibrate(30);
    if (m.file) toast(`${m.name} ha condiviso ${m.file.name}`);
  }
}

function sendText() {
  const text = el.text.value.trim();
  if (!text) return;
  if (!state.connected) {
    toast('Non collegato: riprova tra un attimo');
    return;
  }
  send({ t: 'msg', text });
  el.text.value = '';
}

// Caricamento con XHR (per la barra di avanzamento). Il file arriva a tutti come
// messaggio del server: la riga "in caricamento" è solo locale e poi sparisce.
function uploadFile(file) {
  if (file.size > state.maxUpload) {
    toast(`${file.name}: troppo grande (max ${fmtSize(state.maxUpload)})`);
    return;
  }
  if (!state.token) {
    toast('Non collegato: riprova tra un attimo');
    return;
  }
  const li = document.createElement('li');
  li.className = 'msg mine';
  const card = document.createElement('div');
  card.className = 'file';
  card.innerHTML = '<div class="file-icon"><svg><use href="#i-file"/></svg></div><div class="file-meta"><div class="file-name"></div><div class="file-sub"></div><div class="progress"><div></div></div></div>';
  card.querySelector('.file-name').textContent = file.name;
  const sub = card.querySelector('.file-sub');
  const bar = card.querySelector('.progress > div');
  sub.textContent = 'Caricamento… ' + fmtSize(file.size);
  li.append(card);
  el.feed.append(li);
  el.feedEmpty.hidden = true;
  li.scrollIntoView({ block: 'end' });

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');
  xhr.setRequestHeader('X-Token', state.token);
  xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) bar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
  };
  xhr.onload = () => {
    if (xhr.status === 200) {
      li.remove();
      return;
    }
    let msg = 'errore ' + xhr.status;
    try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* risposta non JSON */ }
    sub.textContent = 'Non inviato: ' + msg;
    bar.parentElement.remove();
  };
  xhr.onerror = () => {
    sub.textContent = 'Non inviato: connessione persa';
    bar.parentElement.remove();
  };
  xhr.send(file);
}

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  sendText();
});
el.fileInput.addEventListener('change', () => {
  [...el.fileInput.files].forEach(uploadFile);
  el.fileInput.value = '';
});

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
        state.token = m.token;
        state.maxUpload = m.maxUpload || state.maxUpload;
        state.channel = m.channel;
        state.users = m.users;
        clearTalkers();
        // I pacchetti opus sono indipendenti: chi sta già parlando si sente subito.
        m.talking.forEach((u) => startVoice(u.id, u.name));
        // L'id cambia a ogni connessione: la cronologia si ridisegna da capo.
        seen.clear();
        el.feed.replaceChildren();
        el.feedEmpty.hidden = !!(m.history || []).length;
        (m.history || []).forEach((h) => addItem(h, false));
        el.feed.lastElementChild?.scrollIntoView({ block: 'end' });
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
          updateMediaSession();
        }
        break;
      case 'floor_granted':
        onFloorGranted();
        break;
      case 'floor_denied':
        onFloorDenied();
        break;
      case 'msg':
        onMessage(m);
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
    state.token = null;
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

function hue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

// Partecipanti: ridisegnati solo quando cambia qualcosa; il bagliore di chi parla
// si aggiorna 10 volte al secondo con una variabile CSS.
let peopleKey = '';
function renderPeople() {
  const onAir = !!(state.tx && state.tx.granted && !state.tx.stopped);
  const me = state.users.find((u) => u.id === state.myId);
  const others = state.users.filter((u) => u.id !== state.myId);
  const list = me ? [me, ...others] : others;
  const key = JSON.stringify([list, onAir, state.callMuted, [...state.talkers.keys()]]);
  if (key === peopleKey) return;
  peopleKey = key;
  el.people.replaceChildren(...list.map((u) => {
    const mine = u.id === state.myId;
    const live = mine ? onAir : state.talkers.has(u.id);
    const li = document.createElement('li');
    li.className = 'person' + (mine ? ' me' : '') + (live ? '' : ' off');
    li.dataset.id = u.id;
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.setProperty('--hue', hue(u.name));
    av.textContent = initials(u.name);
    if (!live) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.innerHTML = '<svg><use href="#i-mic-off"/></svg>';
      av.append(badge);
    }
    const name = document.createElement('div');
    name.className = 'person-name';
    name.textContent = mine ? 'Tu' : u.name;
    li.append(av, name);
    return li;
  }));
}

const meterBuf = new Float32Array(1024);
function myLevel() {
  if (!state.analyser || !state.micSrc || !state.tx?.granted) return 0;
  state.analyser.getFloatTimeDomainData(meterBuf);
  let sum = 0;
  for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
  return Math.sqrt(sum / meterBuf.length);
}

// RMS -> 0..1 su scala in dB: -50 dBFS spento, -15 dBFS pieno.
const glow = (rms) => Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-9) + 50) / 35));

setInterval(() => {
  if (!state.joined || document.hidden) return;
  el.people.querySelectorAll('.person').forEach((li) => {
    const id = li.dataset.id;
    const rms = id === state.myId ? (state.gateInfo?.open === false ? 0 : myLevel()) : (state.levels[id] || 0);
    li.firstChild.style.setProperty('--lvl', glow(rms).toFixed(2));
  });
}, 100);

function render() {
  el.conn.classList.toggle('ok', state.connected);
  renderBrowserWarn();

  const tx = state.tx;
  const names = talkerNames();
  const onAir = tx && tx.granted && !tx.stopped;
  let status;
  let cls = '';
  if (!state.connected) {
    status = 'Connessione…';
    cls = 'wait';
  } else if (state.callMuted) {
    status = 'Microfono silenziato';
    cls = 'muted';
  } else if (Date.now() < state.busyUntil) {
    status = `Chiamata piena (max ${MAX_VOICES} voci): riprovo…`;
    cls = 'muted';
  } else if (!state.stream) {
    status = state.micOpening ? 'Apertura microfono…' : 'Microfono chiuso';
    cls = 'wait';
  } else if (onAir) {
    status = names.length ? 'In chiamata' : 'In chiamata · aspetti gli altri';
  } else {
    status = 'Collegamento…';
    cls = 'wait';
  }
  el.status.textContent = status;
  el.status.className = 'status ' + cls;
  el.mute.setAttribute('aria-pressed', String(state.callMuted));
  el.mute.setAttribute('aria-label', state.callMuted ? 'Riattiva il microfono' : 'Silenzia il microfono');
  el.mute.firstElementChild.firstElementChild.setAttribute('href', state.callMuted ? '#i-mic-off' : '#i-mic');
  el.mute.disabled = !state.connected;
  renderPeople();
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
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3500);
}

function vibrate(p) {
  if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(p);
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
  state.callMuted = false;
  // Siamo dentro un gesto dell'utente: sblocca l'AudioContext e il keep-alive.
  setupAudio();
  updateKeepAlive();
  openMic();
  state.audioReady.then(() => { if (state.joined && !state.ws) connect(); });
  pipUpdate();
  pipFullscreen();

  el.join.hidden = true;
  el.app.hidden = false;
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
  state.token = null;
  clearTalkers();
  state.users = [];
  updateKeepAlive();
  pipUpdate();
  el.app.hidden = true;
  el.join.hidden = false;
}

el.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  join();
});
el.leave.addEventListener('click', leave);
el.mute.addEventListener('click', toggleMute);
el.openSettings.addEventListener('click', () => el.settings.showModal());
el.closeSettings.addEventListener('click', () => el.settings.close());
el.settings.addEventListener('click', (e) => { if (e.target === el.settings) el.settings.close(); });

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
    `${state.callMuted ? 'muto' : 'mic acceso'} · ws ${state.connected ? 'ok' : 'giù'} · visibile ${!document.hidden}`,
    `mic ${track ? track.readyState + (track.muted ? ' MUTED' : '') + ' eco ' + JSON.stringify(track.getSettings().echoCancellation) : 'chiuso'}`
      + ` · tx ${tx ? (tx.granted ? 'ON' : tx.denied ? 'rifiutata' : 'attesa') + ` ${tx.sent} pkt/s scartati ${tx.dropped}` : '-'}`,
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
el.volume.addEventListener('input', () => {
  store('volume', el.volume.value);
  applyVolume();
});
el.gate.addEventListener('change', () => {
  store('gate', el.gate.checked ? '1' : '0');
  state.capture?.port.postMessage({ gate: el.gate.checked });
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
  el.diag.checked = load('diag') === '1';
  el.bgMic.checked = load('bgMic') === '1';
  el.pipAuto.checked = load('pipAuto') === '1';
  el.diagOut.hidden = !el.diag.checked;
  el.gate.checked = load('gate') !== '0';
  el.keepAlive.checked = load('keepAlive') !== '0';
  el.volume.value = load('volume') || el.volume.value;
  store('aec', '0');  // opzione tolta: chi l'aveva accesa torna senza

  const problems = [];
  if (!window.isSecureContext) problems.push('serve HTTPS (o localhost) per usare il microfono');
  if (!SUPPORTED) problems.push('questo browser non ha WebCodecs/AudioWorklet (usa Chrome aggiornato)');
  if (problems.length) {
    el.compat.textContent = 'Attenzione: ' + problems.join('; ') + '.';
    el.compat.hidden = false;
  }
  redirectToChrome();
})();
