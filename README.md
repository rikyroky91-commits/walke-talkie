# 🕸 Aracne

Chiamata di gruppo, messaggi, link e file (anche APK) tra colleghi, nel browser. Niente
WebRTC e niente filtri VoIP: Android non la vede come una chiamata, la voce esce sul
canale **Musica** e il telefono resta libero (puoi usare altre app mentre sei in
chiamata).

## Come funziona

```
 [Chi parla]                                   [Chi ascolta]
 getUserMedia (AEC/NS/AGC OFF)                 WebSocket (binaryType=arraybuffer)
   └─ AudioWorklet, blocchi da 10 ms             └─ AudioDecoder opus (uno per voce)
        └─ AudioEncoder opus 32 kbit/s                └─ AudioWorklet: jitter buffer + mix
             └─ WebSocket ──► server.py ──► altri          └─ AudioContext → STREAM_MUSIC
                  [id 8 byte | istante 2 byte | opus]
```

L'istante è il timestamp audio del pacchetto in unità da 10 ms: il ricevitore lo usa
per misurare il jitter e funziona con qualsiasi durata di frame (10 ms, o 20 ms sui
browser che non li supportano).

- **Chiamata**: microfono sempre aperto finché la pagina è visibile (o nella mini
  finestra), il tasto rotondo silenzia. Fino a 4 voci insieme; chi entra a metà sente
  subito (i pacchetti sono indipendenti). I partecipanti si illuminano quando parlano
  (livello misurato nel worklet di riproduzione, 10 volte al secondo).
