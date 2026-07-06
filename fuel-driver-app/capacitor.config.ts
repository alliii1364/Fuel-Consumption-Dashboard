import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.iteck.fueliqdriver',
  appName: 'FuelIQ Driver',
  webDir: 'www',
  server: {
    androidScheme: 'https',
    // Prod talks to the backend over https (https://ifs.itecknologi.com/api).
    // cleartext stays enabled so a LAN http URL (NEXT_PUBLIC_API_URL=http://<ip>:3007)
    // still works for local testing builds.
    cleartext: true,
  },
};

export default config;
