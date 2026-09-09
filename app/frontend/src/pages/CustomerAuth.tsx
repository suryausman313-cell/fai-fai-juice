import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Gift,
  KeyRound,
  LogOut,
  Mail,
  Phone,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { Capacitor } from '@capacitor/core';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { customerAuthApi } from '@/lib/customer-auth';
import { useCustomerAuth } from '@/contexts/CustomerAuthContext';

type ScreenMode = 'choice' | 'login' | 'signup' | 'reset';

const DEVICE_ACCOUNT_KEY = 'vita_customer_registered_on_device';
const DEVICE_PHONE_KEY = 'vita_customer_registered_phone';
const LAST_AUTH_METHOD_KEY = 'vita_customer_last_auth_method';

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

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function rememberDeviceAccount(
  phone: string,
  name = '',
  method: 'phone_pin' | 'google' = 'phone_pin',
): void {
  localStorage.setItem(DEVICE_ACCOUNT_KEY, '1');
  localStorage.setItem(DEVICE_PHONE_KEY, phone);
  localStorage.setItem('vita_customer_phone', phone);
  localStorage.setItem(LAST_AUTH_METHOD_KEY, method);

  if (name.trim()) {
    localStorage.setItem('vita_customer_name', name.trim());
  }
}

function initials(name: string): string {
  const parts = String(name || 'Customer')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  return (parts.map(part => part[0]?.toUpperCase() || '').join('') || 'C');
}

