"""
Aracne: server di chiamata di gruppo e condivisione (WebSocket, zero WebRTC).

- Serve i file statici in ./public
- /ws : canali in cui possono parlare fino a MAX_SPEAKERS persone in contemporanea
- I pacchetti audio (opus da 20 ms, [seq 2 byte | opus]) arrivano come frame binari e
  vengono inoltrati a tutti gli altri del canale preceduti dall'id (8 byte ASCII) di chi
  parla, così ogni ascoltatore li smista nel decoder giusto. Ogni pacchetto è
  indipendente: chi entra a metà sente subito, e a un ascoltatore lento si possono
  saltare pacchetti senza rompere niente.
- Messaggi (testo e link) sul WebSocket; i file (anche APK) si caricano con POST /upload,
  fuori dal WebSocket così un file grande non rallenta la voce, e si scaricano da
  /f/<id>/<nome>. Restano sul server per FILE_TTL (e spariscono se il server riparte).

Avvio:
    python server.py                      # http://0.0.0.0:8080
    python server.py --https              # https con certificato self-signed (per test su LAN)
    python server.py --cert c.pem --key k.pem
    ACCESS_CODE=segreto python server.py  # richiede un codice per entrare
"""

import argparse
import asyncio
import ipaddress
import json
import logging
import mimetypes
import os
import secrets
import socket
import ssl
import tempfile
import time
import uuid
from collections import deque
from pathlib import Path
from urllib.parse import quote, unquote

from aiohttp import WSMsgType, web

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"

ACCESS_CODE = os.environ.get("ACCESS_CODE", "")
MAX_SPEAKERS = 4            # voci contemporanee per canale (= lettori audio nel client)
MAX_TX_SECONDS = 120        # durata massima di una trasmissione
SILENT_TX_TIMEOUT = 4.0     # chiude la trasmissione se chi parla non invia audio
SILENT_CALL_TIMEOUT = 30.0  # in chiamata si tollerano pause lunghe (telefono in background, rete lenta)
MAX_CLIENT_BACKLOG = 16 * 1024  # oltre ~1 s di audio in coda si saltano pacchetti: meglio un buco del ritardo
MAX_NAME = 32
MAX_TEXT = 2000             # caratteri per messaggio
HISTORY = 100               # messaggi tenuti per canale (mandati a chi entra)
MAX_UPLOAD = 100 * 1024 * 1024   # 100 MB per file
MAX_STORAGE = 1024 * 1024 * 1024  # 1 GB in tutto: oltre si cancellano i file più vecchi
FILE_TTL = 24 * 3600        # i file restano 24 ore
UPLOAD_DIR = Path(tempfile.gettempdir()) / "aracne-files"
APK_TYPE = "application/vnd.android.package-archive"
# Mostrati nella pagina (anteprima); tutto il resto si scarica come allegato.
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}

log = logging.getLogger("walkie")


class Client:
    def __init__(self, ws: web.WebSocketResponse, transport: asyncio.Transport | None):
        self.id = uuid.uuid4().hex[:8]
        self.id_bytes = self.id.encode()
        self.ws = ws
        self.transport = transport
        self.name = ""
        self.channel: "Channel | None" = None
        self.token = secrets.token_urlsafe(18)   # autorizza i caricamenti di file

    def info(self):
        return {"id": self.id, "name": self.name}


class Tx:
    """Una trasmissione in corso."""

    def __init__(self, call: bool):
        now = time.monotonic()
        self.call = call          # microfono aperto: nessun limite di durata
        self.started = now
        self.last_audio = now


class Channel:
    def __init__(self, name: str):
        self.name = name
        self.clients: set[Client] = set()
        self.speakers: dict[Client, Tx] = {}
        self.history: deque[dict] = deque(maxlen=HISTORY)

    def users(self):
        return [c.info() for c in self.clients]

    def talking(self):
        return [c.info() for c in self.speakers]


channels: dict[str, Channel] = {}
tokens: dict[str, Client] = {}


class StoredFile:
    def __init__(self, fid: str, name: str, ctype: str, size: int):
        self.id = fid
        self.name = name
        self.type = ctype
        self.size = size
        self.path = UPLOAD_DIR / fid
        self.created = time.time()


files: dict[str, StoredFile] = {}


async def send_json(client: Client, obj: dict):
    if not client.ws.closed:
        try:
            await client.ws.send_str(json.dumps(obj))
        except ConnectionError:
            pass


async def broadcast(channel: Channel, obj: dict, exclude: Client | None = None):
    await asyncio.gather(*(send_json(c, obj) for c in channel.clients if c is not exclude))


async def end_tx(channel: Channel, speaker: Client, reason: str = "stop"):
    if channel.speakers.pop(speaker, None) is None:
        return
    log.info("[%s] %s ha smesso di parlare (%s)", channel.name, speaker.name, reason)
    await broadcast(channel, {"t": "talk_end", "id": speaker.id, "reason": reason})


