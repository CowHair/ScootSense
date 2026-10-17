#!/usr/bin/env python3
"""ScootSense litter camera for a Raspberry Pi with a USB webcam (e.g. a Logitech C270 / C920).

The Pi does the detecting. Only when it is sure there is litter does it send one photo, so the
rider sees what was found and Gemini can name it (bottle, wrapper, foam...). Nothing else leaves the Pi.

    POST {SERVER_URL}/api/cam/detection
    Content-Type: application/json
    {
      "device": "cam-7f3a",
      "items": ["bottle"],                   <- the detector's labels ("item" from a litter-only model is fine)
      "confidence": 0.71,                    <- the detector's best score
      "photo": "data:image/jpeg;base64,...", <- that frame, 640 px wide, JPEG quality 70 (about 40-80 KB)
      "lat": 43.7841, "lng": -79.187         <- only if a GPS is connected (gpsd)
    }

  * Sent when the detector sees a kind of trash in at least 2 of the last 3 checks (so one odd
    frame does not raise an alert), at most once per kind every 30 seconds.
  * Every 60 seconds it also sends {"device": ..., "items": []} as a heartbeat, so the app
    shows the camera as Live.
  * The server trusts the Pi's decision. Gemini looks at the photo to name the litter, its
    material and whether it is safe to pick up, and suggests something to make from it. The
    rider's phone asks "pick it up or put it on the map?" and shows the photo.
  * Heartbeats never carry a photo. Set SCOOTSENSE_PHOTO=0 to send words only.

Detector
  YOLO from Ultralytics. The default model (yolo11n.pt, downloaded on first run) knows everyday
  objects such as bottles, cups, cutlery and food; only the ones that are usually litter are
  reported. For better results (wrappers, cans, cigarette butts...) use a model trained on
  litter, for example on the TACO dataset, and set SCOOTSENSE_MODEL to its .pt file; its class
  names are sent as the trash types.
  Items that overlap a detected person are ignored (a bottle in someone's hand is not litter).

Setup (Raspberry Pi OS Bookworm, 64-bit; Pi 4 or 5)
  sudo apt install -y python3-opencv
  python3 -m venv --system-site-packages ~/scootsense
  ~/scootsense/bin/pip install ultralytics
  ~/scootsense/bin/python scootsense_cam.py
  The first line printed is the camera ID (like cam-7f3a). In the ScootSense app, sign in,
  open the Litter camera tab and type that ID under "Link".

Options (environment variables)
  SCOOTSENSE_SERVER   default https://scootsense.vercel.app
  SCOOTSENSE_DEVICE   override the camera ID (letters, digits, dashes; 3-40 characters)
  SCOOTSENSE_TOKEN    only if the server has INGEST_TOKEN set
  SCOOTSENSE_CAMERA   webcam index, default 0 (/dev/video0)
  SCOOTSENSE_MODEL    detector weights, default yolo11n.pt
  SCOOTSENSE_EVERY    seconds between checks, default 1
  SCOOTSENSE_PHOTO    1 (default) sends the photo of each confirmed detection; 0 sends words only

Testing
  python3 scootsense_cam.py --test           send one sample detection (no camera or model needed)
  python3 scootsense_cam.py --test p.jpg     the same with a photo, which Gemini names
  python3 scootsense_cam.py --image p.jpg    detect in a photo and print what would be sent
                                             (add --send to actually send it, with the photo)

Run at boot (optional)
  sudo tee /etc/systemd/system/scootsense-cam.service <<'EOF'
  [Unit]
  Description=ScootSense litter camera
  After=network-online.target
  Wants=network-online.target
  [Service]
  ExecStart=/home/pi/scootsense/bin/python /home/pi/scootsense_cam.py
  Restart=always
  User=pi
  [Install]
  WantedBy=multi-user.target
  EOF
  sudo systemctl enable --now scootsense-cam
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import deque

SERVER_URL = os.environ.get("SCOOTSENSE_SERVER", "https://scootsense.vercel.app").rstrip("/")
TOKEN = os.environ.get("SCOOTSENSE_TOKEN", "")
CAMERA = int(os.environ.get("SCOOTSENSE_CAMERA", "0"))
MODEL = os.environ.get("SCOOTSENSE_MODEL", "yolo11n.pt")
EVERY = float(os.environ.get("SCOOTSENSE_EVERY", "1"))
SEND_PHOTO = os.environ.get("SCOOTSENSE_PHOTO", "1") != "0"
PHOTO_WIDTH = 640           # pixels; the server keeps photos under about 120 KB
PHOTO_QUALITY = 70
MIN_CONFIDENCE = 0.5       # detector score needed to count an object (never sent)
COOLDOWN = 30              # seconds before the same kind of trash is reported again
HEARTBEAT = 60             # seconds between "still here" messages

# Everyday-object classes (COCO) that are usually litter when they are on the ground.
# A litter-trained model (SCOOTSENSE_MODEL) reports all of its classes instead.
LITTER = {
    "bottle", "cup", "wine glass", "fork", "knife", "spoon", "bowl", "banana", "apple", "orange",
    "sandwich", "hot dog", "pizza", "donut", "cake", "book", "toothbrush", "cell phone", "remote",
    "scissors", "umbrella",
}


def camera_id():
    """Same format as the ESP32-CAM: 'cam-' plus the last two bytes of the MAC address."""
    custom = os.environ.get("SCOOTSENSE_DEVICE", "").strip().lower()
    if custom:
        return custom
    mac = uuid.getnode()
    return f"cam-{(mac >> 8) & 0xFF:02x}{mac & 0xFF:02x}"


def read_gps():
    """Optional position from gpsd ('gpsd-py3' package). Without it the server uses the
    rider's phone location, which is fine when the phone is on the handlebar."""
    try:
        import gpsd  # type: ignore
        if not getattr(read_gps, "connected", False):
            gpsd.connect()
            read_gps.connected = True
        fix = gpsd.get_current()
        if fix.mode >= 2:
            return fix.lat, fix.lon
    except Exception:
        pass
    return None


