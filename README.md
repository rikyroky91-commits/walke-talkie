# 📻 Walkie-Talkie WebSocket (zero WebRTC)

Radio push-to-talk tra colleghi, nel browser. Niente `RTCPeerConnection`: Android non la
vede come una chiamata, l'audio esce sul canale **Musica** e il telefono resta libero
(puoi aprire altre app mentre continui a sentire il canale).

## Come funziona

```
 [Chi parla]                                   [Chi ascolta]
 getUserMedia (AEC/NS/AGC OFF)                 WebSocket (binaryType=arraybuffer)
   └─ MediaRecorder webm/opus, chunk 60 ms       └─ MediaSource + SourceBuffer ("sequence")
        └─ WebSocket ──► server.py ──► altri          └─ <audio>  → STREAM_MUSIC
```

- **Half-duplex con "floor control"**: parla uno alla volta, come una radio vera. Se
  qualcuno sta già parlando, il tuo PTT riceve "Canale occupato" (con vibrazione).
  Questo evita anche il feedback: senza cancellazione d'eco il tuo VOX non può
  "rispondere" all'altoparlante, perché il canale è occupato.
- **Microfono solo con pagina visibile**: su `visibilitychange` → `hidden` tutte le
  tracce vengono fermate (`track.stop()`), l'indicatore microfono di Android si spegne.
  L'`<audio>` continua a suonare in background.
- **Keep-alive** (disattivabile): un WAV di rumore a −60 dBFS in loop tiene la pagina
  "in riproduzione", così Chrome non la congela tra una trasmissione e l'altra. Appare la
  notifica multimediale "Canale X" (con "X sta parlando" durante la ricezione).
- **VOX**: misura il livello del mic (AnalyserNode, l'AudioContext non è collegato
  all'uscita), soglia regolabile, 0.9 s di coda.
- Il server chiude il canale se chi parla cade, smette di inviare audio per 4 s o supera
  i 120 s. Chi entra a metà trasmissione ascolta dalla successiva (lo stream webm ha
  l'header solo nel primo chunk).

## Avvio

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt     # Windows
python server.py                                   # http://localhost:8080
```

Opzioni:

| Comando | Cosa fa |
|---|---|
| `python server.py --https` | HTTPS con certificato self-signed (in `.cert/`), per provare dai telefoni in LAN |
| `python server.py --cert c.pem --key k.pem` | HTTPS con il tuo certificato |
| `ACCESS_CODE=segreto python server.py` | Chiede un codice per entrare (PowerShell: `$env:ACCESS_CODE="segreto"`) |
| `--port 9000` / `PORT=9000` | Porta |

**Il microfono funziona solo su HTTPS** (o `localhost`). Opzioni per i telefoni:
1. `--https` e accettare l'avviso del certificato su ogni telefono (solo test in LAN);
2. un tunnel, es. `cloudflared tunnel --url http://localhost:8080` (HTTPS valido subito);
3. deploy dietro un reverse proxy con Let's Encrypt (Caddy/nginx). Inoltra anche `/ws`
   come WebSocket.

Link diretto a un canale: `https://server/?c=magazzino`.

## Latenza misurata

Test in locale (Chrome desktop, mittente e ricevente sulla stessa macchina, 4 trasmissioni
consecutive):

| | valore |
|---|---|
| Chunk MediaRecorder | ogni 60 ms (Chrome codifica opus a frame da 60 ms) |
| Primo audio dopo la pressione del PTT | 310–390 ms |
| Buffer in ricezione a regime | ~220–260 ms, stabile |
| **Bocca → orecchio stimato** | **~0.35 s in LAN** (+ RTT di rete via Internet) |

Il limite è la pipeline MSE di Chrome: vuole ~200 ms di audio davanti a sé, sotto va in
underrun (glitch udibile) e alza da sola la soglia. Il player tiene il buffer a ~220 ms e
recupera eventuali ritardi accelerando a 1.05–1.15x (pitch invariato) invece di saltare.

Con la pagina **in background** il player non ricrea il MediaSource (un nuovo `play()`
potrebbe essere bloccato): accoda allo stesso SourceBuffer. È più robusto ma il primo
audio arriva dopo ~0.6 s.

Per scendere stabilmente **sotto 0.3 s** serve uscire da MSE: opus grezzo a frame da
20 ms (WebCodecs `AudioEncoder`/`AudioDecoder`) e riproduzione con `AudioContext` e un
jitter buffer di ~60–100 ms. Anche l'AudioContext su Android esce come media (non come
chiamata), ma **non** va instradato in un `<audio>` tramite `srcObject`/MediaStream:
Chrome lo tratterebbe come audio RTC.

## Da verificare su Android

Non ancora provato su un telefono vero:
- che con AEC/NS/AGC disattivati Chrome non passi in `MODE_IN_COMMUNICATION`. Come
  verificarlo: con il mic aperto premi il tasto volume; se regola il volume "chiamata"
  invece di quello "multimediale", Chrome è passato in modalità chiamata;
- la ricezione in background per lunghi periodi con lo schermo spento (dipende dal
  produttore: alcune ROM uccidono Chrome; esclusione dall'ottimizzazione batteria);
- che un'altra app che prende il focus audio (YouTube, Spotify) metta in pausa il canale:
  è il comportamento standard di Android. Si riprende dalla notifica multimediale.

Browser: Chrome/Edge/Firefox (Android e desktop). Safari/iOS non supportato (MediaRecorder
non produce webm/opus).

## File

- `server.py`: server aiohttp (static + `/ws`, canali, floor control, watchdog)
- `public/index.html`, `public/style.css`: interfaccia
- `public/app.js`: cattura, PTT/VOX, player MSE, ciclo di vita del microfono
