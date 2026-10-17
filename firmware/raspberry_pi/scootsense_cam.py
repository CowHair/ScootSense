#!/usr/bin/env python3
"""ScootSense litter camera for a Raspberry Pi with a USB webcam (e.g. a Logitech C270 / C920).

The Pi does the detecting. No picture ever leaves the Pi: it only sends what it found and a
short description of what it looks like.

    POST {SERVER_URL}/api/cam/detection
    Content-Type: application/json
    {
      "device": "cam-7f3a",
      "items": [
        {"label": "bottle", "material": "plastic", "confidence": 0.82,
         "description": "Green bottle, small, ahead on the left", "pickupSafe": true}
      ],
      "lat": 43.7841, "lng": -79.187        <- only if a GPS is connected (gpsd)
    }

  * Sent when the detector sees litter in at least 2 of the last 3 checks (so one odd frame
    does not raise an alert), at most once per kind of item every 30 seconds.
  * Every 60 seconds it also sends {"device": ..., "items": []} as a heartbeat, so the app
    shows the camera as Live.
  * The server then asks the rider's phone "pick it up or put it on the map?" and uses Gemini
    (text only: item names and materials) to suggest something to make from it.

Detector
  YOLO from Ultralytics. The default model (yolo11n.pt, downloaded on first run) knows everyday
  objects such as bottles, cups, cutlery and food; this script maps them to litter and
  materials. For better results use a model trained on litter (for example on the TACO
  dataset) and set SCOOTSENSE_MODEL to its .pt file; its class names are sent as labels.
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

Testing
  python3 scootsense_cam.py --test           send one sample detection (no camera or model needed)
  python3 scootsense_cam.py --image p.jpg    detect in a photo and print what would be sent
                                             (add --send to actually send it; the photo stays local)

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
MIN_CONFIDENCE = 0.45      # detector score needed to count an object at all
SEND_CONFIDENCE = 0.5      # the server ignores items below this
COOLDOWN = 30              # seconds before the same kind of item is reported again
HEARTBEAT = 60             # seconds between "still here" messages

# Everyday-object classes (COCO) that are usually litter when they are on the ground,
# with their likely material. Anything else from the default model is ignored.
LITTER = {
    "bottle": "plastic", "cup": "paper", "wine glass": "glass", "fork": "plastic", "knife": "plastic",
    "spoon": "plastic", "bowl": "mixed", "banana": "organic", "apple": "organic", "orange": "organic",
    "sandwich": "organic", "hot dog": "organic", "pizza": "organic", "donut": "organic", "cake": "organic",
    "book": "paper", "toothbrush": "plastic", "cell phone": "electronic", "remote": "electronic",
    "scissors": "metal", "umbrella": "mixed",
}
UNSAFE = {"scissors", "knife", "wine glass", "syringe", "needle", "battery", "broken glass"}
# Words a litter-trained model might use, to guess a material for its own class names.
MATERIAL_WORDS = {
    "plastic": "plastic", "bottle": "plastic", "bag": "plastic", "wrapper": "plastic", "straw": "plastic", "lid": "plastic",
    "can": "metal", "metal": "metal", "foil": "metal", "glass": "glass", "jar": "glass",
    "paper": "paper", "cup": "paper", "napkin": "paper", "carton": "cardboard", "cardboard": "cardboard",
    "cigarette": "mixed", "food": "organic", "battery": "hazardous", "syringe": "hazardous",
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


def send(device, items):
    payload = {"device": device, "items": items}
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
        print(f"  alert sent to the phone: {body.get('summary')}")
    return body


# ---------------------------------------------------------------- describing what was seen

def colour_name(bgr_crop):
    """A plain colour word for the middle of the object."""
    import cv2
    import numpy as np

    h, w = bgr_crop.shape[:2]
    core = bgr_crop[h // 4: max(h // 4 + 1, 3 * h // 4), w // 4: max(w // 4 + 1, 3 * w // 4)]
    hsv = cv2.cvtColor(core, cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(float)
    hue, sat, val = np.median(hsv[:, 0]), np.median(hsv[:, 1]), np.median(hsv[:, 2])
    if val < 50:
        return "black"
    if sat < 40:
        return "white" if val > 190 else "grey" if val > 90 else "dark grey"
    for limit, name in ((8, "red"), (20, "orange"), (32, "yellow"), (85, "green"), (100, "teal"), (130, "blue"), (155, "purple"), (172, "pink"), (180, "red")):
        if hue <= limit:
            return name
    return "coloured"


def describe(label, colour, box, frame_w, frame_h):
    x1, y1, x2, y2 = box
    area = (x2 - x1) * (y2 - y1) / float(frame_w * frame_h)
    size = "small" if area < 0.02 else "medium" if area < 0.08 else "large"
    cx = (x1 + x2) / 2 / frame_w
    side = "on the left" if cx < 0.38 else "on the right" if cx > 0.62 else "in the middle of the path"
    distance = "close" if y2 / frame_h > 0.8 else "ahead"
    return f"{colour.capitalize()} {label}, {size}, {distance} {side}"


def material_for(label):
    if label in LITTER:
        return LITTER[label]
    for word, material in MATERIAL_WORDS.items():
        if word in label:
            return material
    return "mixed"


def overlaps(a, b):
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


class Detector:
    def __init__(self):
        from ultralytics import YOLO  # ~/scootsense/bin/pip install ultralytics
        self.model = YOLO(MODEL)
        self.default_model = os.path.basename(MODEL).startswith("yolo")

    def litter(self, frame):
        """Litter items in one frame: [{label, material, confidence, description, pickupSafe}]."""
        h, w = frame.shape[:2]
        result = self.model(frame, imgsz=416, conf=MIN_CONFIDENCE, verbose=False)[0]
        names = result.names
        found, people = [], []
        for box, cls, conf in zip(result.boxes.xyxy.tolist(), result.boxes.cls.tolist(), result.boxes.conf.tolist()):
            label = names[int(cls)].lower()
            if label == "person":
                people.append(box)
            elif not self.default_model or label in LITTER:
                found.append((label, conf, box))
        items = []
        for label, conf, box in found:
            if any(overlaps(box, p) for p in people):
                continue  # held or carried by someone
            x1, y1, x2, y2 = (int(v) for v in box)
            crop = frame[max(0, y1):max(y1 + 1, y2), max(0, x1):max(x1 + 1, x2)]
            items.append({
                "label": label,
                "material": material_for(label),
                "confidence": round(float(conf), 2),
                "description": describe(label, colour_name(crop), (x1, y1, x2, y2), w, h),
                "pickupSafe": label not in UNSAFE,
            })
        return sorted(items, key=lambda i: -i["confidence"])[:5]


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

        items = detector.litter(frame)
        recent.append({i["label"] for i in items})
        now = time.time()
        steady = [i for i in items
                  if sum(i["label"] in seen for seen in recent) >= 2
                  and i["confidence"] >= SEND_CONFIDENCE
                  and now - last_reported.get(i["label"], 0) > COOLDOWN]
        if steady:
            print(f"{time.strftime('%H:%M:%S')} saw: " + "; ".join(i["description"] for i in steady))
            send(device, steady)
            for i in steady:
                last_reported[i["label"]] = now
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
    items = [i for i in Detector().litter(frame) if i["confidence"] >= SEND_CONFIDENCE]
    print(json.dumps({"device": device, "items": items}, indent=2))
    if really_send:
        send(device, items)


def run_test(device):
    sample = [{"label": "bottle", "material": "plastic", "confidence": 0.9,
               "description": "Green bottle, small, ahead on the left", "pickupSafe": True}]
    print("Sending a sample detection (no camera, no model):")
    print(json.dumps({"device": device, "items": sample}, indent=2))
    print(json.dumps(send(device, sample)))


def main():
    device = camera_id()
    print(f"ScootSense camera ID: {device}")
    print(f"Server: {SERVER_URL}")
    args = sys.argv[1:]
    if args[:1] == ["--test"]:
        run_test(device)
    elif args[:1] == ["--image"] and len(args) >= 2:
        run_image(device, args[1], "--send" in args)
    else:
        try:
            run_camera(device)
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
