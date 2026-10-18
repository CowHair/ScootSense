#!/usr/bin/env python3
"""ScootSense scooter unit: one program for the whole Raspberry Pi.

  * Grove 3-Axis Digital Accelerometer (LIS3DHTR)  -> bumps and potholes
  * Grove Air Quality Sensor v1.3                   -> how polluted the air is (fresh / low / high / severe)
  * USB webcam + YOLO litter model (litter1n)       -> a photo of litter, sent only when litter is confirmed

Location comes from the rider's phone (keep the ScootSense app open on the handlebar), so no GPS
is needed. Everything uses one ID (kept in ~/.scootsense_device, like cam-d3d2), linked once in
the app: Scan tab, Scooter camera, Link.

What it sends to the ScootSense web app (https://scootsense.vercel.app by default)

  POST /api/device/readings   every 2 s while riding, gzip-compressed (about 1.5 MB per hour)
    {"device": "cam-d3d2", "windows": [{"samples": [[t_ms, ax, ay, az], ...]}, ...],
     "gps": null, "pm25": null, "airQuality": {"raw": 212, "level": "low"}}
    Parked (still for 30 s): no motion, just a check-in every 25 s with the air level.
    The server classifies each 0.5 s window (a jolt of 0.8 g or more is a pothole), puts the ride,
    bumps and bad air on the map at the phone's position, and keeps the camera shown as Live.

  POST /api/cam/detection     only when litter is confirmed (seen in 3 of the last 5 frames)
    {"device": "cam-d3d2", "items": ["item"], "confidence": 0.71, "photo": "data:image/jpeg;base64,..."}
    The photo is 480 px wide (about 25-40 KB). Gemini names the litter from it and the rider's
    phone shows it: pick it up, leave it on the map, or not litter.

  POST /api/cam/preview      only while the rider's phone shows the camera live (Ride page, ride on)
    one 320 px JPEG a second (about 10 KB) with green boxes around any litter in view

Privacy
  * Faces are found with OpenCV's YuNet face detector (face_detection_yunet_2023mar.onnx, kept next
    to this program) and blurred in every picture that is sent
    or kept, and a "litter" box on a person is ignored. Photos go only to the rider's own account.

Saving data
  * The live view is sent only while someone is watching it; it stops by itself within 15 s.
  * Photos go only for confirmed litter: at most one every 20 s, and none while the rider still
    has an alert to answer, while the camera is not linked, or while the scooter is parked
    (the camera does not even run then).
  * Motion is batched every 2 s and gzip-compressed; nothing but a small check-in while parked.
  * On the SD card, only photos that were sent are kept (~/captures), the newest 300.
  * Every 5 minutes it prints how much data it has used.

Wiring
  Grove Base Hat for Raspberry Pi (the Pi has no analog inputs of its own), power switch on 3.3V:
    Accelerometer -> any I2C port, Air Quality v1.3 -> A0 (SCOOTSENSE_AIR_PORT for another), webcam -> USB.
  Or jumper wires with an ADS1115 for the air sensor:
    Accelerometer VCC -> pin 1 (3.3V), GND -> pin 6, SDA -> pin 3, SCL -> pin 5
    ADS1115 VDD -> pin 1, GND -> pin 9, SDA -> pin 3, SCL -> pin 5, ADDR -> GND; Air Quality SIG -> ADS1115 A0

Setup (Raspberry Pi OS, Pi 4 or 5)
  sudo raspi-config                        Interface Options -> I2C -> Yes, then reboot
  sudo apt install -y python3-smbus i2c-tools
  ~/venv/bin/pip install ultralytics opencv-python smbus2    (skip what the venv already has)
  ~/venv/bin/python scootsense_unit.py --check     finds the sensors, the camera and the server
  ~/venv/bin/python scootsense_unit.py             runs everything

Testing
  --test        send one check-in and print the reply (no sensors needed)
  --simulate    run with made-up sensors and no camera: a pothole every ~10 s, bad air every ~45 s
  --no-camera   sensors only
  --dry-run     print what would be sent instead of sending

Options (environment variables)
  SCOOTSENSE_SERVER     default https://scootsense.vercel.app
  SCOOTSENSE_MODEL      litter model, default ~/litter1n_ncnn_model (or litter1n.pt)
  SCOOTSENSE_CAMERA     webcam index, default 0
  SCOOTSENSE_AIR_PORT   analog port of the air sensor, default 0 (A0)
  SCOOTSENSE_ADC        auto (default), basehat or ads1115
  SCOOTSENSE_PHOTO_WIDTH  photo width in pixels, default 480 (640 for more detail, more data)
  SCOOTSENSE_VERBOSE    1 prints a line for every upload
  The token, if the server has INGEST_TOKEN set, goes in ~/.scootsense_token (never in GitHub).

Run at boot
  sudo tee /etc/systemd/system/scootsense.service <<'UNIT'
  [Unit]
  Description=ScootSense scooter unit
  After=network-online.target
  Wants=network-online.target
  [Service]
  ExecStart=/home/cowhair/venv/bin/python /home/cowhair/scootsense_unit.py
  WorkingDirectory=/home/cowhair
  Restart=always
  User=cowhair
  [Install]
  WantedBy=multi-user.target
  UNIT
  sudo systemctl enable --now scootsense
  journalctl -u scootsense -f              to watch it
"""
import base64
import contextlib
import gzip
import json
import math
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque

