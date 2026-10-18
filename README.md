# ScootSense

**Cars don't feel the cracks that stop a wheelchair, and they don't see the bottle in the bike lane. Scooters do.**

ScootSense turns an ordinary kick scooter into a moving sensor for **potholes, air pollution and litter**, and turns what it finds into a map the whole city can act on.

- **Live app:** [scootsense.vercel.app](https://scootsense.vercel.app) (use the **demo login** to try it without a scooter)
- **Built at:** Hack the Valley · tracks *AI for Social Impact* and *Future of Sustainable Cities*

## What it does

| | |
|---|---|
| **Potholes** | An accelerometer on the scooter is read 50 times a second. Any jolt of 0.8 g or more is a pothole; smaller ones are sorted into smooth, crack or rough. A hard jolt pops up **"Pothole!"** on the rider's phone and lands on the map where they are. |
| **Air pollution** | A gas sensor reports fresh, low, high or severe air in real time. Bad-air spots appear on the map. |
| **Litter** | A camera on the scooter runs our own YOLO litter model **on the Pi**. When litter is confirmed, the phone shows the photo, what it is (named by Gemini) and one question: *pick it up, or leave it on the map?* Riders who pass later are asked if it's still there. |
| **Live camera** | During a ride the Ride page shows the scooter camera live, with green boxes around any litter it sees. |
| **Shared city map** | Potholes ranked by how many separate rides confirmed them, litter pins, air hotspots and a 3D view. |
| **Ask Scootie** | A Gemini eco buddy. Tell it what you picked up and it designs a real project: materials, steps, a safety note and a generated picture. |
| **For the city** | Gemini repair briefings, ready-to-send 311 reports, a chat over the live data (function calling), and GeoJSON / CSV export. |
| **Trusted record** | Confirmed reports are written to **Solana** as a hash of the facts, so anyone can verify the database. Helpers earn **SCOOT** points (devnet test tokens, no money value). |
| **Accessible** | Large high-contrast text in Atkinson Hyperlegible, big buttons and plain words, on phones and laptops. |

## How it works

```
 Scooter: Raspberry Pi 5                      Web app: Node.js + Express on Vercel
 ┌──────────────────────────────┐            ┌──────────────────────────────────────────┐
 │ LIS3DHTR accelerometer 50 Hz │─ readings ▶│ classify 0.5 s windows · map hazards     │──▶ Tiger Data
 │ Air Quality v1.3 (Base Hat)  │  (gzip)    │ litter alerts · live view · rewards      │    (Postgres +
 │ USB webcam + YOLO litter1n   │─ photo ───▶│ Gemini: name litter, coach, briefings    │     TimescaleDB)
 │ faces blurred with YuNet     │─ live JPEG▶│ Solana devnet: memo records + SCOOT      │
 └──────────────────────────────┘            └──────────────────────────────────────────┘
          ▲  phone hotspot                                  ▲
          └──────────── rider's phone: location, alerts, live camera ──┘
```

- **No GPS on the scooter.** The rider's phone supplies the location.
- **Light on data.** Motion is batched every 2 s and gzip-compressed (about 1.4 MB per hour). The scooter only checks in while parked. A litter photo (12–40 KB) is sent only when litter is confirmed. The live view streams only while someone watches it.
- **Fewer false alarms.** Litter must be the same object in 3 of the last 5 frames, on the ground, and sharp enough. If Gemini is confident a photo has no litter, the alert is dropped.
- **Privacy first.** Faces are blurred on the Pi before anything is sent. Location precision can be lowered, and riders can set private zones where nothing is stored.

## Tech stack

| Part | Built with |
|---|---|
| Hardware | Raspberry Pi 5, Grove Base Hat, Grove LIS3DHTR accelerometer, Grove Air Quality v1.3, USB webcam |
| On the Pi | Python, Ultralytics YOLO (our `litter1n` model, run with NCNN), OpenCV + YuNet face blur, smbus2, systemd |
| Server | Node.js 22, Express 5, hosted on Vercel |
| Data | Tiger Data: Postgres + TimescaleDB hypertables (ride readings compressed after 7 days, `time_bucket` charts) |
| AI | Google Gemini: vision, structured output, function calling, image generation |
| Blockchain | Solana devnet: Memo program records, SCOOT as a Token-2022 token |
| Front end | Plain JavaScript web app (installable), Leaflet, MapLibre 3D, Chart.js |

## Repository

```
server/            Express API: rides, hazards, litter, camera, Pi readings, Gemini, Solana, Tiger Data schema
public/            the web app (HTML, CSS, JS)
shared/            signal processing and road classifier, used by both server and browser
firmware/
  raspberry_pi/    scootsense_unit.py: the whole scooter unit (sensors, litter camera, face blur)
  scootsense/      ESP32 sketch for the app's USB sensor mode
  scootsense_cam/  ESP32-CAM sketch
api/               Vercel entry point
scripts/           one-time Solana setup
```

The litter model's training scripts and dataset are on the [`ml-model`](https://github.com/CowHair/ScootSense/tree/ml-model) branch.

## Run it locally

```bash
npm install
npm start                   # http://localhost:3000
```

Application settings are embedded in `server/config.js`, including the Tiger Data connection string, authentication secret, and optional integration credentials. Gemini's key and model constants are in `server/gemini.js`, with image model choices in `server/coach.js`. No `.env` file is loaded. Blank optional credentials keep their existing fallback behavior. `npm run solana:setup` saves generated wallet and mint settings to `server/config.js`. Raspberry Pi settings are constants in `firmware/raspberry_pi/scootsense_unit.py`.

Requires Node 22+. The first start seeds demo rides around UTSC; `npm run seed` resets them.

## Set up the scooter unit

1. Wire the accelerometer to an I2C port on the Grove Base Hat, the air sensor to **A0**, and plug the webcam into USB.
2. Enable I2C (`sudo raspi-config`), then install `ultralytics opencv-python smbus2` in a venv.
3. Copy `firmware/raspberry_pi/scootsense_unit.py`, the YuNet model next to it, and the `litter1n` model to the Pi.
4. Run `python scootsense_unit.py --check`. It prints the unit ID (like `cam-d3d2`). Link that ID in the app's **Camera** tab.
5. Install it as a systemd service (instructions at the top of the script) so it starts on boot. After that the scooter only needs power and the phone's hotspot.

Testing without hardware: `--simulate` (made-up sensors), `--test` (one check-in), `--dry-run`.

## Honest limits

- Vibration readings are **estimates** until other riders or a photo confirm them.
- The litter model was trained on public photos and scores about 68% mAP50 on a small test set; real scooter footage scores lower. That is why Gemini double-checks every alert.
- SCOOT is a devnet test token with no monetary value.

## Team

hasini2k8 · CowHair · Isha Das · Clique_bait3 · Zenny

## Credits

- Photos in `public/img` are from Wikimedia Commons (CC0, public domain, CC BY, CC BY-SA). See `public/img/CREDITS.md`.
- Litter detection uses Ultralytics YOLO (AGPL-3.0). Face detection uses OpenCV's YuNet model.
