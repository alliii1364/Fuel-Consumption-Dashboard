// Firebase Cloud Messaging registration for the native app. Requests
// permission, registers the device, sends the FCM token to the backend, and
// routes notification taps to the relevant job. No-ops on the web.
import { isNative } from "./index";
import { registerDevice } from "../dispatch";

let initialized = false;

export async function initPush(
  token: string,
  onOpenJob: (jobId: number) => void,
): Promise<void> {
  if (!isNative() || initialized) return;
  initialized = true;

  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");

    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== "granted") return;

    // FCM token arrives via the 'registration' event after register().
    await PushNotifications.addListener("registration", (t: { value: string }) => {
      void registerDevice(token, t.value).catch(() => {});
    });

    await PushNotifications.addListener("pushNotificationActionPerformed", (action: any) => {
      const jobId = action?.notification?.data?.jobId;
      if (jobId) onOpenJob(Number(jobId));
    });

    await PushNotifications.register();
  } catch {
    // Plugin missing or registration failed — push simply stays off.
    initialized = false;
  }
}
