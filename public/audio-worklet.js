'use strict';

/*
 * Thread audio (AudioWorklet).
 *
 * wt-capture:  raccoglie il microfono in blocchi da 10 ms e li passa alla pagina,
 *              che li codifica in opus (AudioEncoder) e li manda sul WebSocket.
 * wt-playback: un jitter buffer per ogni voce e il mix sull'uscita dell'AudioContext.
 *              L'obiettivo del buffer lo calcola la pagina dal jitter misurato sui
 *              pacchetti (ultimi 10 s); qui si aggiunge solo un margine temporaneo dopo
 *              ogni interruzione, che svanisce in pochi secondi. Il ritardo in eccesso si
 *              recupera scartando i blocchi di silenzio (pause tra le parole).
 */

const START_TARGET = 0.06 * sampleRate;   // finché la pagina non ha misurato il jitter
const MIN_TARGET = 0.03 * sampleRate;
const MAX_TARGET = 0.6 * sampleRate;
const BOOST_STEP = 0.02 * sampleRate;     // margine in più a ogni interruzione...
const BOOST_DECAY = 0.03;                 // ...che scende di 30 ms per ogni secondo suonato
const SOFT_SLACK = 0.02 * sampleRate;     // oltre obiettivo+20 ms si scartano i silenzi
const HARD_SLACK = 0.2 * sampleRate;      // oltre obiettivo+200 ms si scarta comunque
const QUIET = 0.01;                       // RMS sotto cui un blocco è "pausa" (-40 dBFS)

class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frame = options.processorOptions.frame;
    this.on = false;
    this.buf = new Float32Array(this.frame);
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
      const take = Math.min(ch.length - i, this.frame - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.frame) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.frame);
        this.n = 0;
      }
    }
    return true;
  }
}

class Voice {
  constructor(net) {
    this.chunks = [];
    this.pos = 0;           // posizione nel primo chunk
    this.buffered = 0;      // campioni in coda
    this.playing = false;   // false = sta riempiendo il buffer fino all'obiettivo
    this.ending = false;    // la trasmissione è finita: suona quello che resta e basta
    this.net = net;         // obiettivo dal jitter misurato
    this.boost = 0;         // margine temporaneo dopo un'interruzione
    this.underruns = 0;
    this.dropped = 0;
  }

  get target() {
    return Math.min(MAX_TARGET, Math.max(MIN_TARGET, this.net + this.boost));
  }

  push(pcm) {
    this.chunks.push(pcm);
    this.buffered += pcm.length;
  }

  // Somma fino a n campioni in out; con out null li scarta.
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
    this.learned = new Map();   // obiettivo per ogni voce, tra una trasmissione e l'altra
    this.gain = 1;
    this.sinceStats = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  voice(id) {
    let v = this.voices.get(id);
    if (!v) {
      v = new Voice(this.learned.get(id) || START_TARGET);
      this.voices.set(id, v);
    }
    return v;
  }

  onMessage(m) {
    switch (m.t) {
      case 'pcm':
        this.voice(m.id).push(m.pcm);
        break;
      case 'start':
        // Se la trasmissione precedente sta ancora suonando la nuova si accoda, senza tagli.
        this.voice(m.id).ending = false;
        break;
      case 'end': {
        const v = this.voices.get(m.id);
        if (v) v.ending = true;
        break;
      }
      case 'target': {
        const net = m.value * sampleRate;
        const v = this.voices.get(m.id);
        if (v) v.net = net;
        this.learned.set(m.id, net);
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
      const target = v.target;
      while (v.buffered > target + HARD_SLACK + n) v.dropped += v.read(null, 0, n);
      if (v.buffered > target + SOFT_SLACK + n && v.quietAhead(n)) v.dropped += v.read(null, 0, n);

      const got = v.read(out, this.gain, n);
      v.boost = Math.max(0, v.boost - got * BOOST_DECAY);
      if (got < n) {
        v.playing = false;
        if (v.ending) {
          this.forget(id, v);
          continue;
        }
        // Buffer finito a metà voce: interruzione udibile, più margine per un po'.
        v.underruns++;
        v.boost += BOOST_STEP;
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
    this.learned.set(id, v.net);
    this.voices.delete(id);
  }
}

registerProcessor('wt-capture', Capture);
registerProcessor('wt-playback', Playback);