async def leave(client: Client):
    channel = client.channel
    if channel is None:
        return
    client.channel = None
    channel.clients.discard(client)
    await end_tx(channel, client, "disconnect")
    if channel.clients:
        await broadcast(channel, {"t": "users", "users": channel.users()})
    elif not channel.history:
        channels.pop(channel.name, None)


async def handle_json(client: Client, msg: dict):
    t = msg.get("t")

    if t == "ping":
        await send_json(client, {"t": "pong", "ts": msg.get("ts")})
        return

    if t == "join":
        if ACCESS_CODE and msg.get("code") != ACCESS_CODE:
            await send_json(client, {"t": "error", "code": "auth", "msg": "Codice di accesso errato"})
            return
        name = str(msg.get("name") or "").strip()[:MAX_NAME] or "Anonimo"
        ch_name = str(msg.get("channel") or "").strip().lower()[:MAX_NAME] or "generale"
        await leave(client)
        client.name = name
        channel = channels.setdefault(ch_name, Channel(ch_name))
        channel.clients.add(client)
        client.channel = channel
        log.info("[%s] entra %s (%d utenti)", ch_name, name, len(channel.clients))
        await send_json(client, {
            "t": "joined",
            "id": client.id,
            "channel": ch_name,
            "users": channel.users(),
            "talking": channel.talking(),
            "maxSpeakers": MAX_SPEAKERS,
            "token": client.token,
            "history": list(channel.history),
            "maxUpload": MAX_UPLOAD,
        })
        await broadcast(channel, {"t": "users", "users": channel.users()}, exclude=client)
        return

    channel = client.channel
    if channel is None:
        return

    if t == "ptt_start":
        if client not in channel.speakers and len(channel.speakers) >= MAX_SPEAKERS:
            await send_json(client, {"t": "floor_denied", "by": channel.talking()})
            return
        channel.speakers[client] = Tx(msg.get("mode") == "call")
        log.info("[%s] %s parla (%d voci)", channel.name, client.name, len(channel.speakers))
        await send_json(client, {"t": "floor_granted"})
        await broadcast(channel, {"t": "talk_start", **client.info()}, exclude=client)
        return

    if t == "ptt_stop":
        await end_tx(channel, client)
        return

    if t == "msg":
        text = str(msg.get("text") or "").strip()[:MAX_TEXT]
        if text:
            await post(channel, client, {"text": text})
        return


async def post(channel: Channel, client: Client, body: dict):
    """Messaggio o file nel canale: va nella cronologia e a tutti, mittente compreso."""
    item = {"t": "msg", "mid": uuid.uuid4().hex[:12], "from": client.id, "name": client.name,
            "ts": int(time.time() * 1000), **body}
    channel.history.append(item)
    await broadcast(channel, item)


async def relay_audio(client: Client, data: bytes):
    channel = client.channel
    tx = channel.speakers.get(client) if channel else None
    if tx is None:
        return
    tx.last_audio = time.monotonic()
    frame = client.id_bytes + data
    sends = []
    for listener in channel.clients:
        if listener is client or listener.ws.closed:
            continue
        backlog = listener.transport.get_write_buffer_size() if listener.transport else 0
        if backlog > MAX_CLIENT_BACKLOG:
            continue  # ascoltatore lento: perde questo pacchetto, non accumula ritardo
        sends.append(send_audio(listener, frame))
    await asyncio.gather(*sends)


async def send_audio(listener: Client, frame: bytes):
    try:
        await listener.ws.send_bytes(frame)
    except ConnectionError:
        pass


async def ws_handler(request: web.Request):
    ws = web.WebSocketResponse(heartbeat=15, max_msg_size=256 * 1024, compress=False)
    await ws.prepare(request)
    # Niente Nagle: i chunk partono subito
    sock = request.transport.get_extra_info("socket") if request.transport else None
    if sock is not None:
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    client = Client(ws, request.transport)
    tokens[client.token] = client
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                await relay_audio(client, msg.data)
            elif msg.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                except ValueError:
                    continue
                if isinstance(payload, dict):
                    await handle_json(client, payload)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        tokens.pop(client.token, None)
        await leave(client)
    return ws


def clean_name(raw: str) -> str:
    name = Path(unquote(raw or "")).name.strip().replace("\x00", "")[:120]
    return name or "file"


