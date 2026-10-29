# 📻 Walkie-Talkie WebSocket (zero WebRTC)

Radio push-to-talk tra colleghi, nel browser. Niente `RTCPeerConnection`: Android non la
vede come una chiamata, l'audio esce sul canale **Musica** e il telefono resta libero
(puoi aprire altre app mentre continui a sentire il canale).

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

Come una telefonata: pacchetti opus da 10 ms (WebCodecs), ognuno indipendente, e un
jitter buffer adattivo nel thread audio. Niente MediaRecorder/MSE, che su Chrome
richiedevano almeno 200 ms di buffer e si inceppavano sulla rete mobile.

- **Più voci insieme**: fino a 4 persone possono parlare in contemporanea. Il server
  mette in testa a ogni pacchetto l'id di chi parla; la pagina ha un decoder per voce e
  il worklet di riproduzione le mixa. La quinta persona riceve "Canale pieno".
- **Jitter buffer**: l'obiettivo è il 97° percentile del ritardo d'arrivo dei pacchetti
  negli ultimi 10 s, più 10 ms (min 30, max 600 ms). Ogni interruzione aggiunge 20 ms di
  margine che svanisce in meno di un secondo di audio. Così il buffer sale appena la rete
  peggiora e torna giù entro ~10 s quando si calma. Il ritardo accumulato si
  recupera scartando i blocchi di silenzio tra le parole, non la voce. Il server, se un
  ascoltatore ha più di ~1 s in coda, gli salta qualche pacchetto invece di accumulare.
- **Due modalità**: 📻 *Radio* (tieni premuto per parlare, o VOX) e 📞 *Chiamata*
  (microfono sempre aperto finché la pagina è in primo piano, il tasto silenzia).
  Chi entra a metà sente subito (i pacchetti sono indipendenti). Le chiamate non hanno
  il limite dei 120 s.
- **Microfono anche fuori dal browser** (opzione della modalità Chiamata, spenta di
  default): passando a un'altra app il microfono resta aperto e la trasmissione continua.
  Chrome Android mantiene la cattura in background con la notifica "microfono in uso".
  Nella pratica Android passa a Chrome solo silenzio ~8 s dopo che la pagina va in
  background (la diagnostica lo segnala come "silenzio assoluto").
- **Mini finestra automatica** (opzione della modalità Chiamata): la pagina va a schermo
  intero con sotto un video invisibile (webm registrato da un canvas) che la copre. Chrome
  Android, se premi Home mentre un video è a schermo intero, si riduce da solo in
  Picture-in-Picture: resta visibile e quindi conserva il microfono. Ogni tocco sulla
  pagina richiede di nuovo lo schermo intero (serve un gesto). Il PiP all'uscita è una
  funzione di Chrome: sugli altri browser Android (Xiaomi, Samsung Internet, Firefox,
  Opera…) la pagina mostra "Apri in Chrome" (link `intent://` con
  `package=com.android.chrome`) e, se il browser ha l'API Picture-in-Picture, un tasto
  per aprire la finestrella a mano.
- **Diagnostica** (Impostazioni → Mostra diagnostica): stato di mic, trasmissione, kbit/s
  ricevuti per voce e stato di ogni lettore `<audio>`, utile per i problemi sui telefoni.
- **Niente cancellazione d'eco**: con `echoCancellation: true` Chrome Android apre il
  microfono come VOICE_COMMUNICATION e mette il telefono in modalità chiamata (anche
  l'uscita audio diventa "chiamata"). Per questo è sempre spenta.
- **Rumore nelle pause** (Impostazioni → "Silenzia il rumore nelle pause", acceso di
  default): tutto software nella pagina. Un passa-alto a 80 Hz toglie il rombo e un gate
  nel worklet di cattura stima il rumore di fondo e, nelle pause, abbassa il microfono di
  26 dB (apre in 5 ms, chiude dopo 250 ms con una coda di 120 ms). Prova in locale:
  fruscio nelle pause da -51 a -74 dBFS, voce invariata.
- **Eco in vivavoce**: senza cancellazione d'eco il microfono sente l'altoparlante, quindi
  in vivavoce chi parla insieme a te può sentire un'eco della propria voce. Rimedi, nelle
  Impostazioni: le cuffie oppure "Abbassa gli altri mentre parlo"
  (solo Radio: mentre tieni premuto gli altri scendono al 20%). Senza "Uso le cuffie" il VOX non scatta
  mentre parlano gli altri; il PTT funziona sempre in contemporanea.
- **Microfono solo con pagina visibile**: su `visibilitychange` → `hidden` tutte le
  tracce vengono fermate (`track.stop()`), l'indicatore microfono di Android si spegne.
  L'AudioContext continua a suonare in background.
- **Keep-alive** (disattivabile): un WAV di rumore a −60 dBFS in loop tiene la pagina
  "in riproduzione", così Chrome non la congela tra una trasmissione e l'altra. Appare la
  notifica multimediale "Canale X" (con "X sta parlando" durante la ricezione).
- **VOX**: misura il livello del mic (AnalyserNode, l'AudioContext non è collegato
  all'uscita), soglia regolabile, 0.9 s di coda.
- Il server chiude la trasmissione se chi parla cade, smette di inviare audio per 4 s
  (30 s in chiamata) o supera i 120 s (solo Radio).

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
3. L'app sarà su `https://walkie-talkie-xxxx.onrender.com`. Ogni `git push` la aggiorna.

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

- `server.py`: server aiohttp (static + `/ws`, canali, floor control, watchdog)
- `public/index.html`, `public/style.css`: interfaccia
- `public/app.js`: cattura, codifica/decodifica opus, PTT/VOX, ciclo di vita del microfono
- `public/audio-worklet.js`: cattura a blocchi da 20 ms, jitter buffer e mix delle voci
