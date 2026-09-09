import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Clock,
  KeyRound,
  LockKeyhole,
  MessageCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getAPIBaseURL } from '@/lib/config';

interface Customer {
  id: number;
  customer_name: string;
  customer_phone: string;
  phone: string;
  phone_verified: boolean;
  customer_email?: string | null;
  email?: string | null;
  email_verified?: boolean;
  auth_provider?: 'phone_pin' | 'google';
  google_verified?: boolean;
  is_locked: boolean;
  locked_until?: string | null;
  failed_login_attempts: number;
  last_login_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  first_seen?: string | null;
  last_active?: string | null;
  last_order_date?: string | null;
  is_online: boolean;
  is_guest: boolean;
  total_orders: number;
  total_spent: number;
}

interface ResetResult {
  customerName: string;
  phone: string;
  pin: string;
}

type FilterStatus = 'all' | 'online' | 'offline';

const SECURITY_KEY_STORAGE =
  'fai_fai_customer_admin_key_v3_session';

const API_PREFIX =
  '/api/v1/fai-fai-customer-admin-v3';

function apiBase(): string {
  return getAPIBaseURL().replace(/\/$/, '');
}

function storedSecurityKey(): string {
  return sessionStorage.getItem(SECURITY_KEY_STORAGE) || '';
}

function saveSecurityKey(value: string): void {
  sessionStorage.setItem(SECURITY_KEY_STORAGE, value);
}

function clearSecurityKey(): void {
  sessionStorage.removeItem(SECURITY_KEY_STORAGE);
}

