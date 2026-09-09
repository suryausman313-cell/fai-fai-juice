import axios from 'axios';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { getAPIBaseURL } from './config';

export interface Customer {
  id: number;
  name: string;
  phone: string;
  is_active: boolean;
  created_at: string;
  last_login?: string | null;
  email?: string | null;
  customer_email?: string | null;
  email_verified?: boolean;
  auth_provider?: 'phone_pin' | 'google';
}

export interface GoogleLoginPending {
  needs_phone: true;
  google_signup_token: string;
  google_profile: {
    name: string;
    email: string;
  };
}

interface AuthResponse {
  token?: string;
  access_token?: string;
  token_type?: string;
  customer: Customer;
  needs_phone?: false;
}

type GoogleLoginResponse = AuthResponse | GoogleLoginPending;

const TOKEN_KEY = 'vita_customer_token';
const CUSTOMER_KEY = 'vita_customer';

const api = axios.create({
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

function isIOSNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

function getToken(): string | null {
  return (
    localStorage.getItem(TOKEN_KEY) ||
    sessionStorage.getItem(TOKEN_KEY)
  );
}

function getAuthHeaders(): Record<string, string> {
  const token = getToken();

  if (!token) {
    return {};
  }

  return {
    Authorization: `Bearer ${token}`,
  };
}

function saveSession(data: AuthResponse): void {
  const token = String(
    data.access_token || data.token || ''
  ).trim();

  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(TOKEN_KEY, token);
  }

  if (data.customer) {
    const customer = JSON.stringify(data.customer);

    localStorage.setItem(CUSTOMER_KEY, customer);
    sessionStorage.setItem(CUSTOMER_KEY, customer);
  }
}

function clearSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(CUSTOMER_KEY);

  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(CUSTOMER_KEY);
}

function extractErrorMessage(
  data: any,
  fallback: string
): string {
  if (typeof data?.detail === 'string') {
    return data.detail;
  }

  if (typeof data?.message === 'string') {
    return data.message;
  }

  return fallback;
}

function getAxiosErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail;
    const message = error.response?.data?.message;

    if (typeof detail === 'string') {
      return detail;
    }

    if (typeof message === 'string') {
      return message;
    }

    if (error.message) {
      return error.message;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

/*
 * IMPORTANT:
 * iOS native app uses CapacitorHttp directly.
 * Website and Android keep using the existing Axios flow.
 */
async function iosPost<T>(
  path: string,
  data: Record<string, unknown>,
  token?: string
): Promise<T> {
  const response = await CapacitorHttp.post({
    url: `${getAPIBaseURL()}${path}`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token
        ? { Authorization: `Bearer ${token}` }
        : {}),
    },
    data,
    connectTimeout: 30000,
    readTimeout: 30000,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      extractErrorMessage(
        response.data,
        `Request failed (${response.status})`
      )
    );
  }

  return response.data as T;
}

async function iosGet<T>(
  path: string,
  token: string
): Promise<T> {
  const response = await CapacitorHttp.get({
    url: `${getAPIBaseURL()}${path}`,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    connectTimeout: 30000,
    readTimeout: 30000,
  });

  if (response.status === 401 || response.status === 403) {
    clearSession();
    throw new Error('Session expired');
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      extractErrorMessage(
        response.data,
        `Request failed (${response.status})`
      )
    );
  }

  return response.data as T;
}

async function iosDelete<T>(
  path: string,
  token: string
): Promise<T> {
  const response = await CapacitorHttp.delete({
    url: `${getAPIBaseURL()}${path}`,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    connectTimeout: 30000,
    readTimeout: 30000,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      extractErrorMessage(
        response.data,
        `Request failed (${response.status})`
      )
    );
  }

  return response.data as T;
}

