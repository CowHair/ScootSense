"""Preview best_model.pt on a webcam. Frames stay on this computer."""
import argparse
from pathlib import Path
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, default=Path(__file__).with_name('best_model.pt'))
    parser.add_argument('--camera', type=int, default=0, help='Camera index (try 1 for another camera)')
    parser.add_argument('--conf', type=float, default=0.35, help='Minimum detection confidence, 0 to 1')
    parser.add_argument('--imgsz', type=int, default=640, help='Inference image size; try 416 for speed')
    parser.add_argument('--device', default='cpu', help='cpu (default), mps for Apple GPU, or cuda:0')
    args = parser.parse_args()
    if not 0 <= args.conf <= 1 or args.imgsz <= 0:
        parser.error('--conf must be between 0 and 1; --imgsz must be positive')
    if not args.model.is_file():
        parser.error(f'Model not found: {args.model}')
    try:
        import cv2
        from ultralytics import YOLO
    except ImportError:
        parser.exit(1, 'Install dependencies using this Python: python3 -m pip install -r requirements-webcam.txt\n')

    print(f'Loading {args.model.name} on {args.device}…', flush=True)
    model = YOLO(str(args.model))
    print(f'Model classes: {model.names}', flush=True)
    backend = cv2.CAP_AVFOUNDATION if sys.platform == 'darwin' else cv2.CAP_ANY
    camera = cv2.VideoCapture(args.camera, backend)
    window = 'ScootSense · webcam model test · Q to quit'
    try:
        if not camera.isOpened():
            raise RuntimeError('Cannot open webcam. Allow camera access for Terminal/VS Code in System Settings > Privacy & Security > Camera. Try --camera 1 if needed.')
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        cv2.namedWindow(window, cv2.WINDOW_NORMAL)
        print('Webcam active. Press Q or Escape to quit. No frames are saved or uploaded.', flush=True)
        fps = 0.0
        while True:
            started = time.perf_counter()
            ok, frame = camera.read()
            if not ok:
                raise RuntimeError('The webcam stopped providing frames. Check camera permissions or try another camera index.')
            result = model.predict(frame, conf=args.conf, imgsz=args.imgsz, device=args.device, verbose=False)[0]
            preview = result.plot()
            elapsed = time.perf_counter() - started
            instant = 1 / max(elapsed, 1e-6)
            fps = instant if not fps else 0.85 * fps + 0.15 * instant
            count = len(result.boxes) if result.boxes is not None else 0
            label = f'{fps:.1f} FPS | {count} detections | confidence >= {args.conf:.2f} | Q: quit'
            cv2.rectangle(preview, (0, 0), (preview.shape[1], 42), (30, 45, 35), -1)
            cv2.putText(preview, label, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
            cv2.imshow(window, preview)
            if cv2.waitKey(1) & 0xFF in (ord('q'), ord('Q'), 27):
                break
            if cv2.getWindowProperty(window, cv2.WND_PROP_VISIBLE) < 1:
                break
    finally:
        camera.release()
        cv2.destroyAllWindows()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f'Webcam test failed: {error}', file=sys.stderr)
        sys.exit(1)
