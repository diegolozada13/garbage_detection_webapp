import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 60;

type PythonDetection = {
  className: string;
  confidence: number;
  container: string;
};

type PythonResult = {
  success: boolean;
  annotatedImage?: string;
  detections?: PythonDetection[];
  error?: string;
};

type ApiError = {
  success: false;
  error: string;
  stderr?: string;
};

function extFromMime(mime: string): string | null {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return null;
  }
}

function sanitizeExt(ext: string): string {
  const lower = ext.toLowerCase();
  switch (lower) {
    case ".jpg":
    case ".jpeg":
      return ".jpg";
    case ".png":
      return ".png";
    case ".webp":
      return ".webp";
    default:
      return ".jpg";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(status: number, error: string, extra?: Omit<ApiError, "success" | "error">) {
  return Response.json(
    { success: false, error, ...(extra ?? {}) } satisfies ApiError,
    { status }
  );
}

function normalizeBase64(input: string): string {
  const trimmed = input.trim();
  // Accept base64url too (common in some clients).
  const b64 = trimmed.replace(/[\r\n\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return b64 + pad;
}

function decodeBase64Image(imageBase64: string, mimeType?: string) {
  const dataUrlMatch = imageBase64.match(/^data:([^;,]+);base64,(.*)$/i);
  const effectiveMime = (dataUrlMatch?.[1] ?? mimeType ?? "image/jpeg").toLowerCase();
  const rawBase64 = dataUrlMatch?.[2] ?? imageBase64;

  const normalized = normalizeBase64(rawBase64);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("Invalid base64 string.");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.byteLength === 0) {
    throw new Error("Empty base64 image payload.");
  }

  const ext = extFromMime(effectiveMime) ?? ".jpg";
  return { buffer, ext };
}

async function runPython(
  pythonExe: string,
  args: string[],
  cwd: string,
  envOverrides?: Record<string, string | undefined>,
  timeoutMs = 55_000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { exitCode: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(pythonExe, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1", ...(envOverrides ?? {}) },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      stderr += `\n[route] Python timed out after ${timeoutMs}ms.\n`;
      child.kill();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ exitCode: 1, stdout, stderr: `${stderr}${String(err)}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

    let bytes: Buffer;
    let inputExt = ".jpg";

    const MAX_IMAGE_BYTES = 10_000_000;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const image =
        formData.get("image") ?? formData.get("frame") ?? formData.get("file");

      if (!(image instanceof File)) {
        return jsonError(400, 'Missing form field "image".');
      }

      bytes = Buffer.from(await image.arrayBuffer());
      if (bytes.byteLength === 0) {
        return jsonError(400, "Empty image payload.");
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return jsonError(413, `Image too large (${bytes.byteLength} bytes).`);
      }

      inputExt = sanitizeExt(
        extFromMime(image.type) ?? (path.extname(image.name) || ".jpg")
      );
    } else if (contentType.includes("application/json")) {
      const body = (await request.json()) as unknown;
      if (!isRecord(body)) {
        return jsonError(400, "Invalid JSON body.");
      }

      const imageBase64 = body.imageBase64 ?? body.image;
      if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
        return jsonError(400, 'Missing "imageBase64" (or "image") in JSON body.');
      }

      const mimeType = typeof body.mimeType === "string" ? body.mimeType : undefined;
      const decoded = decodeBase64Image(imageBase64, mimeType);
      bytes = decoded.buffer;
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return jsonError(413, `Image too large (${bytes.byteLength} bytes).`);
      }
      inputExt = sanitizeExt(decoded.ext);
    } else {
      return jsonError(
        415,
        'Unsupported Content-Type. Use "multipart/form-data" or "application/json".'
      );
    }

    const projectRoot = process.cwd();
    const weightsPath = path.join(projectRoot, "models", "best.pt");
    const id = randomUUID();

    const tmpDir = path.join(projectRoot, "tmp");
    const outputsDir = path.join(projectRoot, "public", "outputs");

    await fs.mkdir(tmpDir, { recursive: true });
    await fs.mkdir(outputsDir, { recursive: true });

    // Fail fast with a clear message (Python also checks, but this avoids spawning when misconfigured).
    try {
      await fs.access(weightsPath);
    } catch {
      return jsonError(
        500,
        `Model weights not found at ${weightsPath}. Place your YOLO weights at models/best.pt.`
      );
    }

    const inputPath = path.join(tmpDir, `frame-${id}${inputExt}`);
    const jsonOutPath = path.join(tmpDir, `result-${id}.json`);

    const scriptPath = path.join(projectRoot, "python", "detect.py");
    try {
      await fs.access(scriptPath);
    } catch {
      return jsonError(500, `Python script not found at ${scriptPath}.`);
    }

    await fs.writeFile(inputPath, bytes);

    try {
      const envOverrides = {
        TMP_DIR: tmpDir,
        OUTPUTS_DIR: outputsDir,
        JSON_OUT: jsonOutPath,
      };

      const attempts: Array<{ args: string[]; label: string }> = [
        { label: "positional", args: [scriptPath, inputPath] },
        {
          label: "flags",
          args: [
            scriptPath,
            "--source",
            inputPath,
            "--json-out",
            jsonOutPath,
            "--outputs-dir",
            outputsDir,
          ],
        },
      ];

      const pythonEnv = process.env.PYTHON?.trim();
      const pythonCandidates = [
        pythonEnv && pythonEnv.length > 0 ? pythonEnv : null,
        process.platform === "win32" ? "py" : null,
        "python",
        process.platform === "win32" ? null : "python3",
      ].filter((v): v is string => typeof v === "string" && v.length > 0);

      let last: { exitCode: number; stdout: string; stderr: string } | null = null;
      for (const pythonExe of pythonCandidates) {
        for (const attempt of attempts) {
          last = await runPython(pythonExe, attempt.args, projectRoot, envOverrides);
          if (last.exitCode === 0) break;
          last.stderr += `\n[route] Python invocation failed (${pythonExe}; ${attempt.label}).\n`;
        }
        if (last?.exitCode === 0) break;
      }

      const { exitCode, stdout, stderr } = last ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Python process did not run.",
      };

      if (exitCode !== 0) {
        return jsonError(500, "Python detection failed.", {
          stderr: (stderr || stdout) || undefined,
        });
      }

      const tryParseJson = (text: string): unknown | null => {
        const trimmed = text.trim();
        if (!trimmed) return null;
        try {
          return JSON.parse(trimmed);
        } catch {
          // Try last non-empty line (common when python prints logs + JSON last)
          const lines = trimmed
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              return JSON.parse(lines[i]);
            } catch {
              // keep trying
            }
          }
          return null;
        }
      };

      let parsed: unknown | null = tryParseJson(stdout);
      if (parsed == null) {
        try {
          parsed = JSON.parse(await fs.readFile(jsonOutPath, "utf8"));
        } catch {
          parsed = null;
        }
      }

      if (parsed == null) {
        return jsonError(500, "Python did not return valid JSON.", {
          stderr: stderr || stdout || undefined,
        });
      }

      if (!isRecord(parsed) || typeof parsed.success !== "boolean") {
        return jsonError(500, "Invalid JSON returned by python.", {
          stderr: JSON.stringify(parsed),
        });
      }

      return Response.json(parsed as PythonResult);
    } finally {
      // Best-effort cleanup of temp artifacts.
      await Promise.all([
        fs.unlink(inputPath).catch(() => undefined),
        fs.unlink(jsonOutPath).catch(() => undefined),
      ]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(500, message);
  }
}