HOME = os.path.expanduser("~")
SERVER = os.environ.get("SCOOTSENSE_SERVER", "https://scootsense.vercel.app").rstrip("/")
ID_FILE = os.path.join(HOME, ".scootsense_device")
TOKEN_FILE = os.path.join(HOME, ".scootsense_token")
CAPTURES = os.path.join(HOME, "captures")
AIR_PORT = int(os.environ.get("SCOOTSENSE_AIR_PORT", "0"))
ADC_KIND = os.environ.get("SCOOTSENSE_ADC", "auto").lower()
I2C_BUS = int(os.environ.get("SCOOTSENSE_I2C_BUS", "1"))
CAMERA = int(os.environ.get("SCOOTSENSE_CAMERA", "0"))
PHOTO_WIDTH = int(os.environ.get("SCOOTSENSE_PHOTO_WIDTH", "480"))

# Motion
SAMPLE_HZ = 50
WINDOW_S = 0.5
SEND_EVERY_S = 2.0          # batch two seconds of motion per request
MAX_WINDOWS_PER_POST = 16   # catch up after a dropped connection
BACKLOG_WINDOWS = 240       # keep 2 minutes while offline
PARKED_S = 30
CHECKIN_S = 10              # parked check-in (tiny; also how fast the live view starts)
STILL_STD_G = 0.015
# Air
AIR_WARMUP_S = int(os.environ.get("SCOOTSENSE_AIR_WARMUP", "60"))
# Camera
CONF = 0.5                  # ignore detector guesses below this
WINDOW_FRAMES, NEED_FRAMES = 5, 3   # litter in 3 of the last 5 frames = confirmed
PHOTO_GAP_S = 20            # at most one photo per this many seconds
MAX_PHOTO_AGE_S = 20        # older events are dropped: the rider has moved on
MAX_PHOTO_BYTES = 60_000
DETECT_EVERY_S = 0.4        # about 2.5 checks per second is plenty at scooter speed
PREVIEW_EVERY_S = float(os.environ.get("SCOOTSENSE_PREVIEW_EVERY", "1.0"))  # live view: one frame a second
PREVIEW_WIDTH = 320         # live view frames are small: about 8-12 KB each, only while the phone watches
BOX_COLOR = (60, 220, 60)   # green (BGR)
KEEP_CAPTURES = 300
VERBOSE = os.environ.get("SCOOTSENSE_VERBOSE", "0") == "1"   # print every upload


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


# ---------------------------------------------------------------- identity

def device_id():
    """The ID already linked in the app (~/.scootsense_device), else cam- plus the end of the MAC address."""
    if os.path.exists(ID_FILE):
        saved = open(ID_FILE).read().strip().lower()
        if re.fullmatch(r"[a-z0-9-]{3,40}", saved):
            return saved
    mac = None
    for iface in ("wlan0", "eth0"):
        try:
            mac = open(f"/sys/class/net/{iface}/address").read().strip()
            break
        except OSError:
            pass
    device = "cam-" + ("".join(mac.split(":")[-2:]) if mac else f"{uuid.getnode() & 0xFFFF:04x}")
    try:
        with open(ID_FILE, "w") as f:
            f.write(device)
    except OSError:
        pass
    return device


# ---------------------------------------------------------------- talking to the server

class Link:
    """Sends JSON to the server, gzip-compressed when large, and counts the bytes."""

    def __init__(self, dry_run=False):
        self.dry_run = dry_run
        self.headers = {"Content-Type": "application/json"}
        if os.path.exists(TOKEN_FILE):
            self.headers["x-scootsense-token"] = open(TOKEN_FILE).read().strip()
        self.gzip_ok = True
        self.sent_bytes = 0
        self.photos = 0
        self.lock = threading.Lock()

    def post_jpeg(self, path, jpg):
        """Sends one JPEG as the body. Returns (status, reply dict). Raises OSError on network trouble."""
        if self.dry_run:
            with self.lock:
                self.sent_bytes += len(jpg)
            return 200, {"paired": True, "watch": True}
        headers = {k: v for k, v in self.headers.items() if k != "Content-Type"}
        headers["Content-Type"] = "image/jpeg"
        req = urllib.request.Request(SERVER + path, data=jpg, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=8) as res:
                status, reply = res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as e:
            status, reply = e.code, {}
        with self.lock:
            self.sent_bytes += len(jpg)
        return status, reply

    def post(self, path, payload):
        """Returns (status, reply dict). Raises OSError on network trouble."""
        body = json.dumps(payload, separators=(",", ":")).encode()
        headers = dict(self.headers)
        if self.gzip_ok and len(body) > 1500:
            body, headers["Content-Encoding"] = gzip.compress(body, 6), "gzip"
        if self.dry_run:
            with self.lock:
                self.sent_bytes += len(body)
            return 200, {"paired": True, "dryRun": True}
        req = urllib.request.Request(SERVER + path, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=12) as res:
                reply = json.loads(res.read() or b"{}")
                status = res.status
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                reply = json.loads(e.read() or b"{}")
            except ValueError:
                reply = {}
            if headers.get("Content-Encoding") and status in (400, 415):
                self.gzip_ok = False      # this server does not take gzip: send plain from now on
                log("  server does not accept gzip; sending uncompressed")
                return self.post(path, payload)
        with self.lock:
            self.sent_bytes += len(body)
        return status, reply


