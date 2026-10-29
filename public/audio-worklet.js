'use strict';

/*
 * Thread audio (AudioWorklet).
 *
 * wt-capture:  raccoglie il microfono in blocchi da 20 ms e li passa alla pagina,
 *              che li codifica in opus (AudioEncoder) e li manda sul WebSocket.
 * wt-playback: un jitter buffer per ogni voce e il mix sull'uscita dell'AudioContext.
 *              Il buffer parte basso (100 ms), cresce a ogni interruzione e scende piano
 *              quando la rete è stabile. Il ritardo accumulato si recupera scartando i
 *              blocchi di silenzio (pause tra le parole), così la voce non si taglia.
 */

const FRAME = sampleRate / 50;            // 20 ms
const START_TARGET = 0.1 * sampleRate;
const MIN_TARGET = 0.06 * sampleRate;
const MAX_TARGET = 0.6 * sampleRate;
const STEP = 0.04 * sampleRate;           // in più a ogni interruzione
const DECAY_EVERY = 8 * sampleRate;       // 8 s senza interruzioni...
const DECAY = 0.01 * sampleRate;          // ...e l'obiettivo scende di 10 ms
const SOFT_SLACK = 0.04 * sampleRate;     // oltre obiettivo+40 ms si scartano i silenzi
const HARD_SLACK = 0.3 * sampleRate;      // oltre obiettivo+300 ms si scarta comunque
const QUIET = 0.01;                       // RMS sotto cui un blocco è "pausa" (-40 dBFS)

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(FRAME);
    this.n = 0;
    this.port.onmessage = (e) => {
      this.on = e.data.on;
      this.n = 0;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!this.on || !ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, FRAME - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === FRAME) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(FRAME);
        this.n = 0;
      }
    }
    return true;
  }
}

class Voice {
  constructor(target) {
    this.chunks = [];
    this.pos = 0;           // posizione nel primo chunk
    this.buffered = 0;      // campioni in coda
    this.playing = false;   // false = sta riempiendo il buffer fino all'obiettivo
    this.ending = false;    // la trasmissione è finita: suona quello che resta e basta
    this.target = target;
    this.played = 0;        // campioni suonati dall'ultima modifica dell'obiettivo
    this.underruns = 0;
    this.dropped = 0;
  }

  push(pcm) {
    this.chunks.push(pcm);
    this.buffered += pcm.length;
  }

  // Copia (sommando) fino a out.length campioni in out; con out null li scarta.
  read(out, gain, n) {
    let i = 0;
    while (i < n && this.chunks.length) {
      const c = this.chunks[0];
      const take = Math.min(n - i, c.length - this.pos);
      if (out) for (let k = 0; k < take; k++) out[i + k] += c[this.pos + k] * gain;
      i += take;
      this.pos += take;
      if (this.pos === c.length) {
        this.chunks.shift();
        this.pos = 0;
      }
    }
    this.buffered -= i;
    return i;
  }

  quietAhead(n) {
    const c = this.chunks[0];
    if (!c) return true;
    const end = Math.min(c.length, this.pos + n);
    let sum = 0;
    for (let k = this.pos; k < end; k++) sum += c[k] * c[k];
    return Math.sqrt(sum / Math.max(1, end - this.pos)) < QUIET;
  }
}

class Playback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = new Map();
    this.learned = new Map();   // obiettivo imparato per ogni voce, tra una trasmissione e l'altra
    this.gain = 1;
    this.sinceStats = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.t) {
      case 'pcm': {
        let v = this.voices.get(m.id);
        if (!v) {
          v = new Voice(this.learned.get(m.id) || START_TARGET);
          this.voices.set(m.id, v);
        }
        v.push(m.pcm);
        break;
      }
      case 'start': {
        // Se la trasmissione precedente sta ancora suonando la nuova si accoda, senza tagli.
        const v = this.voices.get(m.id);
        if (v) v.ending = false;
        else this.voices.set(m.id, new Voice(this.learned.get(m.id) || START_TARGET));
        break;
      }
      case 'end': {
        const v = this.voices.get(m.id);
        if (v) v.ending = true;
        break;
      }
      case 'reset':
        this.voices.clear();
        break;
      case 'gain':
        this.gain = m.value;
        break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    out.fill(0);
    for (const [id, v] of this.voices) {
      if (!v.playing) {
        if (v.buffered >= v.target || (v.ending && v.buffered > 0)) v.playing = true;
        else {
          if (v.ending) this.forget(id, v);
          continue;
        }
      }
      // Recupero del ritardo: prima le pause, oltre una certa soglia qualsiasi blocco.
      while (v.buffered > v.target + HARD_SLACK + n) v.dropped += v.read(null, 0, n);
      if (v.buffered > v.target + SOFT_SLACK + n && v.quietAhead(n)) v.dropped += v.read(null, 0, n);

      const got = v.read(out, this.gain, n);
      v.played += got;
      if (got < n) {
        v.playing = false;
        if (v.ending) {
          this.forget(id, v);
          continue;
        }
        // Buffer finito a metà voce: interruzione udibile, serve più margine.
        v.underruns++;
        v.target = Math.min(MAX_TARGET, v.target + STEP);
        v.played = 0;
      } else if (v.played > DECAY_EVERY) {
        v.played = 0;
        v.target = Math.max(MIN_TARGET, v.target - DECAY);
      }
    }
    for (let k = 0; k < n; k++) out[k] = Math.max(-1, Math.min(1, out[k]));

    this.sinceStats += n;
    if (this.sinceStats >= sampleRate / 2) {
      this.sinceStats = 0;
      const voices = {};
      this.voices.forEach((v, id) => {
        voices[id] = {
          buf: v.buffered / sampleRate,
          target: v.target / sampleRate,
          underruns: v.underruns,
          dropped: v.dropped / sampleRate,
          playing: v.playing,
        };
      });
      this.port.postMessage({ t: 'stats', voices });
    }
    return true;
  }

  forget(id, v) {
    this.learned.set(id, v.target);
    this.voices.delete(id);
  }
}

registerProcessor('wt-capture', Capture);
registerProcessor('wt-playback', Playback);
