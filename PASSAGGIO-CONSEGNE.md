# Passaggio consegne — Aracne (ex walkie-talkie)

Riassunto della discussione fatta con Claude (28–30 ottobre 2026), per riprendere il
lavoro da un altro PC o da un'altra sessione. Il codice è tutto in questo repository;
il funzionamento tecnico è nel [README](README.md).

## Dove sta

- **Repository**: https://github.com/rikyroky91-commits/walke-talkie (ramo `main`)
- **Online**: https://walke-talkie.onrender.com, su Render (piano gratuito, Francoforte).
  Ogni `git push` su `main` viene pubblicato da solo in 2–3 minuti.
- Il codice di accesso è la variabile `ACCESS_CODE` del servizio su Render.
- Il nome **Aracne** è provvisorio: in [app.js](public/app.js) è la costante
  `APP_NAME`, più `<title>` e le scritte in [index.html](public/index.html). Il nome del
  repository e l'indirizzo di Render sono ancora quelli vecchi.

## Regole fisse (decise dall'utente)

1. **Android non deve mai vedere una chiamata.** Quindi:
   - niente WebRTC;
   - `echoCancellation`, `noiseSuppression` e `autoGainControl` **sempre `false`**, mai
     nemmeno come opzione. Un'opzione "Cancellazione eco" aggiunta per prova ha messo i
     telefoni in modalità chiamata ed è stata tolta.
   - Ogni pulizia dell'audio va fatta nella pagina: oggi un passa-alto a 80 Hz e un
     gate nel worklet di cattura.
2. L'eco in vivavoce (gli altri sentono la propria voce) si risolve con le cuffie.
3. **Solo Chrome su Android**: le pagine aperte da altri browser (Xiaomi, Samsung,
   Firefox…) passano da sole a Chrome.

## Come si è arrivati qui

| Problema | Soluzione adottata |
|---|---|
| Parlare in contemporanea | Fino a 4 voci per canale, mixate nel browser |
| Audio a pezzi e lag con MediaRecorder + MSE | Opus a pacchetti da 10 ms con WebCodecs, jitter buffer in AudioWorklet calcolato sul jitter misurato. Ritardo stimato ~100 ms su rete buona (prova in locale) |
| Microfono perso in background | Android passa a Chrome solo silenzio ~8 s dopo che la pagina va in background (verificato con la diagnostica sui telefoni). Soluzione: **mini finestra automatica**: schermo intero con un video, e Chrome va in Picture-in-Picture premendo Home, restando visibile. **Confermato funzionante su Chrome** |
| Browser Xiaomi senza PiP automatico | Salto automatico a Chrome (`intent://`, `googlechrome://`, link copiato negli appunti) |
| Rumore di fondo nelle pause | Gate software (-26 dB nelle pause), passa-alto 80 Hz |
| Nuove funzioni | Tolta la modalità Radio, resta solo la chiamata. Nuova interfaccia. Messaggi, link e file fino a 100 MB, APK comprese (pulsante "Installa"). I file restano 24 ore |

## Aperto / da verificare sui telefoni

- **Redmi, barra in basso a schermo intero.** Nello screenshot del Redmi la barra per
  scrivere era coperta dal messaggio di Chrome ("per uscire dalla modalità a schermo
  intero…"). Correzioni fatte:
  - l'app è ancorata ai bordi dello schermo visibile;
  - a schermo intero la barra resta sempre 120 px sopra il fondo: sul Redmi la fascia
    bassa resta coperta anche dopo il messaggio di Chrome (alzarla solo per 5 s non bastava).

  Da riprovare. Se non basta: Impostazioni → Mostra diagnostica. Il registro scrive
  `schermo intero: finestra LxA · visibile A · barra fino a Y`; se Y supera A, la barra è
  davvero fuori schermo.
- **Finestrella (PiP) nera.** Probabile causa: il video era trasparente. Ora:
  - il video è visibile, sotto l'app, con nome dell'app, canale e "tocca per tornare";
  - se Chrome nella finestrella mostra la pagina, sotto i 420×300 px la pagina diventa
    una vista compatta dal vivo: partecipanti, bagliore su chi parla, stato.

  Da verificare quale dei due casi si vede sul telefono.
- **Ritardo reale sui telefoni**: la diagnostica scompone il ritardo in pacchetto, rete,
  buffer e uscita. Serve uno screenshot dopo ~20 s di chiamata.

## Prossimo passo concordato: spostare tutto su Oracle

Sulla VM Oracle c'è già la piattaforma Android Updater, quindi non servono né account né
macchina nuova. Guadagni attesi:
- niente "risveglio" da 1 minuto di Render gratuito;
- file persistenti;
- RTT più basso se la VM è a Milano (~10–20 ms in meno);
- in futuro si potrà usare UDP (WebTransport) per avere meno interruzioni sulla rete
  mobile.

Cosa serve sapere, dal PC che ha l'accesso alla VM:
1. come si accede (SSH con chiave, oppure console Oracle);
2. l'indirizzo con cui si apre l'Updater (`https://…`, oppure solo IP);
3. il proxy che lo serve (nginx, Caddy o niente) e il sistema (Ubuntu oppure Oracle Linux).

Piano:
1. Aracne nella sua cartella con un virtualenv suo, su una porta libera (es. 8090),
   senza toccare l'Updater.
2. Servizio systemd con riavvio automatico.
3. Regola nel proxy esistente, con sottodominio o percorso: deve far passare i
   **WebSocket** su `/ws` e caricamenti fino a 100 MB su `/upload`.
4. Aggiornamento automatico da GitHub (timer che fa `git pull` e riavvia, oppure
   GitHub Actions via SSH).
5. Verifica, poi i colleghi passano al nuovo indirizzo e Render si spegne.

## Provare in locale

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python server.py          # http://localhost:8080
```

In un browser senza microfono si può simulare tutto dalla console:
- un microfono finto: `navigator.mediaDevices.getUserMedia` che restituisce un oscillatore;
- colleghi finti: altri `WebSocket` su `/ws` che mandano `{t:'join'}`, `{t:'ptt_start', mode:'call'}`,
  pacchetti `[istante 2 byte | opus]` e `{t:'msg', text}`.