# ---------------------------------------------------------------- sensors: accelerometer

def open_bus(number):
    try:
        from smbus2 import SMBus
    except ImportError:
        try:
            from smbus import SMBus
        except ImportError:
            raise RuntimeError("no I2C library: sudo apt install -y python3-smbus (or pip install smbus2)")
    try:
        return LockedBus(SMBus(number))
    except (FileNotFoundError, PermissionError) as e:
        raise RuntimeError(f"cannot open I2C bus {number} ({e}); turn on I2C in raspi-config")


class LockedBus:
    """One I2C transaction at a time. The motion and air threads share the bus, and each smbus call
    is "choose the device" then "transfer": without this lock one thread's transfer can go to the
    other thread's device, and the Base Hat's ADC can then hold the bus until it is power-cycled.
    A failed transfer is retried twice after a short pause."""

    def __init__(self, bus):
        self._bus = bus
        self._lock = threading.RLock()     # re-entrant: transaction() wraps several locked calls

    def __getattr__(self, name):
        fn = getattr(self._bus, name)
        if not callable(fn):
            return fn

        def locked(*args, **kwargs):
            for attempt in range(3):
                with self._lock:
                    try:
                        return fn(*args, **kwargs)
                    except OSError:
                        if attempt == 2:
                            raise
                time.sleep(0.005 * (attempt + 1))
        return locked

    def transaction(self):
        """Hold the bus for several calls that must not be split (write register, then read it)."""
        return self._lock


class LIS3DH:
    """Grove 3-Axis Digital Accelerometer (LIS3DHTR), read directly over I2C."""
    name = "Grove LIS3DHTR accelerometer"

    def __init__(self, bus):
        self.bus, self.addr = bus, None
        for a in (0x19, 0x18):
            try:
                if bus.read_byte_data(a, 0x0F) == 0x33:   # WHO_AM_I
                    self.addr = a
                    break
            except OSError:
                pass
        if self.addr is None:
            raise RuntimeError("LIS3DHTR not found at 0x19 or 0x18 (check i2cdetect -y 1)")
        bus.write_byte_data(self.addr, 0x20, 0x57)   # 100 Hz, X/Y/Z on
        bus.write_byte_data(self.addr, 0x23, 0x98)   # block update, +/-4 g, high resolution
        self.name += f" (0x{self.addr:02x})"

    def read_g(self):
        d = self.bus.read_i2c_block_data(self.addr, 0x28 | 0x80, 6)
        out = []
        for i in range(0, 6, 2):
            v = d[i] | (d[i + 1] << 8)
            if v & 0x8000:
                v -= 0x10000
            out.append((v >> 4) * 0.002)
        return tuple(out)


# ---------------------------------------------------------------- sensors: air quality

class BaseHatADC:
    """The ADC on the Grove Base Hat (0x04, or 0x08 on newer hats)."""

    def __init__(self, bus, port):
        self.bus, self.port, self.addr = bus, port, None
        for a in (0x04, 0x08):
            try:
                self._reg(a, 0x00)
                self.addr = a
                break
            except OSError:
                pass
        if self.addr is None:
            raise RuntimeError("Grove Base Hat not found at 0x04 or 0x08")
        self.name = f"Grove Base Hat (0x{self.addr:02x}) port A{port}"

    def _reg(self, addr, reg):
        # Seeed's grove.py sequence, kept together so no other transfer can come in between.
        with (self.bus.transaction() if hasattr(self.bus, 'transaction') else contextlib.nullcontext()):
            self.bus.write_byte(addr, reg)
            return self.bus.read_word_data(addr, reg)

    def millivolts(self):
        return self._reg(self.addr, 0x20 + self.port)


class ADS1115:
    def __init__(self, bus, port):
        if not 0 <= port <= 3:
            raise RuntimeError("ADS1115 has inputs A0-A3")
        self.bus, self.port, self.addr = bus, port, 0x48
        self.bus.read_i2c_block_data(self.addr, 0x01, 2)
        self.name = f"ADS1115 (0x48) input A{port}"

    def millivolts(self):
        config = 0x8000 | ((0x4 + self.port) << 12) | (0x1 << 9) | 0x0100 | (0x4 << 5) | 0x0003
        self.bus.write_i2c_block_data(self.addr, 0x01, [config >> 8, config & 0xFF])
        time.sleep(0.009)
        hi, lo = self.bus.read_i2c_block_data(self.addr, 0x00, 2)
        v = (hi << 8) | lo
        if v & 0x8000:
            v -= 0x10000
        return max(0, v) * 4096 / 32768


