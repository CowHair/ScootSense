#!/usr/bin/env python3
"""ScootSense scooter unit for a Raspberry Pi.

One program for everything on the scooter:
  * MPU6050 motion sensor  -> bumps and potholes (0.5 s windows of 50 Hz samples)
  * GPS module (NMEA)      -> where and how fast
  * PMS5003 air sensor     -> PM2.5, how clean the air is
  * USB webcam (optional)  -> litter, detected on the Pi; only the kind of trash is sent

Every second it sends JSON to the ScootSense web app:

    POST {SERVER}/api/device/readings
    {"device": "cam-7f3a",
     "windows": [{"samples": [[t_ms, ax_g, ay_g, az_g, gx_dps, gy_dps, gz_dps], ...]}, ...],
     "gps": {"lat": 43.7841, "lng": -79.187, "speed": 14.2},     # null without a fix
     "pm25": 12}                                                  # null without the sensor

and litter, when the camera sees it:

    POST {SERVER}/api/cam/detection
    {"device": "cam-7f3a", "items": ["bottle", "cup"], "lat": 43.7841, "lng": -79.187}

The web app classifies each window (smooth, crack, rough, pothole), builds the ride, maps hazards,
and your phone shows it live: your chibi rides, jolts over bumps and coughs in bad air.
Readings are kept while offline and sent when the connection is back. When the scooter is parked
(no movement for 30 s) it stops sending motion and only says it is still there.

Wiring (Raspberry Pi 4/5, 40-pin header)
  MPU6050   VCC -> pin 1 (3.3V)   GND -> pin 6   SDA -> pin 3 (GPIO2)   SCL -> pin 5 (GPIO3)
  GPS       USB (e.g. u-blox USB) -> any USB port, or TX -> pin 10 (GPIO15 RXD) if the PMS5003 uses USB
  PMS5003   VCC -> pin 2 (5V)     GND -> pin 14   TX -> pin 10 (GPIO15 RXD)   (or a USB serial adapter)
  Webcam    any USB port
  The program finds which serial port is the GPS and which is the air sensor by itself.

Setup (Raspberry Pi OS Bookworm 64-bit)
  sudo raspi-config        Interface Options: I2C -> Yes; Serial Port: login shell -> No, hardware -> Yes
  sudo apt install -y python3-smbus python3-serial python3-opencv
  python3 -m venv --system-site-packages ~/scootsense
  ~/scootsense/bin/pip install ultralytics          (only for the litter camera)
  ~/scootsense/bin/python scootsense_pi.py --check   lists the sensors it found
  ~/scootsense/bin/python scootsense_pi.py           runs; the first line is the unit ID (like cam-7f3a).
  In the app: sign in, Litter camera tab, type that ID under Link. It is the same ID for the camera
  and the sensors.

Options (environment variables)
  SCOOTSENSE_SERVER    default https://scootsense.vercel.app
  SCOOTSENSE_DEVICE    override the unit ID
  SCOOTSENSE_TOKEN     only if the server has INGEST_TOKEN set
  SCOOTSENSE_GPS_PORT  / SCOOTSENSE_AIR_PORT   e.g. /dev/ttyACM0, /dev/serial0 (default: found automatically)
  SCOOTSENSE_CAMERA    webcam index (default 0), or "off"
  SCOOTSENSE_MODEL     litter detector weights (default yolo11n.pt)

Connection check without sensors
  python3 scootsense_pi.py --selftest   sends a few seconds of made-up readings once, to check the
                                         unit is linked and the server answers. Not for riding.
"""
import collections
import glob
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

SERVER = os.environ.get("SCOOTSENSE_SERVER", "https://scootsense.vercel.app").rstrip("/")
TOKEN = os.environ.get("SCOOTSENSE_TOKEN", "")
RATE_HZ = 50
WINDOW_MS = 500
SEND_EVERY = 1.0
PARKED_AFTER = 30          # seconds without movement before motion stops being sent
STILL_STD_G = 0.015        # vibration below this (g) counts as not moving
HEARTBEAT = 15             # seconds between "still here" messages while parked
BACKLOG = 600              # windows kept while offline (5 minutes)


def unit_id():
    custom = os.environ.get("SCOOTSENSE_DEVICE", "").strip().lower()
    if custom:
        return custom
    mac = uuid.getnode()
    return f"cam-{(mac >> 8) & 0xFF:02x}{mac & 0xFF:02x}"


DEVICE = unit_id()