async def upload(request: web.Request):
    client = tokens.get(request.headers.get("X-Token", ""))
    if client is None or client.channel is None:
        return web.json_response({"error": "Non sei collegato a un canale"}, status=403)
    length = request.content_length
    if length is not None and length > MAX_UPLOAD:
        return web.json_response({"error": "File troppo grande (max 100 MB)"}, status=413)
    name = clean_name(request.headers.get("X-Filename", ""))
    ctype = APK_TYPE if name.lower().endswith(".apk") else (
        mimetypes.guess_type(name)[0] or "application/octet-stream")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    fid = secrets.token_urlsafe(16)
    path = UPLOAD_DIR / fid
    size = 0
    try:
        with path.open("wb") as f:
            async for chunk in request.content.iter_chunked(256 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise ValueError("troppo grande")
                f.write(chunk)
    except ValueError:
        path.unlink(missing_ok=True)
        return web.json_response({"error": "File troppo grande (max 100 MB)"}, status=413)
    except (ConnectionError, asyncio.CancelledError):
        path.unlink(missing_ok=True)
        raise
    if size == 0:
        path.unlink(missing_ok=True)
        return web.json_response({"error": "File vuoto"}, status=400)
    stored = StoredFile(fid, name, ctype, size)
    files[fid] = stored
    prune_files()
    channel = client.channel
    if channel is not None:
        log.info("[%s] %s condivide %s (%d KB)", channel.name, client.name, name, size // 1024)
        await post(channel, client, {"file": {
            "url": f"/f/{fid}/{quote(name)}", "name": name, "size": size, "type": ctype,
            "expires": int((stored.created + FILE_TTL) * 1000),
        }})
    return web.json_response({"ok": True})


async def download(request: web.Request):
    stored = files.get(request.match_info["fid"])
    if stored is None or not stored.path.exists():
        return web.Response(status=404, text="File scaduto o non trovato")
    inline = stored.type in INLINE_TYPES
    disposition = "inline" if inline else "attachment"
    return web.FileResponse(stored.path, headers={
        "Content-Type": stored.type,
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(stored.name)}",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
        "Cache-Control": "private, max-age=3600",
    })


def prune_files():
    """Toglie i file scaduti e, oltre MAX_STORAGE, i più vecchi."""
    now = time.time()
    for f in sorted(files.values(), key=lambda f: f.created):
        total = sum(x.size for x in files.values())
        if now - f.created > FILE_TTL or total > MAX_STORAGE:
            f.path.unlink(missing_ok=True)
            files.pop(f.id, None)


async def tx_watchdog(app: web.Application):
    ticks = 0
    while True:
        await asyncio.sleep(1)
        ticks += 1
        if ticks % 600 == 0:
            prune_files()
        now = time.monotonic()
        for channel in list(channels.values()):
            for speaker, tx in list(channel.speakers.items()):
                silent_limit = SILENT_CALL_TIMEOUT if tx.call else SILENT_TX_TIMEOUT
                if now - tx.last_audio > silent_limit:
                    await end_tx(channel, speaker, "timeout")
                elif not tx.call and now - tx.started > MAX_TX_SECONDS:
                    await send_json(speaker, {"t": "tx_limit"})
                    await end_tx(channel, speaker, "limit")


async def start_background(app: web.Application):
    app["watchdog"] = asyncio.create_task(tx_watchdog(app))


async def stop_background(app: web.Application):
    app["watchdog"].cancel()


async def index(request: web.Request):
    return web.FileResponse(PUBLIC / "index.html", headers={"Cache-Control": "no-cache"})


async def healthz(request: web.Request):
    return web.Response(text="ok")


async def no_cache(request: web.Request, response: web.StreamResponse):
    # Il browser rivalida sempre (304 se invariato): dopo un deploy i telefoni
    # prendono subito il nuovo app.js invece di quello in cache.
    response.headers.setdefault("Cache-Control", "no-cache")


def self_signed_context() -> ssl.SSLContext:
    from datetime import datetime, timedelta, timezone

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    cert_dir = ROOT / ".cert"
    cert_path, key_path = cert_dir / "cert.pem", cert_dir / "key.pem"
    if not cert_path.exists():
        cert_dir.mkdir(exist_ok=True)
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "walkie-talkie.local")])
        hostname = socket.gethostname()
        sans = [x509.DNSName("localhost"), x509.DNSName(hostname), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
        try:
            for addr in {i[4][0] for i in socket.getaddrinfo(hostname, None, socket.AF_INET)}:
                sans.append(x509.IPAddress(ipaddress.ip_address(addr)))
        except OSError:
            pass
        now = datetime.now(timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=825))
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .sign(key, hashes.SHA256())
        )
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(cert_path, key_path)
    return ctx


def main():
    parser = argparse.ArgumentParser(description="Aracne: chiamata di gruppo e condivisione")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    parser.add_argument("--https", action="store_true", help="HTTPS con certificato self-signed")
    parser.add_argument("--cert", help="certificato PEM")
    parser.add_argument("--key", help="chiave privata PEM")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")

    ssl_ctx = None
    if args.cert and args.key:
        ssl_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_ctx.load_cert_chain(args.cert, args.key)
    elif args.https:
        ssl_ctx = self_signed_context()

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/healthz", healthz)
    app.router.add_post("/upload", upload)
    app.router.add_get("/f/{fid}/{name}", download)
    app.router.add_static("/", PUBLIC, show_index=False)
    app.on_response_prepare.append(no_cache)
    app.on_startup.append(start_background)
    app.on_cleanup.append(stop_background)

    scheme = "https" if ssl_ctx else "http"
    log.info("Aracne su %s://%s:%d %s", scheme, args.host, args.port,
             "(codice di accesso attivo)" if ACCESS_CODE else "")
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_ctx, print=None)


if __name__ == "__main__":
    main()