def open_adc(bus):
    errors = []
    for kind, cls in (("basehat", BaseHatADC), ("ads1115", ADS1115)):
        if ADC_KIND in ("auto", kind):
            try:
                return cls(bus, AIR_PORT)
            except (OSError, RuntimeError) as e:
                errors.append(f"{kind}: {e}")
    raise RuntimeError("no analog input for the air sensor (" + "; ".join(errors) + ")")


class AirQuality(threading.Thread):
    """Grove Air Quality v1.3, read once a second with the same rules as Seeed's library:
    the value on a 0-1023 scale (3.3 V = 1023), its jump since the last second, and how far it is
    above its slow-moving average."""

    def __init__(self, adc):
        super().__init__(daemon=True)
        self.adc = adc
        self.started = time.monotonic()
        self.raw = self.level = None
        self._avg = self._last = None

    def update(self):
        mv = sum(self.adc.millivolts() for _ in range(8)) / 8
        v = max(0, min(1023, round(mv / 3300 * 1023)))
        if time.monotonic() - self.started < AIR_WARMUP_S:
            self._avg = self._last = v
            return
        jump = 0 if self._last is None else v - self._last
        self._last = v
        self._avg = v if self._avg is None else self._avg * 0.98 + v * 0.02
        rise = v - self._avg
        self.raw = v
        if v > 700:
            self.level = "severe"
        elif (jump > 400 and v > 400) or v > 400 or rise > 150:
            self.level = "high"
        elif (jump > 200 and v > 200) or v > 200 or rise > 50:
            self.level = "low"
        else:
            self.level = "fresh"

    def reading(self):
        return {"raw": self.raw, "level": self.level} if self.level else None

    def run(self):
        while True:
            try:
                self.update()
            except OSError:
                pass
            time.sleep(1)


# ---------------------------------------------------------------- made-up sensors (--simulate)

class FakeAccel:
    name = "simulated accelerometer"

    def __init__(self):
        self.t0 = time.monotonic()

    def read_g(self):
        t = time.monotonic() - self.t0
        if t % 120 > 80:
            n = 0.002
            return (random.gauss(0, n), random.gauss(0, n), 1 + random.gauss(0, n))
        n = 0.05
        ax, ay, az = random.gauss(0, n), random.gauss(0, n), 1 + random.gauss(0, n)
        if t % 10 < 0.06:
            az += random.choice((-1, 1)) * random.uniform(1.0, 1.6)
        return (ax, ay, az)


class FakeADC:
    name = "simulated air sensor"

    def __init__(self):
        self.t0 = time.monotonic()

    def millivolts(self):
        t = time.monotonic() - self.t0
        return 380 + 40 * math.sin(t / 30) + (1400 if t % 45 > 35 else 0) + random.gauss(0, 10)


# ---------------------------------------------------------------- motion sampling

class Motion(threading.Thread):
    """50 Hz accelerometer readings cut into 0.5 s windows; knows whether the scooter is parked."""

    def __init__(self, accel):
        super().__init__(daemon=True)
        self.accel = accel
        self.windows = deque(maxlen=BACKLOG_WINDOWS)
        self.lock = threading.Lock()
        self.moving_at = time.monotonic()

    def parked(self):
        return time.monotonic() - self.moving_at >= PARKED_S

    def take(self, n):
        with self.lock:
            return [self.windows[i] for i in range(min(n, len(self.windows)))]

    def drop(self, n):
        with self.lock:
            for _ in range(min(n, len(self.windows))):
                self.windows.popleft()

    def run(self):
        period = 1 / SAMPLE_HZ
        t0 = next_at = time.monotonic()
        window = []
        while True:
            now = time.monotonic()
            if now < next_at:
                time.sleep(next_at - now)
            next_at += period
            if time.monotonic() - next_at > 1:
                next_at = time.monotonic() + period
            try:
                ax, ay, az = self.accel.read_g()
            except OSError:
                continue
            t_ms = int((time.monotonic() - t0) * 1000)
            window.append([t_ms, round(ax, 3), round(ay, 3), round(az, 3)])
            if t_ms - window[0][0] >= WINDOW_S * 1000 and len(window) >= 8:
                mags = [math.sqrt(s[1] ** 2 + s[2] ** 2 + s[3] ** 2) for s in window]
                mean = sum(mags) / len(mags)
                if math.sqrt(sum((m - mean) ** 2 for m in mags) / len(mags)) > STILL_STD_G:
                    self.moving_at = time.monotonic()
                if not self.parked():
                    with self.lock:
                        self.windows.append(window)
                window = []


