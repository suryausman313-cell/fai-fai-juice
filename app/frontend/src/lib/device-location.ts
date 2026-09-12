import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

export type DeviceLocation = {
  latitude: number;
  longitude: number;
};

export class DeviceLocationError extends Error {
  code: 'unsupported' | 'permission-denied' | 'unavailable' | 'timeout';

  constructor(
    code: 'unsupported' | 'permission-denied' | 'unavailable' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'DeviceLocationError';
    this.code = code;
  }
}

function normalizeLocationError(error: any): DeviceLocationError {
  if (error instanceof DeviceLocationError) return error;

  const message = String(error?.message || error || 'Current location is unavailable.');
  if (/denied|permission|not authorized|not authorised|authorization/i.test(message)) {
    return new DeviceLocationError('permission-denied', message);
  }
  if (/timeout|timed out/i.test(message)) {
    return new DeviceLocationError('timeout', message);
  }
  if (/not supported|unsupported/i.test(message)) {
    return new DeviceLocationError('unsupported', message);
  }
  return new DeviceLocationError('unavailable', message);
}

function browserLocation(timeout: number, maximumAge: number): Promise<DeviceLocation> {
  if (!navigator.geolocation) {
    return Promise.reject(
      new DeviceLocationError('unsupported', 'Location is not supported on this device.'),
    );
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          reject(new DeviceLocationError('permission-denied', 'Location permission was denied.'));
          return;
        }
        if (error.code === error.TIMEOUT) {
          reject(new DeviceLocationError('timeout', 'Location request timed out.'));
          return;
        }
        reject(new DeviceLocationError('unavailable', 'Current location is unavailable.'));
      },
      { enableHighAccuracy: true, timeout, maximumAge },
    );
  });
}

async function nativeIOSLocation(timeout: number, maximumAge: number): Promise<DeviceLocation> {
  // If the native plugin was not included for any reason, fall back to the
  // WebView geolocation path instead of failing silently.
  if (!Capacitor.isPluginAvailable('Geolocation')) {
    return browserLocation(timeout, maximumAge);
  }

  try {
    // requestPermissions() is intentional here: on first use it triggers the
    // native iOS Allow Location dialog. If permission was already granted,
    // iOS returns immediately without showing another dialog.
    let permission = await Geolocation.requestPermissions();

    const nowGranted =
      permission.location === 'granted' ||
      permission.coarseLocation === 'granted';

    if (!nowGranted) {
      throw new DeviceLocationError(
        'permission-denied',
        'Location permission was denied.',
      );
    }

    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout,
      maximumAge,
    });

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };
  } catch (error: any) {
    const normalized = normalizeLocationError(error);

    // If the plugin is unavailable/broken at runtime, the WKWebView location
    // API can still trigger the iOS permission flow and return the position.
    // Do not bypass a real user denial.
    if (normalized.code !== 'permission-denied') {
      try {
        return await browserLocation(timeout, maximumAge);
      } catch (fallbackError: any) {
        throw normalizeLocationError(fallbackError);
      }
    }

    throw normalized;
  }
}

export async function getCurrentDeviceLocation(options?: {
  timeout?: number;
  maximumAge?: number;
}): Promise<DeviceLocation> {
  const timeout = options?.timeout ?? 20000;
  const maximumAge = options?.maximumAge ?? 0;

  const isIOSNative =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

  if (isIOSNative) {
    return nativeIOSLocation(timeout, maximumAge);
  }

  // Keep Android/Web behaviour unchanged.
  return browserLocation(timeout, maximumAge);
}