class State:
    """What the sensor threads know right now."""
    def __init__(self):
        self.lock = threading.Lock()
        self.fix = None            # {"lat", "lng", "speed", "at"}
        self.pm25 = None           # (value, at)
        self.windows = collections.deque(maxlen=BACKLOG)
        self.moving_at = time.time()
        self.found = {"imu": False, "gps": None, "air": None, "camera": False}

    def gps(self):
        with self.lock:
            f = self.fix
        if f and time.time() - f["at"] < 5:
            return {"lat": round(f["lat"], 6), "lng": round(f["lng"], 6), "speed": round(f["speed"], 1) if f["speed"] is not None else None}
        return None

    def air(self):
        with self.lock:
            p = self.pm25
        return p[0] if p and time.time() - p[1] < 10 else None


S = State()


def post(path, payload):
    req = urllib.request.Request(f"{SERVER}{path}", data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **({"x-scootsense-token": TOKEN} if TOKEN else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


# ---------------------------------------------------------------- MPU6050 (I2C)

def open_i2c(bus_no=1):
    try:
        from smbus2 import SMBus  # pip install smbus2
    except ImportError:
        from smbus import SMBus   # sudo apt install python3-smbus
    return SMBus(bus_no)


def imu_loop():
    bus, addr = open_i2c(int(os.environ.get("SCOOTSENSE_I2C_BUS", "1"))), None
    for a in (0x68, 0x69):
        try:
            bus.write_byte_data(a, 0x6B, 0x00)   # wake up
            addr = a
            break
        except OSError:
            continue
    if addr is None:
        print("MPU6050 not found on I2C (check wiring and that I2C is enabled in raspi-config)")
        return
    bus.write_byte_data(addr, 0x1C, 0x00)        # accelerometer +-2 g
    bus.write_byte_data(addr, 0x1B, 0x00)        # gyro +-250 deg/s
    bus.write_byte_data(addr, 0x1A, 0x03)        # low-pass filter ~44 Hz
    S.found["imu"] = True

    def s16(hi, lo):
        v = (hi << 8) | lo
        return v - 65536 if v > 32767 else v

    t0 = time.monotonic()
    nxt = t0
    win = []
    while True:
        try:
            d = bus.read_i2c_block_data(addr, 0x3B, 14)
        except OSError:
            time.sleep(0.05)
            continue
        t = int((time.monotonic() - t0) * 1000)
        ax, ay, az = s16(d[0], d[1]) / 16384, s16(d[2], d[3]) / 16384, s16(d[4], d[5]) / 16384
        gx, gy, gz = s16(d[8], d[9]) / 131, s16(d[10], d[11]) / 131, s16(d[12], d[13]) / 131
        win.append([t, round(ax, 4), round(ay, 4), round(az, 4), round(gx, 2), round(gy, 2), round(gz, 2)])
        if t - win[0][0] >= WINDOW_MS and len(win) >= 8:
            mags = [math.sqrt(s[1] ** 2 + s[2] ** 2 + s[3] ** 2) for s in win]
            mean = sum(mags) / len(mags)
            std = math.sqrt(sum((m - mean) ** 2 for m in mags) / len(mags))
            g = S.gps()
            if std > STILL_STD_G or (g and (g["speed"] or 0) > 2):
                S.moving_at = time.time()
            with S.lock:
                S.windows.append(win)
            win = []
        nxt += 1 / RATE_HZ
        time.sleep(max(0, nxt - time.monotonic()))


# ---------------------------------------------------------------- serial ports: GPS (NMEA) and PMS5003

def candidate_ports():
    ports = sorted(set(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*") + [p for p in ("/dev/serial0", "/dev/ttyAMA0", "/dev/ttyS0") if os.path.exists(p)]))
    return ports


def sniff(port):
    """'gps', 'air' or None, from a second of data at 9600 baud."""
    import serial  # sudo apt install python3-serial
    try:
        with serial.Serial(port, 9600, timeout=0.2) as s:
            buf = b""
            end = time.time() + 1.6
            while time.time() < end:
                buf += s.read(256)
            if b"$GP" in buf or b"$GN" in buf:
                return "gps"
            if b"\x42\x4d\x00\x1c" in buf:
                return "air"
    except Exception:
        pass
    return None


def find_ports():
    gps, air = os.environ.get("SCOOTSENSE_GPS_PORT"), os.environ.get("SCOOTSENSE_AIR_PORT")
    if gps and air:
        return gps, air
    for p in candidate_ports():
        if p in (gps, air):
            continue
        kind = sniff(p)
        if kind == "gps" and not gps:
            gps = p
        elif kind == "air" and not air:
            air = p
    return gps, air


def nmea_deg(value, hemi):
    if not value:
        return None
    dot = value.index(".")
    deg = float(value[:dot - 2]) + float(value[dot - 2:]) / 60
    return -deg if hemi in ("S", "W") else deg


def gps_loop(port):
    import serial
    S.found["gps"] = port
    with serial.Serial(port, int(os.environ.get("SCOOTSENSE_GPS_BAUD", "9600")), timeout=1) as s:
        while True:
            line = s.readline().decode("ascii", "ignore").strip()
            if not line.startswith("$") or "RMC," not in line[:7]:
                continue
            p = line.split("*")[0].split(",")
            if len(p) < 8 or p[2] != "A":       # A = valid fix
                continue
            try:
                lat, lng = nmea_deg(p[3], p[4]), nmea_deg(p[5], p[6])
                speed = float(p[7]) * 1.852 if p[7] else None    # knots -> km/h
            except (ValueError, IndexError):
                continue
            with S.lock:
                S.fix = {"lat": lat, "lng": lng, "speed": speed, "at": time.time()}


def air_loop(port):
    import serial
    S.found["air"] = port
    with serial.Serial(port, 9600, timeout=2) as s:
        while True:
            if s.read(1) != b"\x42" or s.read(1) != b"\x4d":
                continue
            frame = b"\x42\x4d" + s.read(30)
            if len(frame) != 32 or sum(frame[:30]) != (frame[30] << 8 | frame[31]):
                continue
            pm25 = frame[12] << 8 | frame[13]           # PM2.5, atmospheric, ug/m3
            with S.lock:
                S.pm25 = (pm25, time.time())


# ---------------------------------------------------------------- sending

def sender_loop():
    last_heartbeat = last_note = last_status = 0
    sent = 0
    while True:
        time.sleep(SEND_EVERY)
        now = time.time()
        parked = now - S.moving_at > PARKED_AFTER
        with S.lock:
            batch = [] if parked else [S.windows.popleft() for _ in range(min(20, len(S.windows)))]
            if parked:
                S.windows.clear()
        if not batch and now - last_heartbeat < HEARTBEAT:
            continue
        payload = {"device": DEVICE, "windows": [{"samples": w} for w in batch], "gps": S.gps(), "pm25": S.air()}
        try:
            status, body = post("/api/device/readings", payload)
        except (urllib.error.URLError, TimeoutError, OSError):
            status, body = 0, {}
        if status != 200:
            with S.lock:                       # keep them for later
                S.windows.extendleft(reversed(batch))
            if now - last_note > 30:
                print(f"  offline ({status or 'no connection'}); keeping {len(S.windows)} readings")
                last_note = now
            continue
        last_heartbeat = now
        if not body.get("paired"):
            if now - last_note > 60:
                print(f"  not linked yet: {body.get('message')}")
                last_note = now
            continue
        sent += len(batch)
        if now - last_status > 5:
            g, a = S.gps(), S.air()
            road = f"{body.get('bumps', 0)} bump(s) in the last batch" if batch else "parked"
            print(f"{time.strftime('%H:%M:%S')} {road} · {sent} windows sent · "
                  f"GPS {'%.5f,%.5f %s km/h' % (g['lat'], g['lng'], g['speed']) if g else 'no fix'} · PM2.5 {a if a is not None else '-'}")
            last_status = now


# ---------------------------------------------------------------- litter camera

LITTER = {"bottle", "cup", "wine glass", "fork", "knife", "spoon", "bowl", "banana", "apple", "orange",
          "sandwich", "hot dog", "pizza", "donut", "cake", "book", "toothbrush", "cell phone", "remote", "scissors", "umbrella"}


def camera_loop():
    setting = os.environ.get("SCOOTSENSE_CAMERA", "0")
    if setting == "off":
        return
    try:
        import cv2
        from ultralytics import YOLO
    except ImportError:
        print("Litter camera off: install ultralytics and python3-opencv to turn it on")
        return
    cap = cv2.VideoCapture(int(setting))
    if not cap.isOpened():
        print("Litter camera off: no webcam found")
        return
    model_name = os.environ.get("SCOOTSENSE_MODEL", "yolo11n.pt")
    model = YOLO(model_name)
    default_model = os.path.basename(model_name).startswith("yolo")
    S.found["camera"] = True
    recent, reported = collections.deque(maxlen=3), {}

    def overlaps(a, b):
        return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])

    while True:
        for _ in range(3):
            cap.grab()
        ok, frame = cap.read()
        if not ok:
            time.sleep(2)
            continue
        r = model(frame, imgsz=416, conf=0.5, verbose=False)[0]
        found, people = [], []
        for box, cls, conf in zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist()):
            label = r.names[int(cls)].lower()
            if label == "person":
                people.append(box)
            elif not default_model or label in LITTER:
                found.append((label, conf, box))
        kinds = []
        for label, conf, box in sorted(found, key=lambda f: -f[1]):
            if not any(overlaps(box, p) for p in people) and label not in kinds:
                kinds.append(label)
        recent.append(set(kinds))
        now = time.time()
        steady = [k for k in kinds if sum(k in s for s in recent) >= 2 and now - reported.get(k, 0) > 30]
        if steady:
            g = S.gps()
            payload = {"device": DEVICE, "items": steady[:5], **({"lat": g["lat"], "lng": g["lng"]} if g else {})}
            try:
                status, body = post("/api/cam/detection", payload)
                if body.get("trash"):
                    print(f"  litter: {', '.join(steady)} -> alert sent to the phone")
            except (urllib.error.URLError, TimeoutError, OSError):
                pass
            for k in steady:
                reported[k] = now
        time.sleep(1)


# ---------------------------------------------------------------- entry points

def start(target, *args):
    def run():
        try:
            target(*args)
        except Exception as e:  # one sensor failing must not stop the others
            print(f"{target.__name__.replace('_loop', '')} stopped: {e}")
    threading.Thread(target=run, daemon=True).start()


def check():
    print("Looking for sensors...")
    try:
        bus = open_i2c(int(os.environ.get("SCOOTSENSE_I2C_BUS", "1")))
        ok = any(_probe(bus, a) for a in (0x68, 0x69))
        print(f"  MPU6050 motion sensor: {'found' if ok else 'NOT found'}")
    except Exception as e:
        print(f"  MPU6050 motion sensor: I2C not available ({e})")
    try:
        gps, air = find_ports()
        print(f"  GPS: {gps or 'NOT found'}")
        print(f"  PMS5003 air sensor: {air or 'NOT found'}")
    except ImportError:
        print("  GPS / air sensor: install python3-serial first")
    try:
        import cv2
        cap = cv2.VideoCapture(int(os.environ.get("SCOOTSENSE_CAMERA", "0")))
        print(f"  Webcam: {'found' if cap.isOpened() else 'NOT found'}")
    except ImportError:
        print("  Webcam: install python3-opencv first")


def _probe(bus, addr):
    try:
        bus.read_byte_data(addr, 0x75)
        return True
    except OSError:
        return False


def selftest():
    """Connection check only: a few seconds of made-up readings, sent once."""
    print("Sending a connection check (made-up readings, not a ride)...")
    windows, t = [], 0
    for w in range(6):
        win = []
        for i in range(25):
            bump = 1.6 if (w == 3 and 8 <= i <= 11) else 0
            az = 1 + 0.02 * math.sin(i) + (bump if i % 2 else -bump * 0.6)
            win.append([t, 0.01, -0.02, round(az, 4), 0.5, -0.3, 0.1])
            t += 20
        windows.append({"samples": win})
    payload = {"device": DEVICE, "windows": windows, "gps": {"lat": 43.7841, "lng": -79.1866, "speed": 12.0}, "pm25": 9}
    status, body = post("/api/device/readings", payload)
    print(f"  HTTP {status}: {json.dumps(body)}")


def main():
    print(f"ScootSense unit ID: {DEVICE}")
    print(f"Server: {SERVER}")
    if "--check" in sys.argv:
        return check()
    if "--selftest" in sys.argv:
        return selftest()
    start(imu_loop)
    try:
        gps, air = find_ports()
    except ImportError:
        gps = air = None
        print("GPS and air sensor off: sudo apt install python3-serial")
    if gps:
        start(gps_loop, gps)
    else:
        print("No GPS found: rides will have no map position")
    if air:
        start(air_loop, air)
    else:
        print("No PMS5003 found: no air readings")
    start(camera_loop)
    start(sender_loop)
    print("Running. Ride safe! Ctrl+C to stop.")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