# ---------------------------------------------------------------- litter camera

def encode_photo(frame):
    """A small JPEG data URL: PHOTO_WIDTH wide, quality stepped down until it is under MAX_PHOTO_BYTES."""
    import cv2
    h, w = frame.shape[:2]
    for width in (PHOTO_WIDTH, 400, 320):
        small = frame if w <= width else cv2.resize(frame, (width, round(h * width / w)), interpolation=cv2.INTER_AREA)
        for quality in (65, 55, 45):
            ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, quality])
            if ok and len(buf) <= MAX_PHOTO_BYTES:
                return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode(), buf.tobytes()
    return None, None


def litter_boxes(result):
    """Detector boxes as [x1, y1, x2, y2, confidence] in pixels, most confident first."""
    try:
        xyxy = result.boxes.xyxy.tolist()
        conf = result.boxes.conf.tolist()
    except AttributeError:
        return []
    return sorted(([*b, c] for b, c in zip(xyxy, conf)), key=lambda b: -b[4])


_face_finder = None
FACE_MODEL = "face_detection_yunet_2023mar.onnx"   # YuNet (MIT licence, OpenCV model zoo), about 230 KB


def find_faces(frame):
    """Faces in the frame as [x1, y1, x2, y2], with OpenCV's YuNet face detector.
    Returns [] (and says so once) if the model file is missing."""
    global _face_finder
    import cv2
    if _face_finder is None:
        path = next((p for p in (os.path.join(os.path.dirname(os.path.abspath(__file__)), FACE_MODEL), os.path.join(HOME, FACE_MODEL))
                     if os.path.exists(p)), None)
        if not path:
            log(f"privacy: {FACE_MODEL} not found next to this program, so faces are NOT blurred")
            _face_finder = False
        else:
            _face_finder = cv2.FaceDetectorYN.create(path, "", (320, 320), 0.6, 0.3, 50)
    if not _face_finder:
        return []
    h, w = frame.shape[:2]
    k = 320 / w
    small = cv2.resize(frame, (320, round(h * k)))
    _face_finder.setInputSize((small.shape[1], small.shape[0]))
    _, found = _face_finder.detect(small)
    if found is None:
        return []
    return [[x / k, y / k, (x + fw) / k, (y + fh) / k] for x, y, fw, fh in (f[:4] for f in found)]


def blur_faces(img, faces, scale=1.0):
    """People are never sent: each face (and a margin around it) is blurred out, on a copy."""
    import cv2
    out = img.copy()
    H, W = out.shape[:2]
    for x1, y1, x2, y2 in faces:
        mx, my = (x2 - x1) * 0.35, (y2 - y1) * 0.5
        a, b = max(0, round((x1 - mx) * scale)), max(0, round((y1 - my) * scale))
        c, d = min(W, round((x2 + mx) * scale)), min(H, round((y2 + my) * scale))
        if c > a and d > b:
            out[b:d, a:c] = cv2.GaussianBlur(out[b:d, a:c], (0, 0), max(4, (c - a) / 6))
    return out


def not_on_people(boxes, faces):
    """Drops litter boxes whose centre is on or just below a face (a person, not litter)."""
    keep = []
    for x1, y1, x2, y2, c in boxes:
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        on_person = any(fx1 - (fx2 - fx1) <= cx <= fx2 + (fx2 - fx1) and fy1 - (fy2 - fy1) <= cy <= fy2 + 3 * (fy2 - fy1)
                        for fx1, fy1, fx2, fy2 in faces)
        if not on_person:
            keep.append([x1, y1, x2, y2, c])
    return keep


def draw_boxes(img, boxes, scale=1.0):
    """Green boxes with the confidence, drawn on a copy."""
    import cv2
    out = img.copy()
    t = max(2, round(out.shape[1] / 220))
    for x1, y1, x2, y2, c in boxes:
        p1, p2 = (round(x1 * scale), round(y1 * scale)), (round(x2 * scale), round(y2 * scale))
        cv2.rectangle(out, p1, p2, BOX_COLOR, t)
        label = f"litter {c:.0%}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45 * t / 2, 1)
        y = max(th + 4, p1[1])
        cv2.rectangle(out, (p1[0], y - th - 4), (p1[0] + tw + 6, y), BOX_COLOR, -1)
        cv2.putText(out, label, (p1[0] + 3, y - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45 * t / 2, (0, 0, 0), 1, cv2.LINE_AA)
    return out


class Preview(threading.Thread):
    """Sends the newest live-view frame about once a second, only while the phone is watching."""

    def __init__(self, unit):
        super().__init__(daemon=True)
        self.unit = unit
        self.latest = None
        self.cond = threading.Condition()

    def offer(self, frame, boxes, faces=()):
        import cv2
        h, w = frame.shape[:2]
        k = PREVIEW_WIDTH / w
        small = cv2.resize(frame, (PREVIEW_WIDTH, round(h * k)), interpolation=cv2.INTER_AREA)
        if faces:
            small = blur_faces(small, faces, k)
        if boxes:
            small = draw_boxes(small, boxes, k)
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 55])
        if ok:
            with self.cond:
                self.latest = buf.tobytes()
                self.cond.notify()

    def run(self):
        while True:
            with self.cond:
                while self.latest is None:
                    self.cond.wait()
                jpg, self.latest = self.latest, None
            try:
                status, reply = self.unit.link.post_jpeg(f"/api/cam/preview?device={self.unit.device}", jpg)
                if status == 200:
                    self.unit.set_watch(bool(reply.get("watch")))
            except (urllib.error.URLError, TimeoutError, OSError):
                pass