export default function CustomerAuth() {
  const navigate = useNavigate();
  const {
    customer,
    isLoggedIn,
    login: loginCustomer,
    signup: signupCustomer,
    googleLogin: googleLoginCustomer,
    completeGoogleLogin,
    logout: logoutCustomer,
  } = useCustomerAuth();

  const rememberedPhone = useMemo(
    () =>
      localStorage.getItem(DEVICE_PHONE_KEY) ||
      localStorage.getItem('vita_customer_phone') ||
      '+971',
    [],
  );

  const [mode, setMode] = useState<ScreenMode>('choice');
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [loginPhone, setLoginPhone] = useState(rememberedPhone);
  const [loginPin, setLoginPin] = useState('');

  const [signupName, setSignupName] = useState('');
  const [signupPhone, setSignupPhone] = useState(
    rememberedPhone === '+971' ? '+971' : rememberedPhone,
  );
  const [signupPin, setSignupPin] = useState('');
  const [signupConfirmPin, setSignupConfirmPin] = useState('');

  const [resetPhone, setResetPhone] = useState(rememberedPhone);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmNewPin, setConfirmNewPin] = useState('');

  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const googleClientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();
  const isIOSNative =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
  const showGoogleSignIn = Boolean(googleClientId) && !isIOSNative;

  const [googlePending, setGooglePending] = useState<{
    token: string;
    name: string;
    email: string;
  } | null>(null);
  const [googlePhone, setGooglePhone] = useState(
    rememberedPhone === '+971' ? '+971' : rememberedPhone,
  );
  const [googlePin, setGooglePin] = useState('');

  useEffect(() => {
    if (
      isLoggedIn ||
      mode !== 'choice' ||
      googlePending ||
      !showGoogleSignIn
    ) {
      return;
    }

    let cancelled = false;

    const renderGoogleButton = () => {
      if (cancelled || !googleButtonRef.current) return;

      const google = (window as any).google;
      if (!google?.accounts?.id) return;

      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response: { credential?: string }) => {
          const credential = String(response?.credential || '').trim();
          if (!credential) {
            toast.error('Google sign-in was not completed');
            return;
          }

          try {
            const pending = await googleLoginCustomer(credential);

            if (pending) {
              setGooglePending({
                token: pending.google_signup_token,
                name: pending.google_profile.name,
                email: pending.google_profile.email,
              });
              return;
            }

            localStorage.setItem(LAST_AUTH_METHOD_KEY, 'google');
            toast.success('Google sign-in successful');
          } catch (error) {
            toast.error(getErrorMessage(error, 'Google sign-in failed'));
          }
        },
      });

      googleButtonRef.current.innerHTML = '';
      google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        width: 330,
      });
    };

    if ((window as any).google?.accounts?.id) {
      renderGoogleButton();
    } else {
      const existing = document.querySelector<HTMLScriptElement>(
        'script[data-fai-google-signin="1"]',
      );

      if (existing) {
        existing.addEventListener('load', renderGoogleButton, { once: true });
      } else {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.dataset.faiGoogleSignin = '1';
        script.addEventListener('load', renderGoogleButton, { once: true });
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
    };
  }, [googleClientId, googleLoginCustomer, googlePending, isLoggedIn, mode, showGoogleSignIn]);

  function goBack(): void {
    if (googlePending) {
      setGooglePending(null);
      setGooglePin('');
      return;
    }

    if (mode !== 'choice') {
      setMode('choice');
      return;
    }

    navigate('/', { replace: true });
  }

  async function handleGoogleComplete(event: FormEvent) {
    event.preventDefault();
    if (!googlePending) return;

    const phone = normalizePhone(googlePhone);
    if (!isValidPhone(phone)) {
      toast.error('Please enter a valid mobile number with country code.');
      return;
    }
    if (!isValidPin(googlePin)) {
      toast.error('PIN must be exactly 4 digits.');
      return;
    }

    setLoading(true);
    try {
      await completeGoogleLogin(googlePending.token, phone, googlePin);
      rememberDeviceAccount(phone, googlePending.name, 'google');
      setGooglePending(null);
      setGooglePin('');
      toast.success('Google account connected successfully');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Could not finish Google sign-in'));
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    const phone = normalizePhone(loginPhone);

    if (!isValidPhone(phone)) {
      toast.error('Please enter a valid mobile number with country code.');
      return;
    }
    if (!isValidPin(loginPin)) {
      toast.error('PIN must be exactly 4 digits.');
      return;
    }

    setLoading(true);
    try {
      await loginCustomer(phone, loginPin);
      rememberDeviceAccount(phone, '', 'phone_pin');
      setLoginPin('');
      toast.success('Login successful');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Invalid mobile number or PIN.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup(event: FormEvent) {
    event.preventDefault();
    const name = signupName.trim();
    const phone = normalizePhone(signupPhone);

    if (name.length < 2) {
      toast.error('Please enter your full name.');
      return;
    }
    if (!isValidPhone(phone)) {
      toast.error('Please enter a valid mobile number with country code.');
      return;
    }
    if (!isValidPin(signupPin)) {
      toast.error('PIN must be exactly 4 digits.');
      return;
    }
    if (signupPin !== signupConfirmPin) {
      toast.error('PIN confirmation does not match.');
      return;
    }

    setLoading(true);
    try {
      await signupCustomer(name, phone, signupPin);
      rememberDeviceAccount(phone, name, 'phone_pin');
      setSignupPin('');
      setSignupConfirmPin('');
      toast.success('Account created successfully');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Could not create account.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPin(event: FormEvent) {
    event.preventDefault();
    const phone = normalizePhone(resetPhone);

    if (!isValidPhone(phone)) {
      toast.error('Please enter a valid mobile number with country code.');
      return;
    }
    if (!isValidPin(currentPin)) {
      toast.error('Current PIN must be exactly 4 digits.');
      return;
    }
    if (!isValidPin(newPin)) {
      toast.error('New PIN must be exactly 4 digits.');
      return;
    }
    if (newPin === currentPin) {
      toast.error('New PIN must be different from the current PIN.');
      return;
    }
    if (newPin !== confirmNewPin) {
      toast.error('New PIN confirmation does not match.');
      return;
    }

    setLoading(true);
    try {
      await loginCustomer(phone, currentPin);
      await customerAuthApi.changePin(currentPin, newPin);
      logoutCustomer();
      rememberDeviceAccount(phone, '', 'phone_pin');
      setLoginPhone(phone);
      setLoginPin('');
      setCurrentPin('');
      setNewPin('');
      setConfirmNewPin('');
      setMode('login');
      toast.success('PIN changed successfully. Please login with your new PIN.');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Could not change PIN. Check your current PIN.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteAccount() {
    if (deleting) return;

    const confirmed = window.confirm(
      'Permanently delete your Fai Fai account? This cannot be undone.'
    );
    if (!confirmed) return;

    const confirmedAgain = window.confirm(
      'Are you sure? Your login/profile will be deleted and past orders will be anonymized.'
    );
    if (!confirmedAgain) return;

    setDeleting(true);
    try {
      await customerAuthApi.deleteAccount();
      logoutCustomer();
      localStorage.removeItem(DEVICE_ACCOUNT_KEY);
      localStorage.removeItem(DEVICE_PHONE_KEY);
      localStorage.removeItem('vita_customer_phone');
      localStorage.removeItem('vita_customer_name');
      localStorage.removeItem(LAST_AUTH_METHOD_KEY);
      setLoginPhone('+971');
      setSignupPhone('+971');
      setMode('choice');
      setGooglePending(null);
      toast.success('Account deleted');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Could not delete account.'));
    } finally {
      setDeleting(false);
    }
  }

  if (isLoggedIn && customer) {
    const email = String(customer.customer_email || customer.email || '').trim();
    const googleAccount = customer.auth_provider === 'google' || Boolean(customer.email_verified);

    return (
      <div className="min-h-screen bg-black px-4 py-6 pb-28 text-white">
        <div className="mx-auto w-full max-w-md">
          <button
            type="button"
            onClick={() => navigate('/', { replace: true })}
            className="mb-5 flex items-center gap-2 text-sm text-gray-400 transition hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>

          <div className="mb-6 text-center">
            <h1 className="text-3xl font-black tracking-tight">My Account</h1>
            <p className="mt-1 text-sm text-gray-500">Fai Fai Juice</p>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-950 p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-green-600 text-xl font-black text-white">
                {initials(customer.name)}
              </div>
              <div className="min-w-0">
                <p className="truncate text-xl font-bold">{customer.name || 'Customer'}</p>
                <p className="mt-1 text-sm text-gray-400">{customer.phone}</p>
                {googleAccount && email ? (
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-green-900 bg-green-950/50 px-2.5 py-1 text-xs font-semibold text-green-400">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Google verified
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-6 space-y-3 border-t border-slate-800 pt-5">
              <div className="flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3">
                <Phone className="h-5 w-5 text-gray-400" />
                <div className="min-w-0">
                  <p className="text-xs text-gray-500">Mobile number</p>
                  <p className="truncate font-medium text-gray-100">{customer.phone}</p>
                </div>
              </div>

              <div className="flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3">
                <Mail className="h-5 w-5 text-gray-400" />
                <div className="min-w-0">
                  <p className="text-xs text-gray-500">Email</p>
                  <p className="truncate font-medium text-gray-100">
                    {email || 'Not connected'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            <button
              type="button"
              onClick={() => navigate('/my-orders')}
              className="flex w-full items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950 px-5 py-4 text-left transition hover:bg-slate-900"
            >
              <ShoppingBag className="h-5 w-5 text-green-500" />
              <span className="font-semibold">My Orders</span>
            </button>

            <button
              type="button"
              onClick={() => navigate('/rewards')}
              className="flex w-full items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950 px-5 py-4 text-left transition hover:bg-slate-900"
            >
              <Gift className="h-5 w-5 text-green-500" />
              <span className="font-semibold">Rewards</span>
            </button>

            {!googleAccount ? (
              <button
                type="button"
                onClick={() => {
                  setResetPhone(customer.phone || rememberedPhone);
                  setMode('reset');
                  logoutCustomer();
                }}
                className="flex w-full items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950 px-5 py-4 text-left transition hover:bg-slate-900"
              >
                <KeyRound className="h-5 w-5 text-green-500" />
                <span className="font-semibold">Change PIN</span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => {
                logoutCustomer();
                setMode('choice');
                setGooglePending(null);
                setLoginPin('');
                setGooglePin('');
                toast.success('Logged out');
              }}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-red-900/70 bg-red-950/30 px-5 py-4 font-bold text-red-400 transition hover:bg-red-950/50"
            >
              <LogOut className="h-5 w-5" />
              Logout
            </button>

            <button
              type="button"
              onClick={() => void handleDeleteAccount()}
              disabled={deleting}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-red-950 bg-black px-5 py-4 font-semibold text-red-500 transition hover:bg-red-950/30 disabled:opacity-50"
            >
              <Trash2 className="h-5 w-5" />
              {deleting ? 'Deleting…' : 'Delete Account'}
            </button>
          </div>

          <p className="mt-6 text-center text-xs text-gray-700">
            Your account details are kept with your Fai Fai customer account.
          </p>
        </div>
      </div>
    );
  }

  if (googlePending) {
    return (
      <div className="min-h-screen bg-black px-4 py-8 text-white">
        <div className="mx-auto w-full max-w-md">
          <button
            type="button"
            onClick={goBack}
            className="mb-7 flex items-center gap-2 text-sm text-gray-400 transition hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>

          <div className="mb-7 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-950 text-green-400">
              <ShieldCheck className="h-7 w-7" />
            </div>
            <h1 className="mt-4 text-2xl font-black">Google verified</h1>
            <p className="mt-2 text-sm text-gray-400">{googlePending.email}</p>
            <p className="mt-2 text-xs text-gray-600">
              Mobile number aur 4-digit PIN sirf pehli dafa chahiye.
            </p>
          </div>

          <form onSubmit={handleGoogleComplete} className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950 p-6">
            <div>
              <Label htmlFor="google-phone" className="text-gray-200">Mobile Number</Label>
              <Input
                id="google-phone"
                inputMode="tel"
                value={googlePhone}
                onChange={event => setGooglePhone(event.target.value)}
                placeholder="+971501234567"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-white"
                autoComplete="tel"
              />
            </div>

            <div>
              <Label htmlFor="google-pin" className="text-gray-200">4-Digit PIN</Label>
              <Input
                id="google-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={googlePin}
                onChange={event => setGooglePin(event.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
                autoComplete="new-password"
              />
              <p className="mt-2 text-xs text-gray-600">
                Agar is number ka account pehle se hai to us account ka current PIN enter karein.
              </p>
            </div>

            <Button type="submit" disabled={loading} className="h-14 w-full bg-green-600 text-lg font-bold hover:bg-green-700">
              {loading ? 'Please wait…' : 'Continue'}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  if (mode === 'choice') {
    return (
      <div className="min-h-screen bg-black px-4 py-8 text-white">
        <div className="mx-auto flex min-h-[78vh] w-full max-w-md flex-col">
          <button
            type="button"
            onClick={goBack}
            className="mb-8 flex items-center gap-2 self-start text-sm text-gray-400 transition hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>

          <div className="mt-auto text-center">
            <h1 className="text-4xl font-black tracking-tight">
              <span className="text-white">Fai Fai</span>{' '}
              <span className="text-red-600">Juice</span>
            </h1>
            <p className="mt-3 text-gray-400">Welcome!</p>
            <p className="mt-2 text-sm text-gray-600">
              Login or sign up to order, track orders and use rewards.
            </p>
          </div>

          <div className="mb-auto mt-10 space-y-4">
            <button
              type="button"
              onClick={() => setMode('login')}
              className="flex h-14 w-full items-center justify-center gap-3 rounded-full border border-slate-600 bg-white px-5 font-bold text-black transition hover:bg-gray-100"
            >
              <Phone className="h-5 w-5" />
              Continue with phone number
            </button>

            {showGoogleSignIn ? (
              <div className="flex min-h-[56px] w-full items-center justify-center overflow-hidden rounded-full bg-white px-2">
                <div ref={googleButtonRef} className="flex w-full justify-center" />
              </div>
            ) : null}

            {rememberedPhone !== '+971' ? (
              <p className="text-center text-xs text-gray-700">
                Saved number: {rememberedPhone}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black px-4 py-8 text-white">
      <div className="mx-auto w-full max-w-md">
        <button
          type="button"
          onClick={goBack}
          className="mb-8 flex items-center gap-2 text-sm text-gray-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight">
            <span className="text-white">Fai Fai</span>{' '}
            <span className="text-red-600">Juice</span>
          </h1>
          <p className="mt-2 text-gray-500">Customer Account</p>
        </div>

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950 p-6">
            <div>
              <Label htmlFor="login-phone" className="text-gray-200">Mobile Number</Label>
              <Input
                id="login-phone"
                inputMode="tel"
                value={loginPhone}
                onChange={event => setLoginPhone(event.target.value)}
                placeholder="+971501234567"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-white"
                autoComplete="tel"
              />
            </div>

            <div>
              <Label htmlFor="login-pin" className="text-gray-200">4-Digit PIN</Label>
              <Input
                id="login-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={loginPin}
                onChange={event => setLoginPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
                autoComplete="current-password"
              />
            </div>

            <Button type="submit" disabled={loading} className="h-14 w-full bg-green-600 text-lg font-bold hover:bg-green-700">
              {loading ? 'Please wait…' : 'Login'}
            </Button>

            <button
              type="button"
              onClick={() => setMode('signup')}
              className="w-full text-center text-sm font-semibold text-green-400 hover:text-green-300"
            >
              New customer? Create account
            </button>

            <button
              type="button"
              onClick={() => setMode('reset')}
              className="flex w-full items-center justify-center gap-2 text-sm font-medium text-red-400 hover:text-red-300"
            >
              <KeyRound className="h-4 w-4" />
              Reset / Change PIN
            </button>
          </form>
        ) : null}

        {mode === 'signup' ? (
          <form onSubmit={handleSignup} className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950 p-6">
            <div>
              <Label htmlFor="signup-name" className="text-gray-200">Full Name</Label>
              <Input
                id="signup-name"
                value={signupName}
                onChange={event => setSignupName(event.target.value)}
                placeholder="Your full name"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-white"
                autoComplete="name"
              />
            </div>

            <div>
              <Label htmlFor="signup-phone" className="text-gray-200">Mobile Number</Label>
              <Input
                id="signup-phone"
                inputMode="tel"
                value={signupPhone}
                onChange={event => setSignupPhone(event.target.value)}
                placeholder="+971501234567"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-white"
                autoComplete="tel"
              />
            </div>

            <div>
              <Label htmlFor="signup-pin" className="text-gray-200">Create 4-Digit PIN</Label>
              <Input
                id="signup-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={signupPin}
                onChange={event => setSignupPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
                autoComplete="new-password"
              />
            </div>

            <div>
              <Label htmlFor="signup-confirm-pin" className="text-gray-200">Confirm PIN</Label>
              <Input
                id="signup-confirm-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={signupConfirmPin}
                onChange={event => setSignupConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
                autoComplete="new-password"
              />
            </div>

            <Button type="submit" disabled={loading} className="h-14 w-full bg-green-600 text-lg font-bold hover:bg-green-700">
              {loading ? 'Please wait…' : 'Create Account'}
            </Button>

            <button
              type="button"
              onClick={() => setMode('login')}
              className="w-full text-center text-sm font-semibold text-green-400 hover:text-green-300"
            >
              Already have an account? Login
            </button>
          </form>
        ) : null}

        {mode === 'reset' ? (
          <form onSubmit={handleResetPin} className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950 p-6">
            <div>
              <h2 className="text-xl font-bold">Reset / Change PIN</h2>
              <p className="mt-1 text-sm text-gray-500">Your current PIN is required for security.</p>
            </div>

            <div>
              <Label htmlFor="reset-phone" className="text-gray-200">Mobile Number</Label>
              <Input
                id="reset-phone"
                inputMode="tel"
                value={resetPhone}
                onChange={event => setResetPhone(event.target.value)}
                placeholder="+971501234567"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-white"
                autoComplete="tel"
              />
            </div>

            <div>
              <Label htmlFor="current-pin" className="text-gray-200">Current PIN</Label>
              <Input
                id="current-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={currentPin}
                onChange={event => setCurrentPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
              />
            </div>

            <div>
              <Label htmlFor="new-pin" className="text-gray-200">New 4-Digit PIN</Label>
              <Input
                id="new-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={newPin}
                onChange={event => setNewPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
              />
            </div>

            <div>
              <Label htmlFor="confirm-new-pin" className="text-gray-200">Confirm New PIN</Label>
              <Input
                id="confirm-new-pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={confirmNewPin}
                onChange={event => setConfirmNewPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                className="mt-2 h-14 border-slate-700 bg-slate-900 text-center text-xl tracking-[0.7em] text-white"
              />
            </div>

            <Button type="submit" disabled={loading} className="h-14 w-full bg-green-600 text-lg font-bold hover:bg-green-700">
              {loading ? 'Please wait…' : 'Save New PIN'}
            </Button>
          </form>
        ) : null}

        <div className="mt-7 flex items-center justify-center gap-2 text-xs text-gray-700">
          <User className="h-3.5 w-3.5" />
          Your account stays private and secure.
        </div>
      </div>
    </div>
  );
}
