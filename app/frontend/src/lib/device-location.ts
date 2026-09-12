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

export async function getCurrentDeviceLocation(options?: {
  timeout?: number;
  maximumAge?: number;
}): Promise<DeviceLocation> {
  const timeout = options?.timeout ?? 15000;
  const maximumAge = options?.maximumAge ?? 0;

  const isIOSNative =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

  // Keep existing Android/Web behaviour unchanged.
  if (!isIOSNative) {
    return browserLocation(timeout, maximumAge);
  }

  try {
    // On a fresh install this causes iOS to show the native
    // “Allow While Using App” permission dialog.
    let permission = await Geolocation.checkPermissions();

    if (permission.location !== 'granted') {
      permission = await Geolocation.requestPermissions({ permissions: ['location'] });
    }

    if (permission.location !== 'granted') {
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
    if (error instanceof DeviceLocationError) throw error;

    const message = String(error?.message || 'Current location is unavailable.');
    if (/denied|permission|not authorized/i.test(message)) {
      throw new DeviceLocationError('permission-denied', message);
    }
    if (/timeout/i.test(message)) {
      throw new DeviceLocationError('timeout', message);
    }
    throw new DeviceLocationError('unavailable', message);
  }
}