export const customerAuthApi = {
  async signup(
    name: string,
    phone: string,
    pin: string
  ): Promise<Customer> {
    try {
      let data: AuthResponse;

      if (isIOSNative()) {
        data = await iosPost<AuthResponse>(
          '/api/v1/customer-auth/signup',
          {
            name,
            phone,
            pin,
          }
        );
      } else {
        const response = await api.post<AuthResponse>(
          `${getAPIBaseURL()}/api/v1/customer-auth/signup`,
          {
            name,
            phone,
            pin,
          }
        );

        data = response.data;
      }

      saveSession(data);

      return data.customer;
    } catch (error) {
      throw new Error(
        getAxiosErrorMessage(error, 'Sign up failed')
      );
    }
  },

  async login(
    phone: string,
    pin: string
  ): Promise<Customer> {
    try {
      let data: AuthResponse;

      if (isIOSNative()) {
        data = await iosPost<AuthResponse>(
          '/api/v1/customer-auth/login',
          {
            phone,
            pin,
          }
        );
      } else {
        const response = await api.post<AuthResponse>(
          `${getAPIBaseURL()}/api/v1/customer-auth/login`,
          {
            phone,
            pin,
          }
        );

        data = response.data;
      }

      saveSession(data);

      return data.customer;
    } catch (error) {
      throw new Error(
        getAxiosErrorMessage(error, 'Login failed')
      );
    }
  },


  async googleLogin(credential: string): Promise<Customer | GoogleLoginPending> {
    try {
      let data: GoogleLoginResponse;

      if (isIOSNative()) {
        data = await iosPost<GoogleLoginResponse>(
          '/api/v1/customer-auth/google-login',
          { credential }
        );
      } else {
        const response = await api.post<GoogleLoginResponse>(
          `${getAPIBaseURL()}/api/v1/customer-auth/google-login`,
          { credential }
        );
        data = response.data;
      }

      if ('needs_phone' in data && data.needs_phone) {
        return data;
      }

      saveSession(data as AuthResponse);
      return (data as AuthResponse).customer;
    } catch (error) {
      throw new Error(
        getAxiosErrorMessage(error, 'Google sign-in failed')
      );
    }
  },

  async completeGoogleLogin(
    signupToken: string,
    phone: string,
    pin: string
  ): Promise<Customer> {
    try {
      let data: AuthResponse;
      const payload = {
        signup_token: signupToken,
        phone,
        pin,
      };

      if (isIOSNative()) {
        data = await iosPost<AuthResponse>(
          '/api/v1/customer-auth/google-complete',
          payload
        );
      } else {
        const response = await api.post<AuthResponse>(
          `${getAPIBaseURL()}/api/v1/customer-auth/google-complete`,
          payload
        );
        data = response.data;
      }

      saveSession(data);
      return data.customer;
    } catch (error) {
      throw new Error(
        getAxiosErrorMessage(error, 'Could not finish Google sign-in')
      );
    }
  },

  async getCurrentCustomer(): Promise<Customer | null> {
    const token = getToken();

    if (!token) {
      clearSession();
      return null;
    }

    try {
      let data: AuthResponse;

      if (isIOSNative()) {
        data = await iosGet<AuthResponse>(
          '/api/v1/customer-auth/me',
          token
        );
      } else {
        const response = await api.get<AuthResponse>(
          `${getAPIBaseURL()}/api/v1/customer-auth/me`,
          {
            headers: getAuthHeaders(),
          }
        );

        data = response.data;
      }

      saveSession(data);

      return data.customer;
    } catch (error) {
      /*
       * On web/Android only clear session when server explicitly
       * rejects the token.
       */
      if (!isIOSNative() && axios.isAxiosError(error)) {
        const status = error.response?.status;

        if (status === 401 || status === 403) {
          clearSession();
          return null;
        }
      }

      /*
       * iOS iosGet() already clears the session for 401/403.
       * Temporary network errors should not destroy a saved login.
       */
      throw error;
    }
  },

  async changePin(
    oldPin: string,
    newPin: string
  ) {
    const token = getToken();

    if (!token) {
      throw new Error('Please login again');
    }

    try {
      if (isIOSNative()) {
        return await iosPost<any>(
          '/api/v1/customer-auth/change-pin',
          {
            old_pin: oldPin,
            current_pin: oldPin,
            new_pin: newPin,
          },
          token
        );
      }

      const response = await api.post(
        `${getAPIBaseURL()}/api/v1/customer-auth/change-pin`,
        {
          old_pin: oldPin,
          current_pin: oldPin,
          new_pin: newPin,
        },
        {
          headers: getAuthHeaders(),
        }
      );

      return response.data;
    } catch (error) {
      throw new Error(
        getAxiosErrorMessage(error, 'PIN change failed')
      );
    }
  },

  async deleteAccount(): Promise<void> {
    const token = getToken();

    if (!token) {
      throw new Error('Please login again');
    }

    try {
      if (isIOSNative()) {
        await iosDelete<any>(
          '/api/v1/customer-auth/delete-account',
          token
        );
      } else {
        await api.delete(
          `${getAPIBaseURL()}/api/v1/customer-auth/delete-account`,
          { headers: getAuthHeaders() }
        );
      }

      clearSession();
    } catch (error) {
      throw new Error(
        getAxiosErrorMessage(error, 'Account deletion failed')
      );
    }
  },

  getSavedCustomer(): Customer | null {
    const saved =
      localStorage.getItem(CUSTOMER_KEY) ||
      sessionStorage.getItem(CUSTOMER_KEY);

    if (!saved) {
      return null;
    }

    try {
      return JSON.parse(saved) as Customer;
    } catch {
      clearSession();
      return null;
    }
  },

  getToken(): string | null {
    return getToken();
  },

  logout(): void {
    clearSession();
  },
};
