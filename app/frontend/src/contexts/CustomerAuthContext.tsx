import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  Customer,
  GoogleLoginPending,
  customerAuthApi,
} from '../lib/customer-auth';

interface CustomerAuthContextType {
  customer: Customer | null;
  loading: boolean;
  error: string | null;
  isLoggedIn: boolean;
  signup: (
    name: string,
    phone: string,
    pin: string
  ) => Promise<void>;
  login: (
    phone: string,
    pin: string
  ) => Promise<void>;
  googleLogin: (
    credential: string
  ) => Promise<GoogleLoginPending | null>;
  completeGoogleLogin: (
    signupToken: string,
    phone: string,
    pin: string
  ) => Promise<void>;
  logout: () => void;
  refreshCustomer: () => Promise<void>;
  clearError: () => void;
}

const CustomerAuthContext =
  createContext<CustomerAuthContextType | null>(null);

export function useCustomerAuth() {
  const context = useContext(CustomerAuthContext);

  if (!context) {
    throw new Error(
      'useCustomerAuth must be used inside CustomerAuthProvider'
    );
  }

  return context;
}

interface CustomerAuthProviderProps {
  children: ReactNode;
}

export function CustomerAuthProvider({
  children,
}: CustomerAuthProviderProps) {
  const [customer, setCustomer] =
    useState<Customer | null>(() =>
      customerAuthApi.getSavedCustomer()
    );

  // A saved customer can be shown immediately. Verify the token in the
  // background instead of blocking the whole app behind a spinner.
  const [loading, setLoading] = useState(() =>
    !customerAuthApi.getSavedCustomer() && Boolean(customerAuthApi.getToken())
  );
  const [error, setError] =
    useState<string | null>(null);

  const refreshCustomer = async () => {
    try {
      // Only block when there is no locally saved customer. Returning users
      // can open the home screen immediately while the session is verified.
      if (!customerAuthApi.getSavedCustomer()) {
        setLoading(true);
      }
      setError(null);

      const currentCustomer =
        await customerAuthApi.getCurrentCustomer();

      setCustomer(currentCustomer);
    } catch (err) {
      // Safari/iPhone can briefly fail the session refresh after login or reload.
      // Keep a valid locally saved customer/token for temporary browser/network errors.
      const savedCustomer = customerAuthApi.getSavedCustomer();
      const savedToken = customerAuthApi.getToken();

      if (savedCustomer && savedToken) {
        setCustomer(savedCustomer);
      } else {
        setCustomer(null);
      }

      setError(
        err instanceof Error
          ? err.message
          : 'Unable to check login'
      );
    } finally {
      setLoading(false);
    }
  };

  const signup = async (
    name: string,
    phone: string,
    pin: string
  ) => {
    try {
      setLoading(true);
      setError(null);

      const newCustomer =
        await customerAuthApi.signup(
          name,
          phone,
          pin
        );

      setCustomer(newCustomer);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Sign up failed';

      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  const login = async (
    phone: string,
    pin: string
  ) => {
    try {
      setLoading(true);
      setError(null);

      const loggedInCustomer =
        await customerAuthApi.login(phone, pin);

      setCustomer(loggedInCustomer);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Login failed';

      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };


  const googleLogin = async (
    credential: string
  ): Promise<GoogleLoginPending | null> => {
    try {
      setLoading(true);
      setError(null);

      const result = await customerAuthApi.googleLogin(credential);

      if ('needs_phone' in result && result.needs_phone) {
        return result;
      }

      setCustomer(result as Customer);
      return null;
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Google sign-in failed';
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  const completeGoogleLogin = async (
    signupToken: string,
    phone: string,
    pin: string
  ) => {
    try {
      setLoading(true);
      setError(null);
      const linkedCustomer =
        await customerAuthApi.completeGoogleLogin(
          signupToken,
          phone,
          pin
        );
      setCustomer(linkedCustomer);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Could not finish Google sign-in';
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    customerAuthApi.logout();
    setCustomer(null);
    setError(null);
  };

  const clearError = () => {
    setError(null);
  };

  useEffect(() => {
    if (customerAuthApi.getToken()) {
      void refreshCustomer();
    } else {
      setLoading(false);
    }

    const handleAuthChange = () => {
      void refreshCustomer();
    };

    window.addEventListener(
      'customer-auth-changed',
      handleAuthChange
    );

    return () => {
      window.removeEventListener(
        'customer-auth-changed',
        handleAuthChange
      );
    };
  }, []);

  const value = useMemo(
    () => ({
      customer,
      loading,
      error,
      isLoggedIn: Boolean(customer),
      signup,
      login,
      googleLogin,
      completeGoogleLogin,
      logout,
      refreshCustomer,
      clearError,
    }),
    [customer, loading, error]
  );

  return (
    <CustomerAuthContext.Provider value={value}>
      {children}
    </CustomerAuthContext.Provider>
  );
}