def prune_captures():
    try:
        files = sorted((os.path.join(CAPTURES, f) for f in os.listdir(CAPTURES)), key=os.path.getmtime)
        for f in files[:-KEEP_CAPTURES]:
            os.remove(f)
    except OSError:
        pass


class Camera(threading.Thread):
    """Runs the litter model while the scooter moves; hands over a photo when litter is confirmed."""

    def __init__(self, unit, model_path):
        super().__init__(daemon=True)
        import cv2
        from ultralytics import YOLO
        self.cv2 = cv2
        self.unit = unit
        self.model = YOLO(model_path, task="detect")
        self.cam = cv2.VideoCapture(CAMERA)
        self.cam.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        self.cam.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        self.cam.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        self.cam.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not self.cam.isOpened():
            raise RuntimeError(f"could not open webcam {CAMERA} (ls /dev/video*)")
        self.name = f"webcam {CAMERA} with {os.path.basename(model_path.rstrip('/'))}"
        self.history = deque(maxlen=WINDOW_FRAMES)
        self.best = 0.0
        self.frames = 0
        self.paused_reason = "starting"   # so the first state is always printed

    def why_paused(self):
        u = self.unit
        if u.motion and u.motion.parked():
            return "parked"
        if u.paired is False:
            return "camera not linked"
        if u.cam_busy:
            return "waiting for the rider to answer the last alert"
        if time.time() - u.last_photo_at < PHOTO_GAP_S:
            return "just sent a photo"
        return None

    def run(self):
        last_preview = 0.0
        while True:
            reason = self.why_paused()
            if reason != self.paused_reason:
                log(f"camera: {'paused (' + reason + ')' if reason else 'watching for litter'}")
                self.paused_reason = reason
            watching = self.unit.watch
            if reason:
                self.history.clear()
                self.best = 0.0
                if not watching:
                    time.sleep(1)
                    continue
            started = time.monotonic()
            for _ in range(2):
                self.cam.grab()                      # skip stale buffered frames
            ok, frame = self.cam.read()
            if not ok:
                log("camera: no frame, retrying")
                time.sleep(1)
                continue
            boxes = []
            # The model runs while looking for litter, and for the live view so it can show boxes.
            result = self.model(frame, imgsz=640, conf=CONF, verbose=False)[0]
            faces = find_faces(frame)
            boxes = not_on_people(litter_boxes(result), faces)   # people are not litter
            if watching and time.monotonic() - last_preview >= PREVIEW_EVERY_S:
                last_preview = time.monotonic()
                self.unit.preview.offer(frame, boxes, faces)
            if reason:
                time.sleep(max(0.0, PREVIEW_EVERY_S - (time.monotonic() - started)))
                continue
            confs = [b[4] for b in boxes]
            self.history.append(bool(confs))
            self.best = max([self.best] + confs)
            self.frames += 1
            if sum(self.history) >= NEED_FRAMES:
                self.unit.offer_photo(frame, self.best, result, boxes, faces)
                self.history.clear()
                self.best = 0.0
            elif not any(self.history):
                self.best = 0.0
            time.sleep(max(0.0, DETECT_EVERY_S - (time.monotonic() - started)))


# ---------------------------------------------------------------- the unit

