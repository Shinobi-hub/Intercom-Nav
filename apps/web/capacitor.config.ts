import type { CapacitorConfig } from '@capacitor/cli';

/**
 * INTERCOM_DEV_CLEARTEXT=1 lets a development build reach a plain-HTTP ride server, such as the
 * Android emulator's http://10.0.2.2:8791. It allows cleartext traffic in the Android manifest
 * (written at `npx cap sync`) and mixed content in the https://localhost WebView. Leave it unset
 * for release builds, which must use an https:// VITE_SERVER_URL; run `npx cap sync` without it
 * before building a release so the manifest flag is removed again.
 */
const devCleartext = process.env.INTERCOM_DEV_CLEARTEXT === '1';

const config: CapacitorConfig = {
  // Placeholder bundle id: replace it with a reverse-DNS id you own before shipping (docs/NATIVE.md).
  appId: 'app.intercomnav',
  appName: 'Intercom Nav',
  webDir: 'dist',
  backgroundColor: '#0B0D10',
  server: {
    androidScheme: 'https',
    ...(devCleartext ? { cleartext: true } : {}),
  },
  android: {
    allowMixedContent: devCleartext,
  },
  ios: {
    // @capacitor-community/background-geolocation is vendored into the iOS app target instead
    // (ios/App/App/BackgroundGeolocationPlugin.swift): its Package.swift only accepts Capacitor 7,
    // which Swift Package Manager can't resolve next to Capacitor 8. Add new plugins here too.
    includePlugins: [
      '@capacitor-community/keep-awake',
      '@capacitor/app',
      '@capacitor/haptics',
      '@capacitor/local-notifications',
    ],
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_ride',
      iconColor: '#3D9BFF',
    },
  },
};

export default config;
