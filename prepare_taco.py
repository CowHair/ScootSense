import argparse
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageOps

CLASSES = ["bottle", "can", "bag", "wrapper", "cup", "other"]

RULES = [
    (r"bottle cap|\bcap\b|\blid\b", "other"),
    (r"bottle", "bottle"),
    (r"\bcan\b|aerosol", "can"),
    (r"bag", "bag"),
    (r"wrapper|packet|film|foil", "wrapper"),
    (r"\bcup\b", "cup"),
]
DEFAULT_CLASS = "other"


def map_category(name: str) -> str:
    n = name.lower()
    for pattern, cls in RULES:
        if re.search(pattern, n):
            return cls
    return DEFAULT_CLASS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--taco", required=True, help="TACO repo folder (must contain data/annotations.json)")
    ap.add_argument("--out", default="litter-dataset", help="output dataset folder")
    ap.add_argument("--val", type=float, default=0.15, help="fraction used for validation")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-size", type=int, default=1280,
                    help="shrink images so the long side is at most this many pixels (speeds up training)")
    a = ap.parse_args()

    data_dir = Path(a.taco) / "data"
    ann_path = data_dir / "annotations.json"
    if not ann_path.exists():
        raise SystemExit(f"Not found: {ann_path}. Did you run TACO's download.py?")

    coco = json.load(open(ann_path, encoding="utf-8"))
    cat_to_class = {c["id"]: map_category(c["name"]) for c in coco["categories"]}
    class_to_idx = {c: i for i, c in enumerate(CLASSES)}

    print("Category mapping (check this looks sensible):")
    for c in sorted(coco["categories"], key=lambda c: cat_to_class[c["id"]]):
        print(f"  {cat_to_class[c['id']]:8s} <- {c['name']}")

    anns_by_image = defaultdict(list)
    for an in coco["annotations"]:
        anns_by_image[an["image_id"]].append(an)

    out = Path(a.out).resolve()
    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)

    images = coco["images"]
    random.Random(a.seed).shuffle(images)
    n_val = max(1, int(len(images) * a.val))

    counts = Counter()
    skipped_missing = skipped_size = written = 0

    for i, im in enumerate(images):
        split = "val" if i < n_val else "train"
        src = data_dir / im["file_name"]
        if not src.exists():
            skipped_missing += 1
            continue

        W, H = im["width"], im["height"]
        raw = Image.open(src)
        fixed = ImageOps.exif_transpose(raw)
        if fixed.size == (W, H):
            img = fixed
        elif raw.size == (W, H):
            img = raw
        else:
            skipped_size += 1
            continue

        img = img.convert("RGB")
        longest = max(img.size)
        if a.max_size and longest > a.max_size:
            scale = a.max_size / longest
            img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)

        stem = im["file_name"].replace("/", "_").rsplit(".", 1)[0]
        img.save(out / "images" / split / f"{stem}.jpg", quality=92)

        lines = []
        for an in anns_by_image[im["id"]]:
            x, y, w, h = an["bbox"]
            if w <= 1 or h <= 1:
                continue
            cx = min(max((x + w / 2) / W, 0.0), 1.0)
            cy = min(max((y + h / 2) / H, 0.0), 1.0)
            nw = min(w / W, 1.0)
            nh = min(h / H, 1.0)
            cls = cat_to_class[an["category_id"]]
            counts[cls] += 1
            lines.append(f"{class_to_idx[cls]} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")

        (out / "labels" / split / f"{stem}.txt").write_text("\n".join(lines))
        written += 1

    yaml = (
        f"path: {out.as_posix()}\n"
        "train: images/train\n"
        "val: images/val\n"
        f"names:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(CLASSES))
    )
    (out / "data.yaml").write_text(yaml)

    print(f"\nWrote {written} images to {out}")
    print(f"Skipped: {skipped_missing} missing files, {skipped_size} with size mismatch")
    print("Boxes per class:", dict(counts))
    print(f"Next: python train.py --data {out / 'data.yaml'}")


if __name__ == "__main__":
    main()