class Unit:
    def __init__(self, device, link, accel=None, air=None):
        self.device, self.link = device, link
        self.motion = Motion(accel) if accel else None
        self.air = air
        self.paired = None
        self.cam_busy = False
        self.watch = False                # the rider's phone shows the camera live
        self.preview = Preview(self)
        self.last_photo_at = 0.0
        self.photo = None                 # (made_at, payload) waiting to be sent
        self.photo_lock = threading.Lock()
        self.last_note = 0.0

    # The camera thread calls this; the sending loop does the upload.
    def set_watch(self, on):
        if on != self.watch:
            log("live view: phone is watching, sending preview frames" if on else "live view: nobody watching, preview stopped")
        self.watch = on

    def offer_photo(self, frame, confidence, result=None, boxes=None, faces=()):
        boxes = boxes or []
        clean = blur_faces(frame, faces) if faces else frame
        url, jpg = encode_photo(draw_boxes(clean, boxes) if boxes else clean)
        if not url:
            return
        self.last_photo_at = time.time()
        h, w = frame.shape[:2]
        rel = [[round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4), round(c, 2)] for x1, y1, x2, y2, c in boxes[:5]]
        with self.photo_lock:
            self.photo = (time.time(), {"device": self.device, "items": ["item"], "boxes": rel,
                                        "confidence": round(float(confidence), 2), "photo": url})
        os.makedirs(CAPTURES, exist_ok=True)
        name = time.strftime("%Y%m%d_%H%M%S")
        try:
            with open(os.path.join(CAPTURES, name + ".jpg"), "wb") as f:
                f.write(jpg)
            if result is not None:
                import cv2
                small = cv2.resize(draw_boxes(clean, boxes), (480, round(frame.shape[0] * 480 / frame.shape[1])))
                cv2.imwrite(os.path.join(CAPTURES, name + "_boxes.jpg"), small, [cv2.IMWRITE_JPEG_QUALITY, 60])
        except OSError:
            pass
        prune_captures()
        log(f"litter confirmed ({confidence:.0%}), photo {len(jpg) // 1024} KB queued")

    def _readings(self, windows):
        return {"device": self.device, "gps": None, "pm25": None,
                "airQuality": self.air.reading() if self.air else None,
                "windows": [{"samples": w} for w in windows]}

    def _note_reply(self, reply):
        if "paired" in reply:
            if reply["paired"] != self.paired:
                log("linked to a rider" if reply["paired"] else
                    f"not linked yet: in the app open Scan, Scooter camera, Link, and enter {self.device}")
            self.paired = bool(reply["paired"])
        if "watch" in reply:
            self.set_watch(bool(reply["watch"]))
        if "camBusy" in reply:
            self.cam_busy = bool(reply["camBusy"])

    def _send_photo(self):
        with self.photo_lock:
            item, self.photo = self.photo, None
        if not item:
            return
        made_at, payload = item
        if self.paired is False:
            log("photo not sent: the camera is not linked in the app yet")
            return
        if self.cam_busy:
            log("photo not sent: the rider has not answered the last litter alert (saves data)")
            return
        if time.time() - made_at > MAX_PHOTO_AGE_S:
            log("photo dropped: too old to place on the map")
            return
        try:
            status, reply = self.link.post("/api/cam/detection", payload)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            log(f"photo upload failed ({getattr(e, 'reason', e)}); trying again")
            with self.photo_lock:
                if self.photo is None:
                    self.photo = item     # put it back; it is dropped once it is too old
            return
        self.link.photos += 1
        if status != 200:
            log(f"photo: server said {status}: {reply.get('error', '')}")
            return
        self._note_reply(reply)
        if reply.get("trash"):
            log(f"photo sent: {reply.get('summary')} ({reply.get('namedBy', 'camera')})")
            self.cam_busy = True          # the rider now has an alert to answer
        elif reply.get("skipped"):
            log("photo skipped by the server: the rider has not answered the last alert")
            self.cam_busy = True

    def run(self):
        if self.motion:
            self.motion.start()
        if self.air:
            self.air.start()
        self.preview.start()
        last_post = 0.0
        last_report = time.monotonic()
        failures = 0
        next_at = time.monotonic()
        while True:
            next_at += 1.0
            time.sleep(max(0.0, next_at - time.monotonic()))
            if time.monotonic() - next_at > 5:
                next_at = time.monotonic()
            try:
                if self.photo:
                    self._send_photo()
                parked = not self.motion or self.motion.parked()
                due = SEND_EVERY_S if not parked or self.watch else CHECKIN_S
                if time.monotonic() - last_post < due:
                    continue
                windows = [] if parked else self.motion.take(MAX_WINDOWS_PER_POST)
                status, reply = self.link.post("/api/device/readings", self._readings(windows))
                if failures:
                    log(f"back online after {failures} failed tries")
                failures = 0
                last_post = time.monotonic()
                if status != 200:
                    log(f"readings: server said {status}: {reply.get('error', '')}")
                    if 400 <= status < 500 and status != 429 and self.motion:
                        self.motion.drop(len(windows))
                    continue
                if self.motion:
                    self.motion.drop(len(windows))
                self._note_reply(reply)
                if VERBOSE:
                    a = self.air.reading() if self.air else None
                    peak = max((abs(math.sqrt(s[1] ** 2 + s[2] ** 2 + s[3] ** 2) - 1) for w in windows for s in w), default=0)
                    log(f"sent: {'moving, ' + str(len(windows)) + ' windows, peak jolt ' + format(peak, '.2f') + ' g' if windows else 'parked check-in'}"
                        f", air {a['level'] + ' (' + str(a['raw']) + ')' if a else 'warming up'}"
                        f" -> {reply.get('bumps', 0)} bumps{', camera busy' if reply.get('camBusy') else ''}")
                if reply.get("hazards"):
                    log(f"bump mapped: {', '.join(reply['hazards'])}")
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                failures += 1
                if failures in (1, 5) or failures % 30 == 0:
                    kept = len(self.motion.windows) if self.motion else 0
                    log(f"no connection ({getattr(e, 'reason', e)}); keeping {kept} windows")
            if time.monotonic() - last_report >= 300:
                last_report = time.monotonic()
                a = self.air.reading() if self.air else None
                log(f"data used so far: {self.link.sent_bytes / 1e6:.2f} MB, {self.link.photos} photos"
                    f"{', air ' + a['level'] if a else ''}")


