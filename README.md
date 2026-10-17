# ScootSense litter detector (YOLO)

Detects litter in photos or video from a scooter-mounted camera. The model has a single
class, `litter`. It is meant to run on a Raspberry Pi 5 (exported to NCNN) and feed
detections to the ScootSense app, which adds the phone's GPS position.

## What is in this repo

| Path | What it is |
|---|---|
| `models/litter1n.pt` | Nano model (yolo11n, single class). This is the one for the Pi. |
| `models/litter1s.pt` | Small model (yolo11s, single class). More accurate, slower, for laptops. |
| `train.py` | Training script (Ultralytics). |
| `prepare_taco.py` | Optional: converts the TACO dataset to YOLO format. Not used for the current models. |
| `data.yaml.example` | Dataset config template. Copy to `data.yaml` and fix the `path:` line. |
| `pi/` | Scripts that run on the Raspberry Pi (`detect.py`, and later the uploader). |

The dataset and training runs are NOT in the repo (too large). See "Dataset" below.

## Results so far

Measured on the dataset's own validation split (only 50 images, 83 boxes), so treat these
as rough. Real scooter footage has not been tested yet and will likely score lower.

| Model | Precision | Recall | mAP50 | mAP50-95 |
|---|---|---|---|---|
| yolo11s, single class | 0.765 | 0.651 | 0.724 | 0.462 |
| yolo11n, single class | 0.630 | 0.759 | 0.679 | 0.458 |

A 7-class (material) version scored mAP50 0.288, so we use one class and plan to identify
the litter type afterwards (for example with Gemini in the app).

Speed on the Pi 5 (NCNN, 640 px): about 230 ms per frame, measured with the generic
yolo11n model. The litter model has not been timed on the Pi yet.

## Try the model on your laptop (no GPU needed)

```
python -m venv venv
venv\Scripts\Activate.ps1        # Windows PowerShell. Mac/Linux: source venv/bin/activate
pip install ultralytics
yolo predict model=models/litter1n.pt source=path/to/photos conf=0.25 save=True
```

Annotated copies are saved under `runs/detect/`. `conf=0.25` shows detections the model is
at least 25% sure about. Raise it to cut false alarms.

## Dataset

Training data is from Roboflow Universe, project `trash-47wtu` (workspace `xyz-te4t6`),
version 1, licence CC BY 4.0. Credit the source if you share results. The URL below comes
from the dataset's own data.yaml; check it still matches the download you used:
https://universe.roboflow.com/xyz-te4t6/trash-47wtu/dataset/1

To retrain, download it in YOLOv8 format into `robo_data/`, copy `data.yaml.example` to
`robo_data/data.yaml`, set the `path:` line to the folder's absolute path (forward
slashes), then run:

```
python train.py --data robo_data/data.yaml --model yolo11n.pt --epochs 50 --single-cls --name litter1n
```

Add `--device 0` to force an NVIDIA GPU. Weights end up in `runs/detect/<name>/weights/best.pt`.
`--single-cls` merges all classes into one.

## Run it on the Raspberry Pi

1. Copy the weights over: `scp models/litter1n.pt <user>@<pi-address>:~/litter1n.pt`
2. On the Pi, with its Python environment active:
   `yolo export model=litter1n.pt format=ncnn imgsz=640`
3. `python detect.py litter1n_ncnn_model`

Notes from setup: use CPU-only PyTorch on the Pi
(`pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu`),
and set `TMPDIR` to a folder on the main drive if pip runs out of space in `/tmp`.

## Never commit

Wi-Fi or hotspot passwords, the Pi password, Roboflow or other API keys, `.env` files,
the `venv/` folder, the dataset, or `runs/`.

## Known limits and next steps

- Trained on public close-up photos. It needs fine-tuning on our own footage from the
  scooter camera (include many frames with no litter, so it learns what is not trash).
- Validation set is tiny, so scores are noisy. Hold out whole stretches of a ride when we
  have our own data.
- The uploader that sends detections to the ScootSense backend is not written yet. It
  depends on the camera API the backend expects.