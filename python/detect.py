import contextlib
import json
import os
import sys
from pathlib import Path


CONTAINER_BY_CLASS = {
    "metal": "Amarillo",
    "plastic": "Amarillo",
    "cardboard": "Azul",
    "glass": "Verde",
}

CANONICAL_CLASS_NAME = {
    "metal": "Metal",
    "plastic": "Plastic",
    "cardboard": "Cardboard",
    "glass": "Glass",
}


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def fail(message: str) -> int:
    emit({"success": False, "annotatedImage": "", "detections": [], "error": message})
    return 0


def project_root() -> Path:
    # repo_root/python/detect.py -> repo_root
    return Path(__file__).resolve().parents[1]


def parse_image_path(argv: list[str]) -> Path | None:
    # Required: one image path argument.
    # Optional fallback: accept `--source <path>` (in case caller uses flags).
    if len(argv) >= 2 and not argv[1].startswith("-"):
        return Path(argv[1])

    for i, token in enumerate(argv):
        if token == "--source" and i + 1 < len(argv):
            return Path(argv[i + 1])

    return None


def main() -> int:
    try:
        img_arg = parse_image_path(sys.argv)
        if img_arg is None:
            return fail("Missing image path argument.")

        root = project_root()
        weights_path = root / "models" / "best.pt"
        alt_weights_path = root / "python" / "models" / "best.pt"
        source_path = img_arg.expanduser().resolve()

        outputs_dir = Path(os.environ.get("OUTPUTS_DIR", str(root / "public" / "outputs")))
        outputs_dir = outputs_dir.expanduser().resolve()
        outputs_dir.mkdir(parents=True, exist_ok=True)

        if not weights_path.exists():
            hint = ""
            if alt_weights_path.exists():
                hint = f" Found weights at {alt_weights_path}; move/copy them to {weights_path}."
            return fail(f"Model weights not found: {weights_path}.{hint}")

        if not source_path.exists():
            return fail(f"Image not found: {source_path}")

        # Reuse a stable filename so public/outputs/ does not grow indefinitely.
        annotated_filename = "annotated-latest.jpg"
        annotated_path = outputs_dir / annotated_filename
        annotated_url = f"/outputs/{annotated_filename}"

        detections: list[dict] = []
        ok_out = False

        # Clean up old outputs created by previous runs (best-effort).
        try:
            for p in outputs_dir.glob("annotated-*.jpg"):
                if p.name != annotated_filename:
                    p.unlink(missing_ok=True)
        except Exception:
            pass

        # Ensure *no* stdout/stderr noise from Ultralytics/PyTorch. We'll emit JSON once at the end.
        with open(os.devnull, "w", encoding="utf-8") as devnull, contextlib.redirect_stdout(
            devnull
        ), contextlib.redirect_stderr(devnull):
            from ultralytics import YOLO  # type: ignore
            from PIL import Image  # type: ignore

            model = YOLO(str(weights_path))
            results = model.predict(
                source=str(source_path),
                conf=0.3,
                verbose=False,
                save=False,
                show=False,
            )

            if not results:
                with Image.open(source_path) as img:
                    img.convert("RGB").save(annotated_path, format="JPEG", quality=85)
                ok_out = True
            else:
                r = results[0]

                names = getattr(r, "names", None) or {}
                boxes = getattr(r, "boxes", None)

                if boxes is not None and len(boxes) > 0:
                    cls_ids = boxes.cls.cpu().numpy().astype(int).tolist()
                    confs = boxes.conf.cpu().numpy().astype(float).tolist()

                    for class_id, conf in zip(cls_ids, confs):
                        raw_name = str(names.get(int(class_id), class_id))
                        norm = raw_name.strip().lower()
                        class_name = CANONICAL_CLASS_NAME.get(norm, raw_name)
                        container = CONTAINER_BY_CLASS.get(norm, "Desconocido")
                        detections.append(
                            {
                                "className": class_name,
                                "confidence": float(conf),
                                "container": container,
                            }
                        )

                im_bgr = r.plot()  # BGR-order numpy array
                im_rgb = Image.fromarray(im_bgr[..., ::-1])  # RGB PIL image
                im_rgb.save(annotated_path, format="JPEG", quality=85)
                ok_out = True

        if not ok_out:
            return fail("Failed to write annotated image.")

        emit({"success": True, "annotatedImage": annotated_url, "detections": detections})
        return 0
    except Exception as exc:
        return fail(f"Detection failed: {exc.__class__.__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