# ---------------------------------------------------------------- commands

def find_model():
    path = os.environ.get("SCOOTSENSE_MODEL")
    if path:
        return path
    for p in ("litter1n_ncnn_model", "litter1n.pt"):
        for base in (os.getcwd(), HOME):
            if os.path.exists(os.path.join(base, p)):
                return os.path.join(base, p)
    return None


def open_hardware(want_camera=True, tries=6):
    """Find the sensors, trying for up to ~15 s: the Base Hat can be slow to answer after power-up."""
    for attempt in range(tries):
        accel, air, notes = _open_hardware()
        if accel and air:
            break
        if attempt < tries - 1:
            time.sleep(3)
    for note in notes:
        print(note)
    return accel, air


def _open_hardware():
    accel = air = None
    notes = []
    try:
        bus = open_bus(I2C_BUS)
        try:
            accel = LIS3DH(bus)
            notes.append(f"  accelerometer: {accel.name}")
        except (OSError, RuntimeError) as e:
            notes.append(f"  accelerometer: {e}")
        try:
            adc = open_adc(bus)
            air = AirQuality(adc)
            notes.append(f"  air sensor:    Grove Air Quality v1.3 on {adc.name}")
        except (OSError, RuntimeError) as e:
            notes.append(f"  air sensor:    {e}")
    except RuntimeError as e:
        notes.append(f"  I2C: {e}")
    return accel, air, notes


def check(device):
    print(f"ScootSense unit {device}, server {SERVER}")
    accel, air = open_hardware(False)
    if accel:
        for _ in range(5):
            ax, ay, az = accel.read_g()
            print(f"    x {ax:+.3f}  y {ay:+.3f}  z {az:+.3f}  |a| {math.sqrt(ax*ax + ay*ay + az*az):.3f} g")
            time.sleep(0.2)
    if air:
        mv = air.adc.millivolts()
        print(f"    air: {mv:.0f} mV -> {round(mv / 3300 * 1023)} of 1023 (under ~200 is clean once warmed up)")
    model = find_model()
    print(f"  litter model:  {model or 'not found (set SCOOTSENSE_MODEL)'}")
    try:
        import cv2
        cam = cv2.VideoCapture(CAMERA)
        ok, frame = cam.read()
        cam.release()
        print(f"  webcam:        {'ok, ' + str(frame.shape[1]) + 'x' + str(frame.shape[0]) if ok else 'no picture from camera ' + str(CAMERA)}")
    except ImportError:
        print("  webcam:        OpenCV missing (run with ~/venv/bin/python)")
    test(device, Link())


def test(device, link):
    try:
        status, reply = link.post("/api/device/readings", {"device": device, "gps": None, "pm25": None, "airQuality": None, "windows": []})
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  server:        NO CONNECTION to {SERVER} ({getattr(e, 'reason', e)})")
        return
    print(f"  server:        {status} {json.dumps(reply)}")
    if status == 200 and not reply.get("paired"):
        print(f"  -> link {device} in the app: Scan tab, Scooter camera, Link")


def main():
    args = set(sys.argv[1:])
    device = device_id()
    if "--help" in args or "-h" in args:
        print(__doc__)
        return
    if "--check" in args:
        return check(device)
    link = Link(dry_run="--dry-run" in args)
    if "--test" in args:
        print(f"ScootSense unit {device}, server {SERVER}")
        return test(device, link)
    print(f"ScootSense unit {device}  (linked in the app under Scan, Scooter camera)")
    print(f"Server: {SERVER}")
    if "--simulate" in args:
        accel, air = FakeAccel(), AirQuality(FakeADC())
        print("  simulated sensors: a pothole every ~10 s, bad air every ~45 s, parked 40 s of every 2 min")
    else:
        accel, air = open_hardware(True)
    if not accel:
        print("  no accelerometer: sending air and photos only")
    unit = Unit(device, link, accel, air)
    if "--simulate" not in args and "--no-camera" not in args:
        model = find_model()
        try:
            if not model:
                raise RuntimeError("litter model not found (set SCOOTSENSE_MODEL)")
            cam = Camera(unit, model)
            print(f"  camera:        {cam.name}")
            cam.start()
        except (ImportError, RuntimeError) as e:
            print(f"  camera:        off ({e})")
    if air:
        print(f"  air sensor warming up for {AIR_WARMUP_S} s")
    try:
        unit.run()
    except KeyboardInterrupt:
        print(f"\nStopped. Data used: {link.sent_bytes / 1e6:.2f} MB, {link.photos} photos.")


if __name__ == "__main__":
    main()
