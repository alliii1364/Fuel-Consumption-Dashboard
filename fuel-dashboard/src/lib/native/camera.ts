// Capture a photo for proof-of-delivery. Uses the native camera in the app,
// and a file picker (camera capture on mobile browsers) on the web.
import { isNative } from "./index";

export interface CapturedPhoto {
  blob: Blob;
  filename: string;
}

export async function capturePhoto(): Promise<CapturedPhoto | null> {
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
