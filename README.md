# ScootSense

**Turn an ordinary kick scooter into a low-cost mobile road-condition sensor.**
An ESP32 + MPU6050 + GPS module strapped to the deck classifies the road surface every 0.5 s.
Repeated detections from independent rides become a ranked, community-verified repair map, and
Gemini turns the data into briefings city staff can act on.

Hack the Valley tracks: *AI for Social Impact* · *Future of Sustainable Cities*.

## Features

| Area | What it does |
|---|---|
| **Live ride** | Stream from the **simulator**, **USB (Web Serial)** or **Wi-Fi**. Live waveform, per-window classification with probabilities and reasons, colour-coded ride track, hazard matches ("Matches H4, now seen on 4 rides"). |
| **Gemini second opinion** | Sends one 0.5 s waveform + features to Gemini (structured JSON output) and shows whether it agrees with the on-device model. |
| **Gemini ride summary** | After each ride: comfort score, worst spots, tip for better data. |
| **City map** | Roughness heatmap + hazard clusters sized by severity, ranked by a priority score that rewards repeated independent detections. Confirm / dismiss / mark fixed, notes. |
| **Gemini photo verification** | Snap a photo of a flagged spot: Gemini vision says whether a defect is visible, its type, severity 1–5 and accessibility impact. Images showing faces or plates are not stored. |
| **Gemini city briefing** | Markdown repair briefing for a chosen audience (maintenance team, accessibility committee, councillor, judges). Hazard IDs link to the map. |
| **Ask your streets** | Chat agent using Gemini **function calling** over the live database (`get_stats`, `list_hazards`, `get_hazard`, `roughest_segments`, `list_rides`). The tool calls are shown in the UI. |
| **Train model** | Record labelled windows, train a Gaussian Naive Bayes classifier in the browser, evaluate with **leave-one-recording-out**, compare to the rule baseline, deploy to the live pipeline. |
| **Impact** | Km surveyed, hazards per km, repeat-detection count, verification precision, funnel, ride table, **GeoJSON / CSV export** for city open-data tools. |
| **Trash scanner** | A phone on the handlebar sends one camera frame every few seconds to Gemini. When litter is found, one call identifies it **and** designs a product to build from it plus the rider's **home stash**. The rider picks it up (not mapped, counted as cleanup) or leaves it (pinned on the map for a crew). |
| **Home stash** | Items at home (jars, bottles, old t-shirts…), added by hand or from a photo Gemini reads. Stored on the phone only. Saved upcycle projects live here too. |
| **Air pollution** | Optional PMS5003 PM2.5 sensor; spikes alert the rider and hotspots appear on the map. The Ride tab also shows area air quality from Open-Meteo. |
| **Mobile app** | Installable web app with a bottom tab bar and a Google-Maps-style map (place search, layer chips, locate-me, directions, bottom sheet). |
| **Privacy** | Configurable location precision, privacy zones where nothing is stored, per-ride deletion with hazard recomputation. |

Every Gemini feature has a local fallback, so the demo never dies on bad Wi-Fi.

## Run it

```bash
npm install
cp .env.example .env        # fill in the keys below
npm start                   # http://localhost:3000
```

