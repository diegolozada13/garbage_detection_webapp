# Waste detection demo (Next.js + YOLO)

Demo local en Next.js (App Router + TypeScript) que:

- Usa la webcam del navegador (con `react-webcam`) o una imagen subida.
- Captura un frame cada ~700ms (pseudo-tiempo real).
- Envía el frame a `POST /api/detect`.
- `app/api/detect/route.ts` guarda el frame en `tmp/`, llama a `python/detect.py` y devuelve:
  - URL de la imagen anotada con bounding boxes (`/outputs/...`)
  - lista de detecciones (clase + confianza + contenedor recomendado)

## Requisitos

- Node.js + npm
- Python 3.12+
- Un modelo YOLO en `models/best.pt` (no se incluye en git por defecto)

## Instalación (rápido)

```bash
npm install
pip install ultralytics pillow
```

## Ejecutar

```bash
npm run dev
```

Abre http://localhost:3000 y pulsa **Iniciar**.

## Notas

- Los outputs se guardan en `public/outputs/` (y se sirven como `/outputs/...`).
- Para evitar que `public/outputs/` crezca sin límite, la demo reutiliza `public/outputs/annotated-latest.jpg`.
- Los frames y JSON intermedios se guardan en `tmp/`.
- En Windows con PowerShell, si ves un error tipo `npm.ps1 ... running scripts is disabled`, usa `npm.cmd install` / `npm.cmd run dev` (o ejecuta los comandos desde `cmd.exe`).
- Si usas un `venv` dentro de `python/.venv`, actívalo antes de `npm run dev` (o configura `PYTHON` para apuntar al ejecutable correcto, por ejemplo `python\\.venv\\Scripts\\python.exe` en Windows).
