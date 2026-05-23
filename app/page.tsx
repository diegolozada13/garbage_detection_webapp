"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Webcam from "react-webcam";

type Detection = {
  className: string;
  confidence: number;
  container: string;
};

type DetectOk = {
  success: true;
  annotatedImage: string;
  detections: Detection[];
};

type DetectErr = {
  success: false;
  error?: string;
  stderr?: string;
  annotatedImage?: string;
  detections?: Detection[];
};

type DetectResponse = DetectOk | DetectErr;

const INTERVAL_OPTIONS = [500, 700, 1000] as const;
type IntervalMs = (typeof INTERVAL_OPTIONS)[number];

function formatConfidence(confidence: number) {
  const pct = Math.max(0, Math.min(1, confidence)) * 100;
  return `${pct.toFixed(0)}%`;
}

function containerBadgeClasses(container: string) {
  switch (container) {
    case "Amarillo":
      return "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200";
    case "Azul":
      return "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200";
    case "Verde":
      return "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200";
    default:
      return "border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
  }
}

export default function Home() {
  const webcamRef = useRef<Webcam>(null);
  const inFlightRef = useRef(false);

  const [running, setRunning] = useState(false);
  const [intervalMs, setIntervalMs] = useState<IntervalMs>(700);

  const [annotatedImage, setAnnotatedImage] = useState<string | null>(null);
  const [detections, setDetections] = useState<Detection[]>([]);

  const [inFlight, setInFlight] = useState(false);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [stderr, setStderr] = useState<string | null>(null);

  const videoConstraints = useMemo<MediaTrackConstraints>(
    () => ({
      width: 640,
      height: 360,
      facingMode: "environment",
    }),
    []
  );

  const sendFrame = useCallback(async () => {
    if (!running) return;
    if (inFlightRef.current) return;

    const webcam = webcamRef.current;
    if (!webcam) return;

    const dataUrl = webcam.getScreenshot();
    if (!dataUrl) return;

    inFlightRef.current = true;
    setInFlight(true);

    try {
      setError(null);
      setStderr(null);

      const t0 = performance.now();
      const blob = await (await fetch(dataUrl)).blob();

      const formData = new FormData();
      formData.append("image", blob, "frame.jpg");

      const res = await fetch("/api/detect", { method: "POST", body: formData });
      const json = (await res.json()) as DetectResponse;
      const t1 = performance.now();

      setLastLatencyMs(Math.round(t1 - t0));

      if (!res.ok) {
        const message =
          "error" in json && typeof json.error === "string" && json.error.length > 0
            ? json.error
            : `HTTP ${res.status}`;
        setError(message);
        setStderr("stderr" in json && typeof json.stderr === "string" ? json.stderr : null);
        return;
      }

      if (!json.success) {
        setError(json.error ?? "Error de detección.");
        setStderr(json.stderr ?? null);
        return;
      }

      setAnnotatedImage(`${json.annotatedImage}?t=${Date.now()}`);
      setDetections(Array.isArray(json.detections) ? json.detections : []);
      setLastUpdatedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => void sendFrame(), intervalMs);
    return () => window.clearInterval(id);
  }, [running, intervalMs, sendFrame]);

  const status = useMemo(() => {
    if (!running) {
      return {
        label: "Detenido",
        classes:
          "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200",
        dot: "bg-zinc-500",
      };
    }
    if (inFlight) {
      return {
        label: "Detectando...",
        classes:
          "bg-indigo-100 text-indigo-900 dark:bg-indigo-500/10 dark:text-indigo-200",
        dot: "bg-indigo-600 dark:bg-indigo-400",
      };
    }
    if (lastUpdatedAt != null && detections.length === 0) {
      return {
        label: "Sin detecciones",
        classes:
          "bg-amber-100 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200",
        dot: "bg-amber-600 dark:bg-amber-400",
      };
    }
    return {
      label: "Detectando...",
      classes:
        "bg-indigo-100 text-indigo-900 dark:bg-indigo-500/10 dark:text-indigo-200",
      dot: "bg-indigo-600 dark:bg-indigo-400",
    };
  }, [detections.length, inFlight, lastUpdatedAt, running]);

  return (
    <div className="flex flex-1 flex-col bg-gradient-to-b from-zinc-50 to-white font-sans text-zinc-950 dark:from-black dark:to-zinc-950 dark:text-zinc-50">
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white/70 p-5 shadow-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/60 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">
              Detección de residuos reciclables
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Procesa la webcam en pseudo-tiempo real.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${status.classes}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                {status.label}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {lastLatencyMs != null ? `${lastLatencyMs}ms` : "—"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <label
                htmlFor="interval"
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                Intervalo
              </label>
              <select
                id="interval"
                value={intervalMs}
                onChange={(e) => setIntervalMs(Number(e.target.value) as IntervalMs)}
                className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-indigo-500/50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:ring-indigo-400/40"
              >
                {INTERVAL_OPTIONS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms}ms
                  </option>
                ))}
              </select>

              <button
                type="button"
                className={`h-10 rounded-xl px-4 text-sm font-semibold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 dark:focus-visible:ring-indigo-400/40 ${
                  running
                    ? "border border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
                    : "bg-indigo-600 text-white hover:bg-indigo-500"
                }`}
                onClick={() => setRunning((v) => !v)}
              >
                {running ? "Detener" : "Iniciar"}
              </button>
            </div>
          </div>
        </header>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                Webcam en vivo
              </h2>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {running ? `${intervalMs}ms` : "—"}
              </div>
            </div>

            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
              <Webcam
                ref={webcamRef}
                audio={false}
                screenshotFormat="image/jpeg"
                screenshotQuality={0.85}
                videoConstraints={videoConstraints}
                className="h-full w-full object-cover"
                onUserMediaError={(e) =>
                  setError(typeof e === "string" ? e : String(e))
                }
              />

              <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-center justify-between">
                <div className="rounded-full bg-black/60 px-3 py-1 text-xs text-white">
                  {running ? "Capturando" : "Preview"}
                </div>
                <div className="rounded-full bg-black/60 px-3 py-1 text-xs text-white">
                  {inFlight ? "Procesando…" : "Listo"}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                Última imagen procesada
              </h2>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString() : "—"}
              </div>
            </div>

            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-900">
              {annotatedImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={annotatedImage}
                  alt="Imagen anotada con detecciones"
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                  Aún no hay resultados.
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Detecciones y contenedor recomendado
            </h3>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              {detections.length === 0 ? "Sin detecciones" : `${detections.length} detectadas`}
            </div>
          </div>

          {detections.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 p-6 text-center text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              {running ? (
                <div>
                  <div className="font-semibold">Sin detecciones</div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    Mantén el residuo dentro del encuadre para mejorar el resultado.
                  </div>
                </div>
              ) : (
                <div>
                  <div className="font-semibold">Detenido</div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    Pulsa <span className="font-medium">Iniciar</span> para comenzar.
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {detections
                .slice()
                .sort((a, b) => b.confidence - a.confidence)
                .map((d, idx) => (
                  <div
                    key={`${d.className}-${idx}`}
                    className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold">
                          {d.className}
                        </div>
                        <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                          Confianza:{" "}
                          <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                            {formatConfidence(d.confidence)}
                          </span>
                        </div>
                      </div>

                      <span
                        className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${containerBadgeClasses(
                          d.container
                        )}`}
                      >
                        {d.container}
                      </span>
                    </div>

                    <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
                      Contenedor recomendado
                    </div>
                  </div>
                ))}
            </div>
          )}
        </section>

        {(error || stderr) && (
          <section className="rounded-2xl border border-red-200 bg-red-50 p-4 text-red-950 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-50">
            <div className="text-sm font-semibold">Error</div>
            {error && <div className="mt-1 text-sm">{error}</div>}
            {stderr && (
              <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-black/10 p-3 text-xs dark:bg-black/30">
                {stderr}
              </pre>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
