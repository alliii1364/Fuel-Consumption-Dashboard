import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.iteck.fueliqdriver',
  appName: 'FuelIQ Driver',
  webDir: 'www',
  server: {
    androidScheme: 'https',
    // The driver app talks to the backend over the LAN during testing (http).
    // Allow cleartext so http://<lan-ip>:3007 works; switch to https in prod.
    cleartext: true,
  },
};

export default config;
