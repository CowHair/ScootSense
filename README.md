# ScootSense

**Turn an ordinary kick scooter into a low-cost mobile sensor for potholes, air pollution and litter.**
A Raspberry Pi on the scooter reads a motion sensor, an air sensor and a camera. The web
app classifies the road every 0.5 s, maps hazards that independent rides confirm, spots litter with a
photo that Gemini names, and rewards riders with SCOOT points on Solana's public record.

Live: [scootsense.vercel.app](https://scootsense.vercel.app). Hack the Valley tracks: *AI for Social Impact* · *Future of Sustainable Cities*.

## Features

| Area | What it does |
|---|---|
| **Live ride** | Follows the **Raspberry Pi** scooter unit over the internet. The **demo login** uses a simulated scooter instead. Live waveform, per-window classification with probabilities and reasons, colour-coded ride track, hazard matches ("Matches H4, now seen on 4 rides"). |
| **Gemini second opinion** | Sends one 0.5 s waveform + features to Gemini (structured JSON output) and shows whether it agrees with the on-device model. |
| **Gemini ride summary** | After each ride: comfort score, worst spots, tip for better data. |
| **City map** | Roughness heatmap + hazard clusters sized by severity, ranked by a priority score that rewards repeated independent detections. Confirm / dismiss / mark fixed, notes. Litter pins and PM2.5 hotspots on the same map, plus a **3D view** (MapLibre). |
| **Gemini photo verification** | Snap a photo of a flagged spot: Gemini vision says whether a defect is visible, its type, severity 1–5 and accessibility impact. Images showing faces or plates are not stored. |
| **Litter camera** | A camera on the scooter (Raspberry Pi) finds litter. The rider's phone shows the photo, what it is and a project idea using their **home stash**: pick it up, leave it on the map, or dismiss. See [Litter camera](#litter-camera). |
| **Phone scanner** | Without a scooter camera, the phone on the handlebar can send a frame every few seconds to Gemini, or check a photo you upload. |
| **Home stash** | Items at home (jars, bottles, old t-shirts…), added by hand or from a photo Gemini reads. Kept on the phone and, when signed in, in your account. Saved upcycle projects live here too. |
| **Ask Gemini (eco coach)** | A coach that knows your rides, trash list and stash and the city's hazards, litter and air. It answers with cards you can act on: a project from collected litter (with a generated picture), a cleanup route, a ready-to-send 311 report or a carbon summary. |
| **City briefing & chat** | Markdown repair briefing for a chosen audience, and a chat agent using Gemini **function calling** over the live data (`get_stats`, `list_hazards`, `get_hazard`, `roughest_segments`, `list_rides`). The tool calls are shown in the UI. |
| **SCOOT rewards on Solana** | When the community confirms a hazard or litter is picked up, a memo with a SHA-256 of the facts is written to Solana devnet, and the riders who helped get SCOOT (a Token-2022 test token, no monetary value). Anyone can re-check a record against the chain. See [Solana](#solana-public-record-and-scoot). |
| **Train model** | Record labelled windows, train a Gaussian Naive Bayes classifier in the browser, evaluate with **leave-one-recording-out**, compare to the rule baseline, deploy to the live pipeline. |
| **Impact** | Km surveyed, hazards per km, repeat-detection count, verification precision, funnel, ride table, **GeoJSON / CSV export** for city open-data tools. |
| **Air pollution** | PMS5003 PM2.5 sensor; spikes alert the rider and hotspots appear on the map. The Ride tab also shows area air quality from Open-Meteo. |
| **Mobile app** | Installable web app with a bottom tab bar and a Google-Maps-style map (place search, layer menu, locate-me, directions, bottom sheet). |
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
| `GEMINI_MODEL` | Gemini model id (default `gemini-flash-latest`) | The default |
| `DATABASE_URL` | Tiger Data (Postgres + TimescaleDB) for accounts and all community data | Local JSON file (`data/db.json`) |
| `GOOGLE_CLIENT_ID` | "Continue with Google" sign-in (Web OAuth client). Add each site address as an Authorized JavaScript origin. | Email and guest sign-in only |
| `AUTH_SECRET` | Signs session cookies | Random per server start |
| `INGEST_TOKEN` | Shared secret the scooter unit and cameras must send (`x-scootsense-token` header) | Anyone with a linked device ID can send |
| `SOLANA_SECRET_KEY`, `SOLANA_MINT` | The app's devnet wallet and the SCOOT token. Create both with `npm run solana:setup`. | Records and rewards wait in the database |
| `SOLANA_RPC` | Solana RPC URL | Public devnet endpoint |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Workers AI fallback for the coach's project pictures | Gemini image models only |

The first start seeds 5 simulated rides around UTSC. `npm run seed` resets to that demo data.
Requires Node 22+. Web Serial needs Chrome or Edge. Never commit `.env`.

## Accounts and data

- **Sign in** with Google, email and password (scrypt-hashed), as a guest, or with the **demo login** (simulated scooter; demo rides are not saved to the map). Sessions are HMAC-signed cookies.
- **Tiger Data** holds everything, so the app works across Vercel instances. Tables are created automatically on first use, in schemas `accounts`, `sensing`, `city`, `ml`, `app` and `chain`:
  - accounts, stash, projects, trash lists, rider presence;
  - TimescaleDB hypertables for `user_activity` (km ridden, litter picked up, votes) and the ride readings (compressed after 7 days); the profile charts weekly totals with `time_bucket`;
  - rides, hazards, litter, devices, camera alerts, training data and the road model;
  - the Solana records, rewards and wallets.
- The server works in memory and keeps Tiger in sync (`server/persist.js`), saving before each reply.

## The scooter unit (Raspberry Pi)

`firmware/raspberry_pi/scootsense_pi.py` runs everything on the scooter: an MPU6050 (bumps and potholes, 50 Hz in 0.5 s windows), a GPS module, a PMS5003 air sensor and, optionally, a USB webcam for litter. Every second it sends `POST /api/device/readings`; the server classifies each window, builds the ride and maps hazards, and the phone follows it live. It keeps readings while offline and goes quiet when parked.

| Module | Raspberry Pi 4/5 (40-pin header) |
|---|---|
| MPU6050 VCC / GND / SDA / SCL | pin 1 (3.3 V) / pin 6 / pin 3 (GPIO2) / pin 5 (GPIO3) |
| GPS | USB, or TX → pin 10 (GPIO15 RXD) |
| PMS5003 VCC / GND / TX | pin 2 (5 V) / pin 14 / pin 10 (or a USB serial adapter) |
| Webcam | any USB port |

Setup and options are at the top of the script (`--check` lists the sensors it finds). The first line it prints is the unit ID, like `cam-7f3a`: sign in on the app and link that ID. Mount the box rigidly, clear of the brake, steering and wheels, and never look at a screen while riding.



## Litter camera

The scooter camera finds the litter; the rider decides what happens to it.

**Raspberry Pi (recommended).** `firmware/raspberry_pi/scootsense_cam.py` runs a YOLO detector on the Pi. Set `SCOOTSENSE_MODEL` to a litter-trained model such as the team's `litter1n.pt` from the `ml-model` branch. (With the default `yolo11n.pt`, items held by a person are ignored; a litter-only model has no "person" class.) When litter is seen in 2 of the last 3 checks, the Pi sends that one frame:

```
POST /api/cam/detection        Content-Type: application/json
{ "device": "cam-7f3a",
  "items": ["item"],                        detector labels; "item" from a litter-only model is fine
  "confidence": 0.71,                       the detector's best score
  "photo": "data:image/jpeg;base64,...",    640 px wide, JPEG quality 70 (about 40-80 KB)
  "lat": 43.78, "lng": -79.19 }             optional: without them the rider's phone position is used
```

- The Pi's decision stands: Gemini is never asked *whether* there is litter. One Gemini call per confirmed event looks at the photo and names each item (bottle, wrapper, foam…), its material and whether it is safe to pick up, and suggests a project. Without a photo, or if Gemini is unavailable, the Pi's own labels are used.
- `{"device": "cam-7f3a", "items": []}` with no photo is a heartbeat (every 20 s) that keeps the camera shown as Live; the app shows a camera as Offline after 90 s of silence. Nothing else leaves the Pi.
- Replies: `{"paired": false}` until the ID is linked; `{"paired": true, "trash": true, "summary": ..., "namedBy": "gemini", "photoSaved": true}` when the alert reached the phone; `"skipped"` while the rider still has an unanswered alert.
- `python3 scootsense_cam.py --test photo.jpg` sends one sample detection with that photo. `SCOOTSENSE_PHOTO=0` sends words only.
- The webcam option inside `scootsense_pi.py` still sends labels only (no photo); use `scootsense_cam.py` for photos.


**On the phone:**
1. Link the camera ID the device prints (like `cam-7f3a`) in the app while signed in. IDs are made from the device's MAC address; nothing is registered beforehand.
2. When litter is found, the phone shows the photo, what it is and a project idea:
   - **Pick it up**: added to the rider's **trash list** (and home stash), counted on their profile.
   - **Leave it**: pinned on the shared map at the rider's location.
   - **Not litter**: dismissed.
3. When any rider later passes within 40 m of a pin someone else left, the app asks **"Is this litter still here?"** Riders answer *still here*, *gone* or *I picked it up*. Two "gone" answers, or one pickup, take the pin off the map. You can also answer from the map.

While an alert is waiting for an answer, new detections are skipped, which saves Gemini quota.

## Solana public record and SCOOT

- When riders confirm a hazard (or report it fixed), or litter is picked up or confirmed gone, ScootSense writes one line to Solana devnet with the Memo program, for example
  `ScootSense | hazard H12 pothole confirmed | 3 confirmations, seen on 4 rides | 43.7841,-79.187 | sha256:9f2c…`.
  The hash covers the facts stored in Tiger, so **Verify** in the app re-reads the transaction and shows whether the database still matches the chain.
- The riders who helped get **SCOOT**, a Token-2022 token on devnet with no monetary value, minted to their wallet. Riders get a wallet held by ScootSense automatically, or link their own (Phantom or any address).
- Writes are queued in Tiger and sent after the reply, so a slow network never slows the app, and failed sends are retried.
- One-time setup: `npm run solana:setup` creates the app wallet, gets free devnet SOL and creates the SCOOT token, writing `SOLANA_SECRET_KEY` and `SOLANA_MINT` to `.env` (never printed or committed).

## Architecture

```
Raspberry Pi unit ──POST /api/device/readings (motion, GPS, PM2.5)──┐
 ──USB/Web Serial──▶ browser pipeline                          │   shared/signal.js     windowing + features
     └──Wi-Fi POST /api/ingest─────────────────────────────────────┤   shared/classifier.js rules + Gaussian NB
Pi camera ──POST /api/cam/detection (labels + photo)───────────────┤
 ──POST /api/cam/frame (JPEG)─────────────────────────────┤
                                                                     ▼
                         Express (server/index.js) · in-memory store kept in Tiger Data (persist.js)
                         hazard clustering · priority · privacy · litter map · camera alerts
                                │                         │                         │
            server/gemini.js ── @google/genai     server/chain.js ── Solana     server/coach.js
            vision · structured output ·          memo records · SCOOT          eco coach cards
            function calling                      (Token-2022, devnet)
```

## 3-minute demo script

1. **Hook (20 s):** "Cars don't feel the cracks that stop a wheelchair. Scooters do."
2. **Live (60 s):** Start a ride (the Pi unit, or the demo login's simulator), tap the sensor and show the classification change. Click *Ask Gemini for a second opinion*.
3. **Litter (30 s):** Show a camera alert with its photo and Gemini's name for the item, then *Pick it up*.
4. **Map (35 s):** Open a red hazard seen on several rides, upload a photo and show Gemini's verdict, then its Solana record and *Verify*.
5. **Insights (20 s):** Generate the briefing for the "city maintenance team" and ask "Which 3 hazards should the city fix first?", pointing out the tool calls.
6. **Impact (15 s):** Show km surveyed, verification precision and the GeoJSON export.

Be upfront that detections are vibration estimates until confirmed. Judges reward honesty about limitations.

## Credits

- Photos in `public/img` come from Wikimedia Commons under CC0, public domain, CC BY and CC BY-SA licences. See `public/img/CREDITS.md`.
- Litter detection on the Pi uses Ultralytics YOLO (AGPL-3.0).
