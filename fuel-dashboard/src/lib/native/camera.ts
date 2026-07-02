// Capture a photo for proof-of-delivery. Uses the native camera in the app,
// and a file picker (camera capture on mobile browsers) on the web. The
// captured image is always downscaled + re-encoded to JPEG before upload so
// the payload stays small (avoids 413s behind reverse proxies and saves the
// driver's mobile data).
import { isNative } from "./index";

export interface CapturedPhoto {
  blob: Blob;
  filename: string;
}

export async function capturePhoto(): Promise<CapturedPhoto | null> {
  const raw = await captureRawPhoto();
  if (!raw) return null;
  const blob = await compressImage(raw.blob);
  const filename = raw.filename.replace(/\.[^./\\]+$/, "") + ".jpg";
  return { blob, filename };
}

async function captureRawPhoto(): Promise<CapturedPhoto | null> {
  if (isNative()) {
    try {
      const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
      const photo = await Camera.getPhoto({
        quality: 70,
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
        saveToGallery: false,
      });
      if (!photo.webPath) return null;
      const res = await fetch(photo.webPath);
      const blob = await res.blob();
      return { blob, filename: `pod.${photo.format || "jpg"}` };
    } catch {
      return null;
    }
  }

  // Web fallback: open a file input (prefers the rear camera on phones).
  return new Promise<CapturedPhoto | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = "environment";
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? { blob: file, filename: file.name } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Downscale to at most `maxDim` on the long edge and re-encode as JPEG. A phone
 * photo (2–8 MB) becomes ~150–400 KB. Falls back to the original blob if the
 * browser can't decode/encode (older WebViews) or the result isn't smaller.
 */
async function compressImage(blob: Blob, maxDim = 1600, quality = 0.72): Promise<Blob> {
  try {
    if (typeof document === "undefined" || typeof createImageBitmap !== "function") return blob;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const out = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", quality),
    );
    return out && out.size < blob.size ? out : blob;
  } catch {
    return blob;
  }
}