| Variable | What it does | Without it |
|---|---|---|
| `GEMINI_API_KEY` | All AI features ([get a key](https://aistudio.google.com/apikey)) | Offline fallbacks |
| `DATABASE_URL` | Tiger Data (Postgres + TimescaleDB) for accounts, stash, projects and activity | Local JSON file |
| `GOOGLE_CLIENT_ID` | "Continue with Google" sign-in (Web OAuth client) | Email and guest sign-in only |
| `AUTH_SECRET` | Signs session cookies | Random per server start |

The first start seeds 5 simulated rides around UTSC. `npm run seed` resets to that demo data.
Requires Node 22+. Web Serial needs Chrome or Edge.

## Accounts and data

- **Sign in** with Google, email and password (scrypt-hashed), or as a guest. Sessions are HMAC-signed cookies.
- **Tiger Data** stores `users`, `user_stash` and `user_projects`. It also stores two TimescaleDB hypertables: `user_activity` (km ridden, litter picked up, votes) and `ride_observations` (each rider's geotagged readings). The profile screen charts weekly totals with `time_bucket`. Tables are created automatically on first use.
- Community map data (hazards, litter, pollution) lives in `data/db.json` locally, or in `/tmp` on Vercel.

## Hardware (≈ CA$45–80)

ESP32 DevKit V1 · GY-521 MPU6050 · NEO-6M GPS · breadboard + jumpers · enclosure + straps · power bank.

| Module pin | ESP32 |
|---|---|
| MPU6050 VCC / GND | 3V3 / GND |
| MPU6050 SDA / SCL | GPIO 21 / GPIO 22 |
| GPS VCC / GND | per breakout / GND |
| GPS TX → | GPIO 16 (RX2) |
| GPS RX → | GPIO 17 (TX2) |

Flash `firmware/scootsense/scootsense.ino` (libraries: Adafruit MPU6050, Adafruit Unified Sensor, TinyGPSPlus).
For Wi-Fi mode set `USE_WIFI 1`, your hotspot credentials and `SERVER_URL` (the Device page lists your laptop's LAN address).

Mount the box rigidly and keep it clear of the brake, steering and wheels. Have a teammate drive the dashboard; never look at a screen while riding.

## Litter camera (ESP32-CAM)

An **ESP32-CAM (AI-Thinker, about CA$12-15)** on the handlebar stem sends a JPEG every 5 s to `POST /api/cam/frame?device=<id>`. Flash `firmware/scootsense_cam/scootsense_cam.ino` and set your Wi-Fi and `SERVER_URL`. The deployed HTTPS URL works.

1. On boot the Serial Monitor prints a camera ID, like `cam-7f3a`. Enter it in the app under **Scan → Link camera**.
2. Gemini checks each frame. When it finds litter, the rider's phone shows the photo, what was found and a project idea using their home stash:
   - **Pick it up**: added to the rider's **trash list** (and home stash), counted on their profile.
   - **Leave it**: pinned on the shared map at the rider's location.
   - **Not litter**: dismissed.
3. When any rider later passes within 40 m of a pin someone else left, the app asks **"Is this litter still here?"** Riders answer *still here*, *gone* or *I picked it up*. Two "gone" answers, or one pickup, take the pin off the map. You can also answer from the map.

While an alert is waiting for an answer, the camera keeps streaming but Gemini isn't called. This saves free-tier quota. Devices, alerts, rider presence, the litter map and trash lists are stored in Tiger Data (`cam_devices`, `trash_detections`, `user_presence`, `litter`, `user_trash`), so they work across Vercel instances. Without a database the camera flow only works locally.

## Architecture

```
ESP32 (50 Hz CSV) ──USB/Web Serial──▶ browser pipeline ─┐
        └────────Wi-Fi POST /api/ingest──▶ server pipeline ┤  shared/signal.js     windowing + features
                                                          │  shared/classifier.js rules + Gaussian NB
                                                          ▼
                                   Express + JSON store (server/store.js)
                                   hazard clustering · priority · privacy
                                                          │
                                   server/gemini.js  ── @google/genai
                                   vision · structured output · function calling
```

## 3-minute demo script

1. **Hook (20 s):** "Cars don't feel the cracks that stop a wheelchair. Scooters do."
2. **Live (60 s):** Hold up the device, start USB (or the simulator), tap the sensor, and show the classification change. Click *Ask Gemini for a second opinion*.
3. **Map (45 s):** Open a red hazard seen on 5 rides, upload a photo, and show Gemini's verdict.
4. **Insights (40 s):** Generate the briefing for the "city maintenance team" and ask the chat "Which 3 hazards should the city fix first?", pointing out the tool calls.
5. **Impact (15 s):** Show km surveyed, verification precision and the GeoJSON export.

Be upfront that detections are vibration estimates until confirmed. Judges reward honesty about limitations.
