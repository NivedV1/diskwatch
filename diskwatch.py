#!/usr/bin/env python3
"""Read Linux drive telemetry and serve a local, read-only dashboard."""

import argparse
from contextlib import closing
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import math
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = Path("/var/lib/diskwatch/history.sqlite3")
DAY = 86400
INTERVAL = 300
RETENTION = 30 * DAY
PORT = 8765
DRIVE_ID = re.compile(r"[a-f0-9]{24}")

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    issue TEXT,
    demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_timestamp ON runs(timestamp);
CREATE TABLE IF NOT EXISTS samples (
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    drive_id TEXT NOT NULL,
    path TEXT NOT NULL,
    device_type TEXT NOT NULL,
    model TEXT NOT NULL,
    kind TEXT NOT NULL,
    protocol TEXT NOT NULL,
    capacity INTEGER,
    temperature REAL,
    health TEXT NOT NULL,
    reading TEXT NOT NULL,
    detail TEXT,
    metrics TEXT NOT NULL,
    PRIMARY KEY (run_id, drive_id)
);
CREATE INDEX IF NOT EXISTS samples_drive ON samples(drive_id, run_id);
CREATE INDEX IF NOT EXISTS samples_slot ON samples(path, device_type, run_id);
"""

READING_PRIORITY = {"ok": 0, "partial": 1, "standby": 2, "unavailable": 3}


def database(path, readonly=False):
    target = f"{path.resolve().as_uri()}?mode=ro" if readonly else path
    db = sqlite3.connect(target, uri=readonly, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def prepare_database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(database(path)) as db:
        db.executescript(SCHEMA)


def purge(db, now):
    db.execute("DELETE FROM runs WHERE timestamp < ?", (now - RETENTION,))


def save_run(db, timestamp, samples, issue=None, demo=False):
    run = db.execute(
        "INSERT INTO runs (timestamp, issue, demo) VALUES (?, ?, ?)",
        (timestamp, issue, demo),
    )
    db.executemany(
        """
        INSERT INTO samples VALUES (
            :run_id, :drive_id, :path, :device_type, :model, :kind, :protocol, :capacity,
            :temperature, :health, :reading, :detail, :metrics
        )
        """,
        (dict(sample, run_id=run.lastrowid, metrics=json.dumps(sample["metrics"]))
         for sample in samples),
    )


class SmartError(Exception):
    pass


def smartctl(executable, *args):
    try:
        result = subprocess.run(
            [executable, "-j", *args], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=15, check=False,
        )
    except FileNotFoundError as exc:
        raise SmartError("smartctl was not found. Install the smartmontools package.") from exc
    except subprocess.TimeoutExpired as exc:
        raise SmartError("smartctl did not respond within 15 seconds.") from exc
    except OSError as exc:
        raise SmartError(f"Could not run smartctl: {exc.strerror}") from exc
    try:
        payload = json.loads(result.stdout)
    except ValueError as exc:
        raise SmartError("smartctl did not return JSON. Check that smartmontools supports -j.") from exc
    if not isinstance(payload, dict) or result.returncode < 0:
        raise SmartError("smartctl did not return a usable response.")
    return result.returncode, payload


def messages(payload):
    entries = payload.get("smartctl", {}).get("messages", [])
    return " ".join(str(entry["string"]) for entry in entries if entry.get("string"))[:350]


def discover(executable, configured):
    if configured:
        return configured
    status, payload = smartctl(executable, "--scan")
    if status:
        raise SmartError(messages(payload) or f"Disk discovery failed (smartctl exit {status}).")
    devices = []
    for drive in payload.get("devices", []):
        name = drive["name"]
        if not name.startswith("/dev/"):
            continue
        device_type = drive.get("type", "")
        # An unopened SATA disk may appear as generic SCSI. Let smartctl
        # detect ATA passthrough when reading it, but keep explicit RAID types.
        devices.append((name, "" if device_type == "scsi" else device_type, drive.get("protocol", "")))
    return list(dict.fromkeys(devices))


def read_rotation(path):
    try:
        name = Path(path).resolve().name
        return (Path("/sys/class/block") / name / "queue/rotational").read_text().strip()
    except OSError:
        return None


def number(value):
    if type(value) is int or (type(value) is float and math.isfinite(value)):
        return value
    return None


def count(value):
    value = number(value)
    return value if value is not None and value >= 0 else None


def celsius(value):
    value = number(value)
    return value if value is not None and -40 <= value <= 150 else None


def ata_temperature(attributes):
    for code in (194, 190):
        raw = attributes.get(code, {})
        match = re.match(r"\s*(-?\d+)", str(raw.get("string", "")))
        value = celsius(int(match[1]) if match else raw.get("value"))
        if value is not None:
            return value
    return None


def stable_id(*parts):
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:24]


def drive_sample(executable, device, previous):
    path, device_type, protocol_hint = device
    rotation = read_rotation(path)
    args = ["-a"]
    if device_type:
        args += ["-d", device_type]
    if rotation != "0" and not (
        device_type.startswith("nvme") or protocol_hint.lower() == "nvme"
        or Path(path).name.startswith("nvme")
    ):
        args += ["-n", "standby,99"]

    issue = None
    try:
        status, data = smartctl(executable, *args, path)
    except SmartError as exc:
        status, data, issue = 2, {}, str(exc)

    protocol = data.get("device", {}).get("protocol") or protocol_hint or (previous or {}).get("protocol", "")
    reported_rotation = number(data.get("rotation_rate"))
    if protocol.lower() == "nvme" or device_type.startswith("nvme"):
        kind = "NVMe SSD"
    elif reported_rotation is not None:
        kind = "HDD" if reported_rotation > 0 else "SATA SSD" if protocol == "ATA" else "SSD"
    elif rotation in ("0", "1"):
        kind = "HDD" if rotation == "1" else "SATA SSD" if protocol == "ATA" else "SSD"
    else:
        kind = (previous or {}).get("kind", "Drive")

    model = (
        data.get("model_name") or data.get("scsi_model_name")
        or " ".join(filter(None, (data.get("vendor"), data.get("product"))))
    )
    serial = data.get("serial_number")
    # Include the model in the identity to distinguish devices with shared serials.
    drive_id = stable_id(model, serial) if model and serial else (
        (previous or {}).get("drive_id") or stable_id(path, device_type)
    )
    prior = (previous or {}) if not serial or drive_id == (previous or {}).get("drive_id") else {}
    capacity = count(data.get("user_capacity", {}).get("bytes"))
    if capacity is not None and (type(capacity) is not int or capacity > 2**63 - 1):
        capacity = None

    ata = {entry["id"]: entry.get("raw", {}) for entry in data.get("ata_smart_attributes", {}).get("table", [])}
    nvme = data.get("nvme_smart_health_information_log", {})
    temperature = celsius(data.get("temperature", {}).get("current"))
    if temperature is None:
        temperature = celsius(nvme.get("temperature"))
    if temperature is None:
        temperature = ata_temperature(ata)

    metrics = {
        "power_on_hours": count(data.get("power_on_time", {}).get("hours", nvme.get("power_on_hours"))),
        "power_cycles": count(data.get("power_cycle_count")),
        "reallocated_sectors": count(ata.get(5, {}).get("value")),
        "pending_sectors": count(ata.get(197, {}).get("value")),
        "uncorrectable_sectors": count(ata.get(198, {}).get("value")),
        "spare_percent": count(nvme.get("available_spare")),
        "used_percent": count(nvme.get("percentage_used")),
        "media_errors": count(nvme.get("media_errors")),
        "unsafe_shutdowns": count(nvme.get("unsafe_shutdowns")),
        "critical_warning": count(nvme.get("critical_warning")),
    }
    passed = data.get("smart_status", {}).get("passed")
    detail = None
    if status == 99:
        reading, health, detail = "standby", "unknown", "The drive is in standby."
        temperature, metrics = None, {}
    elif status & 3:
        reading, health = "unavailable", "unknown"
        detail = issue or messages(data) or f"Could not read the drive (smartctl exit {status})."
        temperature, metrics = None, {}
    else:
        reading = "partial" if status & 4 else "ok"
        if passed is False or status & 8:
            health = "failed"
        elif (
            status & 16 or (metrics["critical_warning"] or 0) > 0
            or (metrics["pending_sectors"] or 0) > 0
            or (metrics["uncorrectable_sectors"] or 0) > 0
            or (metrics["used_percent"] or 0) >= 100
        ):
            health = "warning"
        elif passed is True:
            health = "healthy"
        else:
            health = "unknown"
        if reading == "partial":
            detail = messages(data) or "Some SMART commands failed."
        elif health == "unknown":
            detail = "The drive did not report a SMART health result."

    return {
        "drive_id": drive_id, "path": path, "device_type": device_type,
        "model": model or prior.get("model") or path, "kind": kind, "protocol": protocol,
        "capacity": capacity or prior.get("capacity"), "temperature": temperature, "health": health,
        "reading": reading, "detail": detail,
        "metrics": {key: value for key, value in metrics.items() if value is not None},
    }


def collect(path, executable, configured):
    prepare_database(path)
    now = int(time.time())
    with closing(database(path)) as db:
        if db.execute("SELECT 1 FROM runs WHERE demo = 1 LIMIT 1").fetchone():
            raise ValueError("Use a separate database for live drive readings.")
        previous = {}
        for row in db.execute(
            """SELECT s.drive_id, s.path, s.device_type, s.model, s.kind, s.protocol, s.capacity
               FROM samples s JOIN (
                   SELECT path, device_type, MAX(run_id) AS last_run
                   FROM samples JOIN runs ON runs.id = samples.run_id
                   WHERE timestamp >= ? GROUP BY path, device_type
               ) latest ON s.path = latest.path AND s.device_type = latest.device_type
                       AND s.run_id = latest.last_run""",
            (now - RETENTION,),
        ):
            previous[row["path"], row["device_type"]] = dict(row)

    issue = None
    try:
        devices = discover(executable, configured)
    except SmartError as exc:
        devices, issue = [], str(exc)
    if not devices and issue is None:
        issue = "No SMART-capable drives were detected. Check device access or configure a device explicitly."
    if issue:
        logging.warning("%s", issue)
    samples = {}
    for device in devices:
        sample = drive_sample(executable, device, previous.get(device[:2]))
        if sample["reading"] != "ok":
            logging.info("%s · %s", sample["path"], sample["detail"])
        existing = samples.get(sample["drive_id"])
        if existing is None or READING_PRIORITY[sample["reading"]] < READING_PRIORITY[existing["reading"]]:
            samples[sample["drive_id"]] = sample
    with closing(database(path)) as db, db:
        for sample in samples.values():
            slot = (sample["path"], sample["device_type"])
            placeholder = stable_id(*slot)
            prior = previous.get(slot)
            if prior and prior["drive_id"] == placeholder and sample["drive_id"] != placeholder:
                # Keep the first standby or unreadable samples with the identified drive.
                db.execute("UPDATE OR IGNORE samples SET drive_id = ? WHERE drive_id = ?",
                           (sample["drive_id"], placeholder))
        save_run(db, now, samples.values(), issue)
        purge(db, now)
    logging.info("Recorded %d drive readings in %s", len(samples), path)


def dashboard(db, now):
    latest = db.execute(
        "SELECT * FROM runs WHERE timestamp >= ? ORDER BY id DESC LIMIT 1", (now - RETENTION,)
    ).fetchone()
    result = {"host": socket.gethostname(), "last_collection": None, "issue": None,
              "demo": False, "drives": [], "interval": INTERVAL}
    if latest is None:
        return result

    if latest["demo"]:
        result.update(host="lab-node-01", demo=True)
    result.update(last_collection=latest["timestamp"], issue=latest["issue"])
    for row in db.execute(
        """SELECT s.*, r.timestamp FROM samples s JOIN runs r ON r.id = s.run_id
           JOIN (
               SELECT s.drive_id, MAX(s.run_id) AS newest
               FROM samples s JOIN runs r ON r.id = s.run_id
               WHERE r.timestamp >= ? GROUP BY s.drive_id
           ) recent ON recent.drive_id = s.drive_id AND recent.newest = s.run_id
           ORDER BY s.run_id DESC, s.path, s.device_type""",
        (now - RETENTION,),
    ):
        drive = dict(row)
        drive["metrics"] = json.loads(drive["metrics"])
        if row["run_id"] != latest["id"]:
            drive.update(
                health="unknown", reading="offline", temperature=None, metrics={},
                detail="This drive did not report in the latest collection.",
            )
        del drive["run_id"], drive["device_type"]
        result["drives"].append(drive)
    return result


def history(db, drive_id, days, now):
    points = [
        list(row) for row in db.execute(
            """SELECT r.timestamp, s.temperature, s.health, s.reading
               FROM samples s JOIN runs r ON r.id = s.run_id
               WHERE s.drive_id = ? AND r.timestamp >= ?
               ORDER BY r.timestamp, r.id""",
            (drive_id, now - days * DAY),
        )
    ]
    return {"from": now - days * DAY, "to": now, "points": points}


def seed_demo(path):
    prepare_database(path)
    end = int(time.time()) // INTERVAL * INTERVAL
    drives = [
        ("Samsung SSD 980 PRO", "NVMe SSD", "NVMe", "/dev/nvme0", 1_000_204_886_016, 42,
         {"power_on_hours": 4268, "spare_percent": 100, "used_percent": 5, "media_errors": 0}),
        ("WD Red Plus 4TB", "HDD", "ATA", "/dev/sda", 4_000_787_030_016, 36,
         {"power_on_hours": 14921, "reallocated_sectors": 2, "pending_sectors": 2, "uncorrectable_sectors": 0}),
        ("Crucial MX500", "SATA SSD", "ATA", "/dev/sdb", 500_107_862_016, 33,
         {"power_on_hours": 7531, "reallocated_sectors": 0, "pending_sectors": 0, "uncorrectable_sectors": 0}),
    ]
    with closing(database(path)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM runs LIMIT 1").fetchone():
            raise ValueError("Use a new database file for the demo.")
        for i, timestamp in enumerate(range(end - RETENTION + INTERVAL, end + 1, INTERVAL)):
            samples = []
            for j, (model, kind, protocol, device, capacity, base, metrics) in enumerate(drives):
                shift = 4.2 * math.sin(i / 51 + j) + 2.2 * math.sin(i / 17) + 1.4 * math.sin(i / 6.1)
                profile = max(0, math.sin(i / 115 - 0.9 + j)) * 2.2
                temperature = base if timestamp == end else round(base + shift + profile)
                metrics = dict(metrics)
                if j == 1 and timestamp < end - 3 * DAY:
                    metrics["pending_sectors"] = 0
                delayed = j == 1 and end - 4 * DAY - 6 * 3600 < timestamp < end - 4 * DAY
                samples.append({
                    "drive_id": stable_id("demo", device), "path": device, "device_type": "",
                    "model": model, "kind": kind, "protocol": protocol, "capacity": capacity,
                    "temperature": None if delayed else temperature,
                    "reading": "standby" if delayed else "ok", "detail": None,
                    "health": "unknown" if delayed else "warning" if metrics.get("pending_sectors") else "healthy",
                    "metrics": {} if delayed else metrics,
                })
            save_run(db, timestamp, samples, demo=True)


ASSETS = {"/": ("index.html", "text/html"), "/app.css": ("app.css", "text/css"),
          "/app.js": ("app.js", "text/javascript"), "/theme.js": ("theme.js", "text/javascript")}


def handler_for(path, port):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(10)
            super().setup()

        def reply(self, body, content_type, status=200):
            self.send_response(status)
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy",
                             "default-src 'none'; script-src 'self'; style-src 'self'; "
                             "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def send_json(self, payload, status=200):
            self.reply(json.dumps(payload, separators=(",", ":")).encode(), "application/json", status)

        def do_GET(self):
            if self.headers.get("Host", "").lower() not in {
                "localhost", "127.0.0.1", f"localhost:{port}", f"127.0.0.1:{port}",
            }:
                self.send_json({"error": "Use the dashboard's localhost URL."}, 400)
                return
            try:
                request = urlsplit(self.path)
            except ValueError:
                self.send_json({"error": "Invalid request path."}, 400)
                return
            if request.path in ASSETS:
                filename, mime = ASSETS[request.path]
                self.reply((ROOT / "web" / filename).read_bytes(), mime)
                return
            if request.path not in ("/api/dashboard", "/api/history"):
                self.send_json({"error": "Page not found."}, 404)
                return
            now = int(time.time())
            if request.path == "/api/history":
                params = parse_qs(request.query)
                drive_id = params.get("drive", [""])[0]
                window = params.get("days", ["7"])[0]
                if not DRIVE_ID.fullmatch(drive_id) or window not in ("1", "7", "30"):
                    self.send_json({"error": "Invalid drive or history range."}, 400)
                    return
            try:
                if not path.exists():
                    db = sqlite3.connect(":memory:")
                    db.row_factory = sqlite3.Row
                    db.executescript(SCHEMA)
                else:
                    db = database(path, readonly=True)
                with closing(db), db:
                    db.execute("BEGIN")
                    payload = (dashboard(db, now) if request.path == "/api/dashboard"
                               else history(db, drive_id, int(window), now))
            except sqlite3.Error:
                logging.exception("Could not read drive history")
                self.send_json({"error": "Drive history is temporarily unavailable."}, 503)
                return
            self.send_json(payload)

        do_HEAD = do_GET

        def log_message(self, _format, *_args):
            pass

    return Handler


# Limit simultaneous local connections, including clients holding partial requests.
class LocalServer(ThreadingHTTPServer):
    slots = threading.BoundedSemaphore(16)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


def serve(path, port):
    with LocalServer(("127.0.0.1", port), handler_for(path, port)) as server:
        print(f"Diskwatch is available at http://127.0.0.1:{server.server_port}/", flush=True)
        server.serve_forever()


def device_arg(value):
    path, _, device_type = value.partition("=")
    if not path.startswith("/dev/"):
        raise argparse.ArgumentTypeError("Use /dev/DEVICE or /dev/DEVICE=SMARTCTL_TYPE.")
    return path, device_type, ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DEFAULT_DB)
    sub = parser.add_subparsers(dest="action", required=True)
    collector = sub.add_parser("collect", help="read SMART data once")
    collector.add_argument("--smartctl", default="smartctl")
    collector.add_argument("--device", type=device_arg, action="append", default=[],
                           help="explicit device, e.g. /dev/sda=sat; repeat to add others")
    web = sub.add_parser("serve", help="serve the local dashboard")
    web.add_argument("--port", type=int, default=PORT, choices=range(1, 65536), metavar="PORT")
    sub.add_parser("demo", help="seed a separate database with example readings")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    try:
        if args.action == "serve":
            serve(args.database, args.port)
        else:
            if args.action == "demo" and args.database.resolve() == DEFAULT_DB:
                parser.error("Specify a separate demo database with --database.")
            args.database.parent.mkdir(parents=True, exist_ok=True)
            lock_path = args.database.with_suffix(args.database.suffix + ".lock")
            with lock_path.open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if args.action == "collect":
                    collect(args.database, args.smartctl, args.device)
                else:
                    seed_demo(args.database)
    except (OSError, ValueError, sqlite3.Error) as exc:
        parser.exit(1, f"Diskwatch: {exc}\n")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