# ---------------------------------------------------------------- talking to the server

def post(payload):
    req = urllib.request.Request(
        f"{SERVER_URL}/api/cam/detection",
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json", **({"x-scootsense-token": TOKEN} if TOKEN else {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def photo_of(frame):
    """The frame as a small JPEG data URL (about 40-80 KB), or None if it cannot be encoded."""
    import cv2
    h, w = frame.shape[:2]
    if w > PHOTO_WIDTH:
        frame = cv2.resize(frame, (PHOTO_WIDTH, round(h * PHOTO_WIDTH / w)), interpolation=cv2.INTER_AREA)
    for quality in (PHOTO_QUALITY, 55, 40):           # step down if a busy scene is too big
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok and len(jpg) <= 110_000:
            return "data:image/jpeg;base64," + base64.b64encode(jpg.tobytes()).decode()
    return None


def send(device, items, confidence=None, frame=None):
    payload = {"device": device, "items": items}
    if confidence is not None:
        payload["confidence"] = round(float(confidence), 3)
    if frame is not None and SEND_PHOTO:
        photo = photo_of(frame)
        if photo:
            payload["photo"] = photo
    pos = read_gps()
    if pos:
        payload["lat"], payload["lng"] = round(pos[0], 6), round(pos[1], 6)
    try:
        status, body = post(payload)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  network error: {e}")
        return None
    if status != 200:
        print(f"  server said {status}: {body.get('error', '')}")
    elif not body.get("paired"):
        print(f"  not linked yet: {body.get('message')}")
    elif body.get("skipped"):
        print("  the rider has not answered the last alert yet")
    elif body.get("trash"):
        named = " (named by Gemini)" if body.get("namedBy") == "gemini" else ""
        print(f"  alert sent to the phone: {body.get('summary')}{named}")
    return body


# ---------------------------------------------------------------- detecting

def overlaps(a, b):
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


class Detector:
    def __init__(self):
        from ultralytics import YOLO  # ~/scootsense/bin/pip install ultralytics
        self.model = YOLO(MODEL)
        self.default_model = os.path.basename(MODEL).startswith("yolo")

    def litter(self, frame):
        """Kinds of trash in one frame with their best score, most confident first,
        e.g. [("bottle", 0.82), ("cup", 0.61)]."""
        result = self.model(frame, imgsz=416, conf=MIN_CONFIDENCE, verbose=False)[0]
        names = result.names
        found, people = [], []
        for box, cls, conf in zip(result.boxes.xyxy.tolist(), result.boxes.cls.tolist(), result.boxes.conf.tolist()):
            label = names[int(cls)].lower()
            if label == "person":
                people.append(box)
            elif not self.default_model or label in LITTER:
                found.append((label, conf, box))
        kinds = {}
        for label, conf, box in sorted(found, key=lambda f: -f[1]):
            if any(overlaps(box, p) for p in people):
                continue  # held or carried by someone
            kinds.setdefault(label, conf)
        return list(kinds.items())[:5]


# ---------------------------------------------------------------- main loop

def run_camera(device):
    import cv2  # sudo apt install python3-opencv

    detector = Detector()
    cap = cv2.VideoCapture(CAMERA)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    if not cap.isOpened():
        sys.exit(f"Could not open webcam {CAMERA}. Check it with: ls /dev/video*")

    recent = deque(maxlen=3)        # labels seen in the last 3 checks
    last_reported = {}              # label -> time it was last sent
    last_heartbeat = 0.0
    print(f"Watching camera {CAMERA} with {MODEL}. Ctrl+C to stop.")
    send(device, [])                # announce ourselves (and learn whether we are linked)
    while True:
        started = time.time()
        for _ in range(3):          # drop buffered frames so we look at what the camera sees now
            cap.grab()
        ok, frame = cap.read()
        if not ok:
            print("  no frame from the webcam; retrying")
            time.sleep(2)
            continue

        found = detector.litter(frame)
        kinds = [k for k, _ in found]
        recent.append(set(kinds))
        now = time.time()
        steady = [k for k in kinds
                  if sum(k in seen for seen in recent) >= 2
                  and now - last_reported.get(k, 0) > COOLDOWN]
        if steady:
            best = max(c for k, c in found if k in steady)
            print(f"{time.strftime('%H:%M:%S')} saw: " + ", ".join(steady) + f" ({best:.0%})")
            send(device, steady, best, frame)   # the confirmed frame goes with it
            for k in steady:
                last_reported[k] = now
            last_heartbeat = now
        elif now - last_heartbeat > HEARTBEAT:
            send(device, [])
            last_heartbeat = now
        time.sleep(max(0.0, EVERY - (time.time() - started)))


def run_image(device, path, really_send):
    import cv2

    frame = cv2.imread(path)
    if frame is None:
        sys.exit(f"Could not read {path}")
    found = Detector().litter(frame)
    kinds = [k for k, _ in found]
    best = max((c for _, c in found), default=None)
    photo = photo_of(frame) if SEND_PHOTO and kinds else None
    print(json.dumps({"device": device, "items": kinds, "confidence": best and round(best, 3),
                      "photo": f"<{len(photo) * 3 // 4 // 1024} KB JPEG>" if photo else None}))
    if really_send and kinds:
        send(device, kinds, best, frame)


def run_test(device, photo_path=None):
    """Send a sample detection. With a photo path, the photo goes too (needs OpenCV, no model)."""
    sample = ["item"] if photo_path else ["bottle", "wrapper"]
    frame = None
    if photo_path:
        import cv2
        frame = cv2.imread(photo_path)
        if frame is None:
            sys.exit(f"Could not read {photo_path}")
    print("Sending a sample detection (no camera, no model):")
    print(json.dumps({"device": device, "items": sample, "confidence": 0.7, "photo": photo_path}))
    print(json.dumps(send(device, sample, 0.7, frame)))


def main():
    device = camera_id()
    print(f"ScootSense camera ID: {device}")
    print(f"Server: {SERVER_URL}")
    args = sys.argv[1:]
    if args[:1] == ["--test"]:
        run_test(device, args[1] if len(args) > 1 else None)
    elif args[:1] == ["--image"] and len(args) >= 2:
        run_image(device, args[1], "--send" in args)
    else:
        try:
            run_camera(device)
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
