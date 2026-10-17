import argparse
 
from ultralytics import YOLO
 
 
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="litter-dataset/data.yaml")
    ap.add_argument("--model", default="yolo11n.pt", help="yolo11n.pt = fastest, yolo11s.pt = a bit more accurate")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default=None, help="0 for first GPU, cpu to force CPU; default = auto")
    ap.add_argument("--name", default="litter")
    ap.add_argument("--single-cls", action="store_true", help="treat every class as one 'litter' class")
    a = ap.parse_args()
 
    model = YOLO(a.model)
    kwargs = dict(
        data=a.data,
        epochs=a.epochs,
        imgsz=a.imgsz,
        batch=a.batch,
        name=a.name,
        patience=15,
        degrees=5,
        exist_ok=True,
    )
    if a.device is not None:
        kwargs["device"] = a.device
    if a.single_cls:
        kwargs["single_cls"] = True
 
    model.train(**kwargs)
 
    metrics = model.val()
    print(f"\nmAP50: {metrics.box.map50:.3f}   mAP50-95: {metrics.box.map:.3f}")
    best = f"{model.trainer.save_dir}/weights/best.pt"
    print(f"Best weights: {best}")
    print(f"Try it:  yolo predict model={best} source=some_road_photo.jpg save=True")
 
 
if __name__ == "__main__":
    main()