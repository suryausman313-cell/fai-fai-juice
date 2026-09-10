import { FormEvent, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { customerAuthApi } from '@/lib/customer-auth';
import { useCustomerAuth } from '@/contexts/CustomerAuthContext';

type ScreenMode = 'login' | 'signup' | 'reset';

const DEVICE_ACCOUNT_KEY = 'vita_customer_registered_on_device';
const DEVICE_PHONE_KEY = 'vita_customer_registered_phone';

function normalizePhone(value: string): string {
  return value.trim().replace(/[\s()-]/g, '');
}

function isValidPhone(value: string): boolean {
  const normalized = normalizePhone(value);
  return /^\+?[0-9]{9,15}$/.test(normalized);
}

function isValidPin(value: string): boolean {
  return /^\d{4}$/.test(value);
}

function getErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function rememberDeviceAccount(
  phone: string,
  name = ''
): void {
  localStorage.setItem(DEVICE_ACCOUNT_KEY, '1');
  localStorage.setItem(DEVICE_PHONE_KEY, phone);
  localStorage.setItem('vita_customer_phone', phone);

  if (name.trim()) {
    localStorage.setItem(
      'vita_customer_name',
      name.trim()
    );
  }
}

export default function CustomerAuth() {
  const navigate = useNavigate();
  const location = useLocation();

  const {
    login: loginCustomer,
    signup: signupCustomer,
    logout: logoutCustomer,
  } = useCustomerAuth();

  const registeredOnThisDevice = useMemo(
    () =>
      localStorage.getItem(DEVICE_ACCOUNT_KEY) === '1',
    []
  );

  const rememberedPhone = useMemo(
    () =>
      localStorage.getItem(DEVICE_PHONE_KEY) ||
      localStorage.getItem('vita_customer_phone') ||
      '+971',
    []
  );

  const returnTo = useMemo(() => {
    const requested = new URLSearchParams(location.search).get('next') || '';

    if (
      !requested.startsWith('/') ||
      requested.startsWith('//') ||
      requested.startsWith('/account')
    ) {
      return '/';
    }

    return requested;
  }, [location.search]);

  function continueAfterAuth(): void {
    navigate(returnTo, { replace: true });
  }

  const [mode, setMode] =
    useState<ScreenMode>('login');

  const [loading, setLoading] = useState(false);

  const [loginPhone, setLoginPhone] =
    useState(rememberedPhone);

  const [loginPin, setLoginPin] = useState('');

  const [signupName, setSignupName] = useState('');

  const [signupPhone, setSignupPhone] = useState(
    rememberedPhone === '+971'
      ? '+971'
      : rememberedPhone
  );

  const [signupPin, setSignupPin] = useState('');

  const [
    signupConfirmPin,
    setSignupConfirmPin,
  ] = useState('');

  const [resetPhone, setResetPhone] =
    useState(rememberedPhone);

  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');

  const [
    confirmNewPin,
    setConfirmNewPin,
  ] = useState('');

  async function handleLogin(
    event: FormEvent
  ) {
    event.preventDefault();

    const phone = normalizePhone(loginPhone);

    if (!isValidPhone(phone)) {
      toast.error(
        'Please enter a valid mobile number with country code.'
      );
      return;
    }

    if (!isValidPin(loginPin)) {
      toast.error(
        'PIN must be exactly 4 digits.'
      );
      return;
    }

    setLoading(true);

    try {
      await loginCustomer(phone, loginPin);

      rememberDeviceAccount(phone);

      toast.success('Login successful');

      continueAfterAuth();
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          'Invalid mobile number or PIN.'
        )
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup(
    event: FormEvent
  ) {
    event.preventDefault();

    const name = signupName.trim();
    const phone = normalizePhone(signupPhone);

    if (name.length < 2) {
      toast.error(
        'Please enter your full name.'
      );
      return;
    }

    if (!isValidPhone(phone)) {
      toast.error(
        'Please enter a valid mobile number with country code.'
      );
      return;
    }

    if (!isValidPin(signupPin)) {
      toast.error(
        'PIN must be exactly 4 digits.'
      );
      return;
    }

    if (signupPin !== signupConfirmPin) {
      toast.error(
        'PIN confirmation does not match.'
      );
      return;
    }

    setLoading(true);

    try {
      await signupCustomer(
        name,
        phone,
        signupPin
      );

      rememberDeviceAccount(phone, name);

      toast.success(
        'Account created successfully'
      );

      continueAfterAuth();
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          'Could not create account.'
        )
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPin(
    event: FormEvent
  ) {
    event.preventDefault();

    const phone = normalizePhone(resetPhone);

    if (!isValidPhone(phone)) {
      toast.error(
        'Please enter a valid mobile number with country code.'
      );
      return;
    }

    if (!isValidPin(currentPin)) {
      toast.error(
        'Current PIN must be exactly 4 digits.'
      );
      return;
    }

    if (!isValidPin(newPin)) {
      toast.error(
        'New PIN must be exactly 4 digits.'
      );
      return;
    }

    if (newPin === currentPin) {
      toast.error(
        'New PIN must be different from the current PIN.'
      );
      return;
    }

    if (newPin !== confirmNewPin) {
      toast.error(
        'New PIN confirmation does not match.'
      );
      return;
    }

    setLoading(true);

    try {
      /*
       * First verify the current PIN.
       * On iOS this uses Capacitor native HTTP.
       * Web/Android keep their existing Axios path.
       */
      await loginCustomer(
        phone,
        currentPin
      );

      await customerAuthApi.changePin(
        currentPin,
        newPin
      );

      /*
       * Force a fresh login using the new PIN.
       */
      logoutCustomer();

      rememberDeviceAccount(phone);

      setLoginPhone(phone);
      setLoginPin('');

      setCurrentPin('');
      setNewPin('');
      setConfirmNewPin('');

      setMode('login');

      toast.success(
        'PIN changed successfully. Please login with your new PIN.'
      );
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          'Could not change PIN. Check your current PIN.'
        )
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-black px-4 py-8 text-white">
      <div className="mx-auto w-full max-w-md">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mb-8 flex items-center gap-2 text-sm text-gray-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <div className="mb-9 text-center">
          <h1 className="text-4xl font-black tracking-tight">
            <span className="text-white">
              Vita
            </span>{' '}
            <span className="text-red-600">
              Napoli
            </span>
          </h1>

          <p className="mt-2 text-gray-500">
            Customer Account
          </p>
        </div>

        {mode !== 'reset' &&
          !registeredOnThisDevice && (
            <div className="mb-7 grid grid-cols-2 rounded-xl bg-slate-900 p-1">
              <button
                type="button"
                onClick={() =>
                  setMode('login')
                }
                className={`rounded-lg px-4 py-3 font-semibold transition ${
                  mode === 'login'
                    ? 'bg-red-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                Login
              </button>

              <button
                type="button"
                onClick={() =>
                  setMode('signup')
                }
                className={`rounded-lg px-4 py-3 font-semibold transition ${
                  mode === 'signup'
                    ? 'bg-red-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                Sign Up
              </button>
            </div>
          )}

        {mode === 'login' && (
          <form
            onSubmit={handleLogin}
            className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950 p-6"
          >
            <div>
              <Label
                htmlFor="login-phone"
                className="text-gray-200"
              >
                Mobile Number
              </Label>

              <Input
                id="login-phone"
                inputMode="tel"
                value={loginPhone}
                onChange={(event) =>
                  setLoginPhone(
                    event.target.value
                  )
                }
                placeholder="+971501234567"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-white"
                autoComplete="tel"
              />

              <p className="mt-2 text-xs text-gray-600">
                Include country code, for
                example +971501234567
              </p>
            </div>

            <div>
              <Label
                htmlFor="login-pin"
                className="text-gray-200"
              >
                4-Digit PIN
              </Label>

              <Input
                id="login-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={loginPin}
                onChange={(event) =>
                  setLoginPin(
                    event.target.value
                      .replace(/\D/g, '')
                      .slice(0, 4)
                  )
                }
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
                autoComplete="current-password"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="h-14 w-full bg-red-600 text-lg font-bold hover:bg-red-700"
            >
              {loading
                ? 'Please wait…'
                : 'Login'}
            </Button>

            <button
              type="button"
              onClick={() =>
                setMode('reset')
              }
              className="flex w-full items-center justify-center gap-2 text-sm font-medium text-red-400 hover:text-red-300"
            >
              <KeyRound className="h-4 w-4" />
              Reset / Change PIN
            </button>
          </form>
        )}

        {mode === 'signup' &&
          !registeredOnThisDevice && (
            <form
              onSubmit={handleSignup}
              className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950 p-6"
            >
              <div>
                <Label
                  htmlFor="signup-name"
                  className="text-gray-200"
                >
                  Full Name
                </Label>

                <Input
                  id="signup-name"
                  value={signupName}
                  onChange={(event) =>
                    setSignupName(
                      event.target.value
                    )
                  }
                  placeholder="Your full name"
                  className="mt-2 h-14 border-slate-700 bg-slate-900 text-white"
                  autoComplete="name"
                />
              </div>

              <div>
                <Label
                  htmlFor="signup-phone"
                  className="text-gray-200"
                >
                  Mobile Number
                </Label>

                <Input
                  id="signup-phone"
                  inputMode="tel"
                  value={signupPhone}
                  onChange={(event) =>
                    setSignupPhone(
                      event.target.value
                    )
                  }
                  placeholder="+971501234567"
                  className="mt-2 h-14 border-slate-700 bg-slate-900 text-white"
                  autoComplete="tel"
                />
              </div>

              <div>
                <Label
                  htmlFor="signup-pin"
                  className="text-gray-200"
                >
                  Create 4-Digit PIN
                </Label>

                <Input
                  id="signup-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={signupPin}
                  onChange={(event) =>
                    setSignupPin(
                      event.target.value
                        .replace(/\D/g, '')
                        .slice(0, 4)
                    )
                  }
                  placeholder="••••"
                  className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
                  autoComplete="new-password"
                />
              </div>

              <div>
                <Label
                  htmlFor="signup-confirm-pin"
                  className="text-gray-200"
                >
                  Confirm PIN
                </Label>

                <Input
                  id="signup-confirm-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={signupConfirmPin}
                  onChange={(event) =>
                    setSignupConfirmPin(
                      event.target.value
                        .replace(/\D/g, '')
                        .slice(0, 4)
                    )
                  }
                  placeholder="••••"
                  className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
                  autoComplete="new-password"
                />
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="h-14 w-full bg-red-600 text-lg font-bold hover:bg-red-700"
              >
                {loading
                  ? 'Please wait…'
                  : 'Create Account'}
              </Button>
            </form>
          )}

        {mode === 'reset' && (
          <form
            onSubmit={handleResetPin}
            className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950 p-6"
          >
            <div className="mb-1">
              <h2 className="text-xl font-bold">
                Reset / Change PIN
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                Your current PIN is required
                for security.
              </p>
            </div>

            <div>
              <Label
                htmlFor="reset-phone"
                className="text-gray-200"
              >
                Mobile Number
              </Label>

              <Input
                id="reset-phone"
                inputMode="tel"
                value={resetPhone}
                onChange={(event) =>
                  setResetPhone(
                    event.target.value
                  )
                }
                placeholder="+971501234567"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-white"
                autoComplete="tel"
              />
            </div>

            <div>
              <Label
                htmlFor="current-pin"
                className="text-gray-200"
              >
                Current PIN
              </Label>

              <Input
                id="current-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={currentPin}
                onChange={(event) =>
                  setCurrentPin(
                    event.target.value
                      .replace(/\D/g, '')
                      .slice(0, 4)
                  )
                }
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
              />
            </div>

            <div>
              <Label
                htmlFor="new-pin"
                className="text-gray-200"
              >
                New 4-Digit PIN
              </Label>

              <Input
                id="new-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={newPin}
                onChange={(event) =>
                  setNewPin(
                    event.target.value
                      .replace(/\D/g, '')
                      .slice(0, 4)
                  )
                }
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
              />
            </div>

            <div>
              <Label
                htmlFor="confirm-new-pin"
                className="text-gray-200"
              >
                Confirm New PIN
              </Label>

              <Input
                id="confirm-new-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={confirmNewPin}
                onChange={(event) =>
                  setConfirmNewPin(
                    event.target.value
                      .replace(/\D/g, '')
                      .slice(0, 4)
                  )
                }
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="h-14 w-full bg-red-600 text-lg font-bold hover:bg-red-700"
            >
              {loading
                ? 'Please wait…'
                : 'Save New PIN'}
            </Button>

            <button
              type="button"
              onClick={() =>
                setMode('login')
              }
              className="w-full text-sm font-medium text-gray-400 hover:text-white"
            >
              Back to Login
            </button>
          </form>
        )}

        <p className="mt-8 text-center text-xs text-gray-700">
          Never share your PIN with anyone.
        </p>
      </div>
    </div>
  );
}
