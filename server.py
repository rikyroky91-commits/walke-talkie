"""
Walkie-Talkie relay server (WebSocket, zero WebRTC).

- Serve i file statici in ./public
- /ws : canali in cui possono parlare fino a MAX_SPEAKERS persone in contemporanea
- I chunk audio (webm/opus da MediaRecorder) arrivano come frame binari e vengono
  inoltrati agli altri preceduti dall'id (8 byte ASCII) di chi parla, così ogni
  ascoltatore li smista nel lettore audio giusto.

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
import os
import socket
import ssl
import time
import uuid
from pathlib import Path

from aiohttp import WSMsgType, web

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"

ACCESS_CODE = os.environ.get("ACCESS_CODE", "")
MAX_SPEAKERS = 4            # voci contemporanee per canale (= lettori audio nel client)
MAX_TX_SECONDS = 120        # durata massima di una trasmissione
SILENT_TX_TIMEOUT = 4.0     # chiude la trasmissione se chi parla non invia audio
MAX_CLIENT_BACKLOG = 48 * 1024  # ~15 s di audio in coda: l'ascoltatore lento salta la trasmissione
MAX_NAME = 32

log = logging.getLogger("walkie")


class Client:
    def __init__(self, ws: web.WebSocketResponse, transport: asyncio.Transport | None):
        self.id = uuid.uuid4().hex[:8]
        self.id_bytes = self.id.encode()
        self.ws = ws
        self.transport = transport
        self.name = ""
        self.channel: "Channel | None" = None

    def info(self):
        return {"id": self.id, "name": self.name}


class Tx:
    """Una trasmissione in corso."""

    def __init__(self, listeners: set[Client]):
        now = time.monotonic()
        # Solo chi è presente all'inizio riceve: lo stream webm ha l'header
        # nel primo chunk, chi entra a metà aspetta la trasmissione successiva.
        self.listeners = listeners
        self.started = now
        self.last_audio = now


class Channel:
    def __init__(self, name: str):
        self.name = name
        self.clients: set[Client] = set()
        self.speakers: dict[Client, Tx] = {}

    def users(self):
        return [c.info() for c in self.clients]

    def talking(self):
        return [c.info() for c in self.speakers]


channels: dict[str, Channel] = {}


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
    for tx in channel.speakers.values():
        tx.listeners.discard(client)
    await end_tx(channel, client, "disconnect")
    if channel.clients:
        await broadcast(channel, {"t": "users", "users": channel.users()})
    else:
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
        channel.speakers[client] = Tx({c for c in channel.clients if c is not client})
        log.info("[%s] %s parla (%d voci)", channel.name, client.name, len(channel.speakers))
        await send_json(client, {"t": "floor_granted"})
        await broadcast(channel, {"t": "talk_start", **client.info()}, exclude=client)
        return

    if t == "ptt_stop":
        await end_tx(channel, client)
        return


async def relay_audio(client: Client, data: bytes):
    channel = client.channel
    tx = channel.speakers.get(client) if channel else None
    if tx is None:
        return
    tx.last_audio = time.monotonic()
    frame = client.id_bytes + data
    sends = []
    for listener in list(tx.listeners):
        backlog = listener.transport.get_write_buffer_size() if listener.transport else 0
        if listener.ws.closed or backlog > MAX_CLIENT_BACKLOG:
            # Saltare chunk a metà corromperebbe lo stream: l'ascoltatore lento
            # perde il resto di questa trasmissione e riparte dalla prossima.
            tx.listeners.discard(listener)
            sends.append(send_json(listener, {"t": "talk_skip", "id": client.id}))
        else:
            sends.append(send_audio(tx, listener, frame))
    await asyncio.gather(*sends)


async def send_audio(tx: Tx, listener: Client, frame: bytes):
    try:
        await listener.ws.send_bytes(frame)
    except ConnectionError:
        tx.listeners.discard(listener)


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
        await leave(client)
    return ws


async def tx_watchdog(app: web.Application):
    while True:
        await asyncio.sleep(1)
        now = time.monotonic()
        for channel in list(channels.values()):
            for speaker, tx in list(channel.speakers.items()):
                if now - tx.last_audio > SILENT_TX_TIMEOUT:
                    await end_tx(channel, speaker, "timeout")
                elif now - tx.started > MAX_TX_SECONDS:
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
    parser = argparse.ArgumentParser(description="Walkie-Talkie WebSocket server")
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
    app.router.add_static("/", PUBLIC, show_index=False)
    app.on_startup.append(start_background)
    app.on_cleanup.append(stop_background)

    scheme = "https" if ssl_ctx else "http"
    log.info("Walkie-Talkie su %s://%s:%d %s", scheme, args.host, args.port,
             "(codice di accesso attivo)" if ACCESS_CODE else "")
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_ctx, print=None)


if __name__ == "__main__":
    main()