- **Condivisi**: messaggi e link viaggiano sul WebSocket (`{t:"msg"}`), gli ultimi 100
  per canale vengono mandati a chi entra. I file (fino a 100 MB, APK comprese) si caricano
  con `POST /upload` (corpo grezzo, header `X-Token` ricevuto all'ingresso e `X-Filename`),
  fuori dal WebSocket così un file grande non rallenta la voce, e si scaricano da
  `/f/<id>/<nome>`. Le APK escono come `application/vnd.android.package-archive`, così
  Android propone l'installazione; le immagini hanno l'anteprima; tutto il resto è un
  allegato con `nosniff` e CSP `sandbox`. I file restano 24 ore (1 GB in tutto) e si
  perdono se il server riparte (su Render gratuito succede quando si spegne).
- **Jitter buffer**: l'obiettivo è il 97° percentile del ritardo d'arrivo dei pacchetti
  negli ultimi 10 s, più 10 ms (min 30, max 600 ms). Ogni interruzione aggiunge 20 ms di
  margine che svanisce in meno di un secondo di audio. Il ritardo accumulato si recupera
  scartando i blocchi di silenzio tra le parole. Il server, se un ascoltatore ha più di
  ~1 s in coda, gli salta qualche pacchetto invece di accumulare.
- **Niente filtri del telefono**: con `echoCancellation`/`noiseSuppression`/
  `autoGainControl` accesi Chrome Android apre il microfono come VOICE_COMMUNICATION e
  mette il telefono in modalità chiamata. Sono sempre spenti.
- **Rumore nelle pause** (Impostazioni, acceso di default): tutto software. Un passa-alto
  a 80 Hz toglie il rombo e un gate nel worklet di cattura stima il rumore di fondo e,
  nelle pause, abbassa il microfono di 26 dB (apre in 5 ms, chiude dopo 250 ms).
- **Eco in vivavoce**: senza cancellazione d'eco il microfono sente l'altoparlante, quindi
  in vivavoce gli altri sentono l'eco della propria voce. Rimedio: le cuffie.
- **Mini finestra automatica** (Impostazioni): la pagina va a schermo intero con sotto un
  video invisibile (webm registrato da un canvas) che la copre. Chrome Android, se premi
  Home mentre un video è a schermo intero, si riduce da solo in Picture-in-Picture: resta
  visibile e quindi conserva il microfono. Ogni tocco sulla pagina (non sulla barra per
  scrivere) richiede di nuovo lo schermo intero.
- **Solo Chrome su Android**: il PiP all'uscita è una funzione di Chrome. Dagli altri
  browser Android la pagina salta da sola a Chrome (link `intent://` con
  `package=com.android.chrome`; senza Chrome il Play Store tramite
  `browser_fallback_url`). Se il salto è bloccato resta la schermata "Apri in Chrome",
  con `googlechrome://navigate?url=` e il link copiato negli appunti come altre vie.
  `wt_chrome=1` evita giri infiniti.
- **Microfono anche fuori dal browser** (Impostazioni, spento): tiene aperta la cattura in
  background. Nella pratica Android passa a Chrome solo silenzio ~8 s dopo (la
  diagnostica lo segnala come "silenzio assoluto"): meglio la mini finestra.
- **Keep-alive** (disattivabile): un WAV di rumore a −60 dBFS in loop tiene la pagina
  "in riproduzione", così Chrome non la congela. Appare la notifica multimediale.
- **Diagnostica** (Impostazioni): mic, trasmissione, gate, jitter e buffer per voce,
  ritardo scomposto e registro degli eventi.
- Il server chiude la trasmissione se chi parla cade o smette di inviare audio per 30 s.

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

## Pubblicazione su Render

1. Carica questo repository su GitHub (anche privato).
2. Su [render.com](https://render.com): **New → Blueprint** e scegli il repository.
   Render legge `render.yaml`, chiede il valore di `ACCESS_CODE` (il codice per i
   colleghi) e crea il servizio a Francoforte con HTTPS incluso.
3. L'app sarà su `https://<nome-servizio>.onrender.com`. Ogni `git push` la aggiorna.

Piano gratuito: dopo 15 minuti senza traffico il servizio si spegne e la prima apertura
successiva impiega ~1 minuto. Le pagine aperte si riconnettono da sole. Per averlo sempre
acceso cambia `plan: free` in `plan: starter` ($7/mese) o modificalo dalla dashboard.

## Latenza misurata

Test in locale (Chrome desktop, collega simulato che invia opus da 10 ms, 15 s per prova,
uscita audio del PC 50 ms):

| Rete simulata | Buffer | Interruzioni | Ritardo stimato |
|---|---|---|---|
| jitter 0–30 ms | 41 ms | 0 | ~100 ms |
| jitter 0–150 ms + blocchi da 400 ms ogni 5 s | ~300 ms | 3 | ~390 ms |
| di nuovo 0–30 ms, dopo 14 s | 41–48 ms | 0 nuove | ~105 ms |

Il ritardo stimato (in basso nella pagina, scomposto nella diagnostica) è frame +
metà RTT + jitter buffer + latenza d'uscita dell'audio; manca la latenza d'ingresso del
microfono, che il browser non espone. Su Internet aggiungi l'RTT verso il server: conviene una
regione vicina (Francoforte per l'Italia, non Oregon).

L'AudioContext su Android esce come media (non come chiamata), purché non venga
instradato in un `<audio>` tramite `srcObject`/MediaStream: Chrome lo tratterebbe come
audio RTC.

## Da verificare su Android

Non ancora provato su un telefono vero:
- che con AEC/NS/AGC disattivati Chrome non passi in `MODE_IN_COMMUNICATION`. Come
  verificarlo: con il mic aperto premi il tasto volume; se regola il volume "chiamata"
  invece di quello "multimediale", Chrome è passato in modalità chiamata;
- la ricezione in background per lunghi periodi con lo schermo spento (dipende dal
  produttore: alcune ROM uccidono Chrome; esclusione dall'ottimizzazione batteria);
- che un'altra app che prende il focus audio (YouTube, Spotify) metta in pausa il canale:
  è il comportamento standard di Android. Si riprende dalla notifica multimediale.

Browser: Chrome o Edge aggiornati (Android e desktop): servono WebCodecs `AudioEncoder`/
`AudioDecoder` con opus e AudioWorklet.

## File

- `server.py`: server aiohttp (static + `/ws`, canali, voci, messaggi, `/upload`, `/f/…`)
- `public/index.html`, `public/style.css`: interfaccia
- `public/app.js`: chiamata (opus, jitter), condivisi, mini finestra, ciclo di vita del mic
- `public/audio-worklet.js`: cattura a blocchi da 10 ms con gate, jitter buffer, mix e livelli