async function requestV3<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    data?: unknown;
    key?: string;
  } = {},
): Promise<T> {
  const method = options.method || 'GET';
  const key = options.key ?? storedSecurityKey();

  const response = await fetch(
    `${apiBase()}${API_PREFIX}${path}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(key
          ? { 'X-Fai-Fai-Admin-Key': key }
          : {}),
      },
      body:
        method === 'POST'
          ? JSON.stringify(options.data || {})
          : undefined,
    },
  );

  const raw = await response.text();
  let data: any = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    const error = new Error(
      data?.detail ||
        data?.message ||
        `Request failed (${response.status})`,
    ) as Error & { status?: number };

    error.status = response.status;
    throw error;
  }

  return data as T;
}

function errorText(error: any, fallback: string): string {
  return error?.message || fallback;
}

function whatsappNumber(phone: string): string {
  return String(phone || '').replace(/\D/g, '');
}

export default function AdminCustomers() {
  const navigate = useNavigate();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] =
    useState<FilterStatus>('all');

  const [unlockOpen, setUnlockOpen] = useState(false);
  const [securityKeyInput, setSecurityKeyInput] = useState('');
  const [verifying, setVerifying] = useState(false);

  const [resetCustomer, setResetCustomer] =
    useState<Customer | null>(null);
  const [newPin, setNewPin] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] =
    useState<ResetResult | null>(null);

  const visibleCustomers = useMemo(() => {
    const query = search.trim().toLowerCase();

    return customers.filter(customer => {
      const matchesSearch =
        !query ||
        customer.customer_name
          .toLowerCase()
          .includes(query) ||
        customer.customer_phone
          .toLowerCase()
          .includes(query);

      const matchesStatus =
        filterStatus === 'all' ||
        (filterStatus === 'online' &&
          customer.is_online) ||
        (filterStatus === 'offline' &&
          !customer.is_online);

      return matchesSearch && matchesStatus;
    });
  }, [customers, filterStatus, search]);

  const onlineCount = customers.filter(
    customer => customer.is_online,
  ).length;

  const loadCustomers = useCallback(
    async (silent = false) => {
      const key = storedSecurityKey();

      if (!key) {
        setLoading(false);
        setUnlockOpen(true);
        return;
      }

      if (!silent) setRefreshing(true);

      try {
        const result = await requestV3<{
          items: Customer[];
          total: number;
          online_count: number;
        }>('/customers');

        setCustomers(result.items || []);
        setUnlockOpen(false);
      } catch (error: any) {
        console.error('Customer V3 load failed:', error);

        if (error?.status === 401) {
          clearSecurityKey();
          setCustomers([]);
          setUnlockOpen(true);
          toast.error(
            errorText(
              error,
              'Enter the Admin Security Key again',
            ),
          );
        } else {
          toast.error(
            errorText(
              error,
              'Could not load registered customers',
            ),
          );
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    const rawAdmin = localStorage.getItem('admin_auth');

    if (!rawAdmin) {
      navigate('/admin');
      return;
    }

    try {
      const admin = JSON.parse(rawAdmin);
      if (!admin.loggedIn) {
        navigate('/admin');
        return;
      }
    } catch {
      navigate('/admin');
      return;
    }

    void loadCustomers();
  }, [loadCustomers, navigate]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (storedSecurityKey()) {
        void loadCustomers(true);
      }
    }, 30000);

    return () => window.clearInterval(interval);
  }, [loadCustomers]);

  async function unlockCustomerManagement() {
    const key = securityKeyInput.trim();

    if (key.length < 8) {
      toast.error(
        'Render ki FAI_FAI_SETTINGS_KEY value enter karo',
      );
      return;
    }

    setVerifying(true);

    try {
      await requestV3('/verify', { key });
      saveSecurityKey(key);
      setSecurityKeyInput('');
      setUnlockOpen(false);
      toast.success('Customer Management unlocked');
      await loadCustomers();
    } catch (error) {
      toast.error(
        errorText(
          error,
          'FAI_FAI_SETTINGS_KEY is incorrect',
        ),
      );
    } finally {
      setVerifying(false);
    }
  }

  async function refreshCustomers() {
    setRefreshing(true);
    await loadCustomers(true);
    setRefreshing(false);
  }

  function formatAgo(
    value: string | undefined | null,
  ): string {
    if (!value) return 'Never';

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Never';

    const seconds = Math.floor(
      (Date.now() - date.getTime()) / 1000,
    );

    if (seconds < 60) return 'Just now';

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;

    return date.toLocaleDateString();
  }

  function openReset(customer: Customer) {
    setResetCustomer(customer);
    setNewPin('');
    setResetResult(null);
  }

  function closeReset() {
    if (resetting) return;

    setResetCustomer(null);
    setNewPin('');
    setResetResult(null);
  }

  async function submitPinReset() {
    if (!resetCustomer) return;

    if (!/^\d{4}$/.test(newPin)) {
      toast.error('PIN exactly 4 digits hona chahiye');
      return;
    }

    setResetting(true);

    try {
      const result = await requestV3<{
        customer: {
          customer_name: string;
          phone: string;
        };
      }>('/reset-pin', {
        method: 'POST',
        data: {
          phone: resetCustomer.customer_phone,
          new_pin: newPin,
        },
      });

      setResetResult({
        customerName:
          result.customer.customer_name ||
          resetCustomer.customer_name,
        phone:
          result.customer.phone ||
          resetCustomer.customer_phone,
        pin: newPin,
      });

      toast.success('Customer PIN reset ho gaya');
      await loadCustomers(true);
    } catch (error: any) {
      if (error?.status === 401) {
        clearSecurityKey();
        closeReset();
        setUnlockOpen(true);
      }

      toast.error(
        errorText(
          error,
          'Customer PIN reset nahi hua',
        ),
      );
    } finally {
      setResetting(false);
    }
  }

  function sendWhatsAppPin() {
    if (!resetResult) return;

    const number = whatsappNumber(resetResult.phone);

    if (!number) {
      toast.error('WhatsApp number invalid hai');
      return;
    }

    const message = encodeURIComponent(
      `Fai Fai Juice\n\nHello ${resetResult.customerName}, your temporary 4-digit PIN is: ${resetResult.pin}\n\nPlease login with your registered mobile number and change this PIN after login.\n\nNever share your PIN with anyone.`,
    );

    window.open(
      `https://wa.me/${number}?text=${message}`,
      '_blank',
      'noopener,noreferrer',
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <p className="text-gray-400">
          Loading registered customers...
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 px-4 py-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Button
            variant="ghost"
            onClick={() =>
              navigate('/admin/dashboard')
            }
            className="text-gray-400"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>

          <div>
            <h1 className="text-white text-2xl font-bold">
              Customer Management
            </h1>
            <p className="text-gray-500 text-sm">
              Registered customers and secure PIN reset
            </p>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refreshCustomers()}
            className={`ml-auto text-gray-400 ${
              refreshing ? 'animate-spin' : ''
            }`}
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6">
          <Card className="bg-gray-900 border-gray-800 p-4 text-center">
            <Users className="w-5 h-5 text-blue-400 mx-auto mb-1" />
            <p className="text-2xl font-bold text-white">
              {customers.length}
            </p>
            <p className="text-xs text-gray-400">Total</p>
          </Card>

          <Card className="bg-gray-900 border-gray-800 p-4 text-center">
            <Wifi className="w-5 h-5 text-green-400 mx-auto mb-1" />
            <p className="text-2xl font-bold text-green-400">
              {onlineCount}
            </p>
            <p className="text-xs text-gray-400">
              Online Now
            </p>
          </Card>

          <Card className="bg-gray-900 border-gray-800 p-4 text-center">
            <WifiOff className="w-5 h-5 text-gray-500 mx-auto mb-1" />
            <p className="text-2xl font-bold text-gray-400">
              {Math.max(
                customers.length - onlineCount,
                0,
              )}
            </p>
            <p className="text-xs text-gray-400">
              Offline
            </p>
          </Card>
        </div>

        <Card className="bg-blue-950/30 border-blue-900/50 p-4 mb-6">
          <div className="flex gap-3">
            <ShieldCheck className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-blue-200 font-medium">
                Signup customer automatically show hoga
              </p>
              <p className="text-blue-300/70 text-sm mt-1">
                Customer order kare ya na kare, registered
                account is page par nazar aayega.
              </p>
            </div>
          </div>
        </Card>

        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <Input
            placeholder="Search by name, phone or email..."
            value={search}
            onChange={event =>
              setSearch(event.target.value)
            }
            className="bg-gray-900 border-gray-700 text-white pl-10"
          />
        </div>

        <div className="flex gap-2 mb-4">
          {(
            ['all', 'online', 'offline'] as FilterStatus[]
          ).map(status => (
            <Button
              key={status}
              variant={
                filterStatus === status
                  ? 'default'
                  : 'outline'
              }
              size="sm"
              onClick={() =>
                setFilterStatus(status)
              }
              className={`capitalize ${
                filterStatus === status
                  ? 'bg-green-600 hover:bg-green-700 text-white border-green-600'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {status === 'all' && (
                <Users className="w-3 h-3 mr-1" />
              )}
              {status === 'online' && (
                <Wifi className="w-3 h-3 mr-1" />
              )}
              {status === 'offline' && (
                <WifiOff className="w-3 h-3 mr-1" />
              )}
              {status}
            </Button>
          ))}
        </div>

        <div className="space-y-3">
          {visibleCustomers.map(customer => (
            <Card
              key={customer.id}
              className="bg-gray-900 border-gray-800 p-4"
            >
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                <div className="flex gap-3">
                  <div
                    className={`w-3 h-3 rounded-full mt-2 ${
                      customer.is_online
                        ? 'bg-green-400 animate-pulse'
                        : 'bg-gray-600'
                    }`}
                  />

                  <div>
                    <div className="flex flex-wrap gap-2 items-center">
                      <h3 className="text-white font-semibold">
                        {customer.customer_name ||
                          'Customer'}
                      </h3>

                      <Badge
                        variant="outline"
                        className="text-blue-400 border-blue-600/40 text-[10px]"
                      >
                        Registered
                      </Badge>

                      <Badge
                        variant="outline"
                        className={
                          customer.is_locked
                            ? 'text-red-400 border-red-600/40 text-[10px]'
                            : 'text-green-400 border-green-600/40 text-[10px]'
                        }
                      >
                        {customer.is_locked
                          ? 'PIN Locked'
                          : 'PIN Active'}
                      </Badge>
                    </div>

                    <p className="text-gray-400 text-sm mt-1">
                      {customer.customer_phone}
                    </p>

                    {customer.customer_email && (
                      <p className="text-gray-400 text-sm mt-1 break-all">
                        {customer.customer_email}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap gap-2">
                      {customer.google_verified && (
                        <Badge
                          variant="outline"
                          className="text-green-400 border-green-600/40 text-[10px]"
                        >
                          Google Verified
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className="text-gray-400 border-gray-700 text-[10px]"
                      >
                        {customer.auth_provider === 'google'
                          ? 'Google Login'
                          : 'Phone + PIN'}
                      </Badge>
                    </div>

                    <p className="text-gray-600 text-xs mt-1">
                      Registered:{' '}
                      {customer.created_at
                        ? new Date(
                            customer.created_at,
                          ).toLocaleDateString()
                        : '-'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={
                      customer.is_online
                        ? 'text-green-400 border-green-600/40'
                        : 'text-gray-500 border-gray-700'
                    }
                  >
                    {customer.is_online
                      ? 'Online'
                      : 'Offline'}
                  </Badge>

                  <Button
                    size="sm"
                    onClick={() => openReset(customer)}
                    className="bg-red-600 hover:bg-red-700"
                  >
                    <KeyRound className="w-4 h-4 mr-2" />
                    Reset PIN
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 mt-4 text-center">
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <div className="flex justify-center items-center gap-1">
                    <ShoppingBag className="w-3 h-3 text-blue-400" />
                    <span className="text-white text-sm font-medium">
                      {customer.total_orders}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    Orders
                  </p>
                </div>

                <div className="bg-gray-800/50 rounded-lg p-2">
                  <p className="text-white text-sm font-medium">
                    AED{' '}
                    {Number(
                      customer.total_spent || 0,
                    ).toFixed(0)}
                  </p>
                  <p className="text-xs text-gray-500">
                    Spent
                  </p>
                </div>

                <div className="bg-gray-800/50 rounded-lg p-2">
                  <div className="flex justify-center items-center gap-1">
                    <Clock className="w-3 h-3 text-yellow-400" />
                    <span className="text-white text-sm font-medium">
                      {formatAgo(
                        customer.last_active ||
                          customer.last_order_date,
                      )}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    Active
                  </p>
                </div>
              </div>
            </Card>
          ))}

          {visibleCustomers.length === 0 && (
            <div className="text-center py-16">
              <Users className="w-12 h-12 text-gray-700 mx-auto mb-3" />
              <p className="text-gray-500">
                No registered customers found
              </p>
              <p className="text-gray-600 text-xs mt-2">
                Customer signup ke baad yahan show hoga.
              </p>
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={unlockOpen}
        onOpenChange={open => {
          if (!open && storedSecurityKey()) {
            setUnlockOpen(false);
          }
        }}
      >
        <DialogContent className="bg-gray-950 border-gray-800 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex gap-2 items-center">
              <LockKeyhole className="w-5 h-5 text-blue-400" />
              Unlock Customer Management
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-gray-400 text-sm">
              Render Environment me jo
              <span className="text-white font-semibold">
                {' '}FAI_FAI_SETTINGS_KEY
              </span>
              {' '}ki VALUE hai, woh yahan enter karo.
            </p>

            <div className="space-y-2">
              <Label htmlFor="fai-fai-v3-key">
                Admin Security Key
              </Label>
              <Input
                id="fai-fai-v3-key"
                type="password"
                autoComplete="off"
                value={securityKeyInput}
                onChange={event =>
                  setSecurityKeyInput(
                    event.target.value,
                  )
                }
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    void unlockCustomerManagement();
                  }
                }}
                placeholder="Render security key"
                className="bg-gray-900 border-gray-700 text-white"
              />
            </div>

            <Button
              onClick={() =>
                void unlockCustomerManagement()
              }
              disabled={
                verifying ||
                securityKeyInput.trim().length < 8
              }
              className="w-full bg-blue-600 hover:bg-blue-700"
            >
              {verifying
                ? 'Checking...'
                : 'Unlock'}
            </Button>

            <Button
              variant="outline"
              onClick={() =>
                navigate('/admin/dashboard')
              }
              className="w-full border-gray-700 text-gray-300"
            >
              Back
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(resetCustomer)}
        onOpenChange={open => {
          if (!open) closeReset();
        }}
      >
        <DialogContent className="bg-gray-950 border-gray-800 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex gap-2 items-center">
              <KeyRound className="w-5 h-5 text-red-400" />
              Reset Customer PIN
            </DialogTitle>
          </DialogHeader>

          {resetCustomer && (
            <div className="space-y-5">
              <Card className="bg-gray-900 border-gray-800 p-4">
                <p className="text-white font-semibold">
                  {resetCustomer.customer_name}
                </p>
                <p className="text-gray-400 text-sm">
                  {resetCustomer.customer_phone}
                </p>
              </Card>

              {!resetResult ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="fai-fai-new-pin">
                      New temporary 4-digit PIN
                    </Label>
                    <Input
                      id="fai-fai-new-pin"
                      type="password"
                      inputMode="numeric"
                      maxLength={4}
                      value={newPin}
                      onChange={event =>
                        setNewPin(
                          event.target.value
                            .replace(/\D/g, '')
                            .slice(0, 4),
                        )
                      }
                      placeholder="••••"
                      className="bg-gray-900 border-gray-700 text-white text-center text-2xl tracking-[0.5em]"
                    />
                  </div>

                  <Button
                    onClick={() =>
                      void submitPinReset()
                    }
                    disabled={
                      resetting ||
                      !/^\d{4}$/.test(newPin)
                    }
                    className="w-full bg-red-600 hover:bg-red-700"
                  >
                    {resetting
                      ? 'Resetting...'
                      : 'Reset PIN'}
                  </Button>
                </>
              ) : (
                <div className="space-y-4">
                  <Card className="bg-green-950/30 border-green-800 p-4">
                    <div className="flex gap-3">
                      <ShieldCheck className="w-6 h-6 text-green-400" />
                      <div>
                        <p className="text-green-300 font-semibold">
                          PIN reset completed
                        </p>
                        <p className="text-white text-xl font-bold tracking-widest mt-1">
                          {resetResult.pin}
                        </p>
                      </div>
                    </div>
                  </Card>

                  <Button
                    onClick={sendWhatsAppPin}
                    className="w-full bg-green-600 hover:bg-green-700"
                  >
                    <MessageCircle className="w-4 h-4 mr-2" />
                    Send PIN on WhatsApp
                  </Button>

                  <Button
                    variant="outline"
                    onClick={closeReset}
                    className="w-full border-gray-700 text-gray-300"
                  >
                    Done
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
