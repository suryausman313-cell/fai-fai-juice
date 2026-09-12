import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, CheckCircle, XCircle, ChefHat, Package, RefreshCw, Store, MessageSquare, Bike, Navigation, AlertTriangle, X, ShoppingCart, Bell, BellOff, EyeOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import CustomerLayout from '@/components/CustomerLayout';
import { backendRequest, client, Order, CartItem } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { getCart, saveCart } from '@/lib/cart-store';
import { getGuestSessionId } from '@/lib/guest-session';
import ReadyTimeCountdown from '@/components/ReadyTimeCountdown';
import {
  enableCustomerPush,
  syncCustomerPushIfAllowed,
} from '@/lib/customer-push';

const PICKUP_STEPS = [
  { key: 'new', label: 'Order Placed', icon: Store },
  { key: 'accepted', label: 'Accepted', icon: CheckCircle },
  { key: 'preparing', label: 'Preparing', icon: ChefHat },
  { key: 'ready', label: 'Ready!', icon: Package },
];

const DELIVERY_STEPS = [
  { key: 'new', label: 'Order Placed', icon: Store },
  { key: 'accepted', label: 'Confirmed', icon: CheckCircle },
  { key: 'preparing', label: 'Preparing', icon: ChefHat },
  { key: 'ready', label: 'Ready', icon: Package },
  { key: 'picked_up', label: 'Picked Up', icon: Bike },
  { key: 'on_the_way', label: 'On the Way', icon: Navigation },
  { key: 'delivered', label: 'Delivered', icon: CheckCircle },
];

function getStepIndex(status: string, steps: typeof PICKUP_STEPS): number {
  const idx = steps.findIndex(s => s.key === status);
  return idx >= 0 ? idx : -1;
}

function getDeliveryStepIndex(orderStatus: string, deliveryStatus: string | null): number {
  if (deliveryStatus === 'delivered') return 6;
  if (deliveryStatus === 'on_the_way') return 5;
  if (deliveryStatus === 'picked_up') return 4;
  if (orderStatus === 'ready') return 3;
  if (orderStatus === 'preparing') return 2;
  if (orderStatus === 'accepted') return 1;
  if (orderStatus === 'new') return 0;
  return -1;
}

/** Format date safely - handles 1970/epoch dates */
function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Date unavailable';
  try {
    const date = new Date(dateStr);
    // Check for epoch/1970 dates (before year 2000)
    if (date.getFullYear() < 2000 || isNaN(date.getTime())) {
      return 'Date unavailable';
    }
    return date.toLocaleString();
  } catch {
    return 'Date unavailable';
  }
}

/** Format date for past orders (short format) */
function formatDateShort(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Date unavailable';
  try {
    const date = new Date(dateStr);
    if (date.getFullYear() < 2000 || isNaN(date.getTime())) {
      return 'Date unavailable';
    }
    return date.toLocaleDateString();
  } catch {
    return 'Date unavailable';
  }
}

/** Calculate elapsed minutes since order was placed */
function getElapsedMinutes(createdAt: string | null | undefined): number {
  if (!createdAt) return 0;
  try {
    const date = new Date(createdAt);
    if (date.getFullYear() < 2000 || isNaN(date.getTime())) return 0;
    return Math.floor((Date.now() - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

function OrderProgressTracker({ status, estimatedTime, referenceTime, isDelivery, deliveryStatus, deliveryEtaSeconds, deliveryEtaCalculatedAt }: { status: string; estimatedTime: string; referenceTime?: string; isDelivery: boolean; deliveryStatus: string | null; deliveryEtaSeconds?: number | null; deliveryEtaCalculatedAt?: string | null }) {
  const { t } = useTranslation();
  const steps = isDelivery ? DELIVERY_STEPS : PICKUP_STEPS;
  const currentStep = isDelivery
    ? getDeliveryStepIndex(status, deliveryStatus)
    : getStepIndex(status, steps);
  const deliveryTravelStage = isDelivery && (
    status === 'ready' ||
    status === 'out_for_delivery' ||
    ['picked_up', 'on_the_way'].includes(String(deliveryStatus || ''))
  );
  
  if (status === 'completed' || status === 'cancelled') return null;
  if (isDelivery && deliveryStatus === 'delivered') return null;

  return (
    <div className="py-4">
      {/* Live countdown. Zero does not mean ready until Kitchen marks it Ready. */}
      {deliveryTravelStage ? (
        deliveryEtaSeconds ? (
          <LiveDeliveryEta
            seconds={deliveryEtaSeconds}
            calculatedAt={deliveryEtaCalculatedAt}
          />
        ) : (
          <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-3 mb-4 flex items-center gap-3">
            <Navigation className="w-5 h-5 text-blue-400 shrink-0 animate-pulse" />
            <div>
              <p className="text-blue-300 font-bold text-sm">Rider on the way</p>
              <p className="text-blue-300/60 text-xs">{t('orders.eta_waiting_gps')}</p>
            </div>
          </div>
        )
      ) : (
        <ReadyTimeCountdown
          estimatedTime={estimatedTime}
          referenceTime={referenceTime}
          status={status}
          readySubtitle={isDelivery ? undefined : 'Waiting for customer pickup.'}
        />
      )}

      {/* Progress Steps */}
      <div className="relative">
        {steps.map((step, idx) => {
          const StepIcon = step.icon;
          const isCompleted = idx <= currentStep;
          const isCurrent = idx === currentStep;

          return (
            <div key={step.key} className="flex items-start gap-3 relative">
              {idx < steps.length - 1 && (
                <div className={`absolute left-[15px] top-[32px] w-0.5 h-8 ${
                  idx < currentStep ? 'bg-green-500' : 'bg-gray-700'
                }`} />
              )}
              
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 z-10 ${
                isCompleted
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-800 text-gray-500 border border-gray-700'
              } ${isCurrent ? 'ring-2 ring-green-400/50 ring-offset-2 ring-offset-gray-900' : ''}`}>
                <StepIcon className="w-4 h-4" />
              </div>

              <div className={`pb-6 ${isCurrent ? 'pt-0.5' : 'pt-1'}`}>
                <p className={`text-sm font-medium ${
                  isCompleted ? 'text-white' : 'text-gray-500'
                } ${isCurrent ? 'text-green-400' : ''}`}>
                  {step.label}
                </p>
                {isCurrent && (
                  <p className="text-green-400/60 text-xs mt-0.5">Current status</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function normalizeUaeWhatsAppNumber(phone: string): string {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00971')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `971${digits.slice(1)}`;
  if (!digits.startsWith('971') && digits.length === 9) digits = `971${digits}`;
  return digits;
}

function RiderContactCard({ riderName, riderPhone }: { riderName: string; riderPhone: string }) {
  const waPhone = normalizeUaeWhatsAppNumber(riderPhone);
  const message = encodeURIComponent(`Hello ${riderName}, I am contacting you about my Fai Fai Juice delivery.`);
  const whatsappUrl = `https://wa.me/${waPhone}?text=${message}`;

  return (
    <a
      href={whatsappUrl}
      data-rider-phone={waPhone}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-blue-600/10 border border-blue-600/30 rounded-xl p-4 mb-4 hover:bg-blue-600/15 transition-colors"
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-full bg-blue-600/20 flex items-center justify-center flex-shrink-0">
          <Bike className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <p className="text-blue-400 font-bold text-sm">Your Rider</p>
          <p className="text-white font-semibold">{riderName}</p>
          <p className="text-blue-300/70 text-xs">{riderPhone}</p>
        </div>
      </div>
      <div className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg py-2.5 px-3 text-sm font-medium transition-colors">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
          WhatsApp Rider
      </div>
    </a>
  );
}

function LiveDeliveryEta({ seconds, calculatedAt }: { seconds?: number | null; calculatedAt?: string | null }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  const baseMs = calculatedAt ? new Date(calculatedAt).getTime() : Date.now();
  const deadlineMs = baseMs + Math.max(0, Number(seconds || 0)) * 1000;

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [seconds, calculatedAt]);

  if (!seconds || !Number.isFinite(deadlineMs)) return null;
  const remaining = Math.max(0, Math.floor((deadlineMs - now) / 1000));
  const minutes = Math.floor(remaining / 60);
  const secs = remaining % 60;

  return (
    <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-3 mb-4 flex items-center gap-3">
      <Navigation className="w-5 h-5 text-blue-400 shrink-0" />
      <div>
        <p className="text-blue-300 font-bold text-sm">
          {remaining > 0
            ? `Rider arriving in ${minutes}:${String(secs).padStart(2, '0')}`
            : 'Rider arriving soon'}
        </p>
        <p className="text-blue-300/60 text-xs">{t('orders.eta_live_location')}</p>
      </div>
    </div>
  );
}

/** Timer + WhatsApp notification for pending orders */
function OrderTimerNotification({ order, acceptTimeout, expireTimeout, onExpired }: {
  order: OrderWithDelivery;
  acceptTimeout: number;
  expireTimeout: number;
  onExpired: (orderId: number) => void;
}) {
  const { t } = useTranslation();
  const [elapsedMinutes, setElapsedMinutes] = useState(getElapsedMinutes(order.created_at));
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      const mins = getElapsedMinutes(order.created_at);
      setElapsedMinutes(mins);
      if (mins >= expireTimeout && !expired) {
        setExpired(true);
        onExpired(order.id);
      }
    }, 10000); // Update every 10 seconds
    return () => clearInterval(interval);
  }, [order.created_at, expireTimeout, expired, onExpired, order.id]);

  // Only show for 'new' (pending) orders
  if (order.status !== 'new') return null;

  const restaurantPhone = '0523187415'; // Fai Fai Juice shop WhatsApp
  const whatsappMessage = encodeURIComponent(
    t('orders.whatsapp_pending_message').replace('{orderId}', String(order.id))
  );
  const whatsappUrl = `https://wa.me/${normalizeUaeWhatsAppNumber(restaurantPhone)}?text=${whatsappMessage}`;

  // Show warning after acceptTimeout minutes
  if (elapsedMinutes >= acceptTimeout && elapsedMinutes < expireTimeout) {
    return (
      <div className="bg-yellow-600/10 border border-yellow-600/30 rounded-xl p-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-yellow-600/20 flex items-center justify-center flex-shrink-0 animate-pulse">
            <AlertTriangle className="w-5 h-5 text-yellow-400" />
          </div>
          <div className="flex-1">
            <p className="text-yellow-400 font-bold text-sm">
              {t('orders.restaurant_not_accepted')}
            </p>
            <p className="text-yellow-400/70 text-xs mt-1">
              {t('orders.elapsed_auto_cancel')
                .replace('{elapsed}', String(elapsedMinutes))
                .replace('{remaining}', String(expireTimeout - elapsedMinutes))}
            </p>
          </div>
        </div>
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white rounded-lg py-3 px-4 text-sm font-medium transition-colors"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
          {t('orders.whatsapp_restaurant')}
        </a>
      </div>
    );
  }

  // Show expired notification
  if (elapsedMinutes >= expireTimeout || expired) {
    return (
      <div className="bg-red-600/10 border border-red-600/30 rounded-xl p-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-red-600/20 flex items-center justify-center flex-shrink-0">
            <XCircle className="w-5 h-5 text-red-400" />
          </div>
          <div className="flex-1">
            <p className="text-red-400 font-bold text-sm">
              {t('orders.expired_title')}
            </p>
            <p className="text-red-400/70 text-xs mt-1">
              {expireTimeout}+ minutes wait • Order auto-cancelled
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Show waiting timer (before acceptTimeout)
  return (
    <div className="bg-blue-600/10 border border-blue-600/30 rounded-xl p-3 mb-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-blue-600/20 flex items-center justify-center flex-shrink-0 animate-pulse">
        <Clock className="w-5 h-5 text-blue-400" />
      </div>
      <div>
        <p className="text-blue-400 font-bold text-sm">Waiting for restaurant to accept</p>
        <p className="text-blue-300/70 text-xs">{elapsedMinutes} min elapsed • Usually accepted within {acceptTimeout} min</p>
      </div>
    </div>
  );
}

/** Cancel order confirmation dialog */
function CancelOrderDialog({ orderId, orderStatus, onCancel, onClose }: {
  orderId: number;
  orderStatus: string;
  onCancel: (orderId: number, reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  async function handleCancel() {
    setCancelling(true);
    await onCancel(orderId, reason);
    setCancelling(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-sm w-full">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-bold text-lg">Cancel Order #{orderId}?</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-gray-400 text-sm mb-4">
          {orderStatus === 'new'
            ? 'Your order has not been accepted yet. Are you sure you want to cancel?'
            : `Your order is currently "${orderStatus}". Are you sure you want to cancel?`}
        </p>
        <div className="mb-4">
          <label className="text-gray-300 text-sm block mb-1">Reason (optional)</label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. Changed my mind, taking too long..."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg p-3 text-white text-sm resize-none"
            rows={2}
          />
        </div>
        <div className="flex gap-3">
          <Button
            onClick={onClose}
            variant="outline"
            className="flex-1 border-gray-600 text-gray-300 cursor-pointer"
          >
            Keep Order
          </Button>
          <Button
            onClick={handleCancel}
            disabled={cancelling}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white cursor-pointer"
          >
            {cancelling ? 'Cancelling...' : 'Yes, Cancel'}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface OrderWithDelivery extends Order {
  delivery_status?: string | null;
  rider_name?: string | null;
  rider_phone?: string | null;
  rider_lat?: number | null;
  rider_lng?: number | null;
  delivery_eta_seconds?: number | null;
  delivery_eta_calculated_at?: string | null;
}

function hiddenPastOrdersKey(): string {
  const phone = String(
    localStorage.getItem('vita_customer_phone') ||
    localStorage.getItem('vita_customer_registered_phone') ||
    'customer'
  ).replace(/[^0-9+]/g, '');
  return `fai_fai_hidden_past_orders:${phone || 'customer'}`;
}

function readHiddenPastOrders(): Set<number> {
  try {
    const raw = localStorage.getItem(hiddenPastOrdersKey());
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map(value => Number(value))
        .filter(value => Number.isInteger(value) && value > 0)
    );
  } catch {
    return new Set();
  }
}

export default function MyOrders() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [orders, setOrders] = useState<OrderWithDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reviewedOrders, setReviewedOrders] = useState<Set<number>>(new Set());
  const [cancelDialogOrder, setCancelDialogOrder] = useState<OrderWithDelivery | null>(null);
  const [hiddenPastOrderIds, setHiddenPastOrderIds] = useState<Set<number>>(() => readHiddenPastOrders());
  const [notificationStatus, setNotificationStatus] = useState<
    'checking' | 'login_required' | 'available' | 'enabling' | 'enabled' | 'blocked' | 'unsupported' | 'error'
  >('checking');
  const [notificationMessage, setNotificationMessage] = useState('');

  // Admin-configured timeouts
  const [acceptTimeout] = useState(2); // fixed: show WhatsApp Restaurant after 2 minutes
  const [expireTimeout, setExpireTimeout] = useState(15); // minutes

  useEffect(() => {
    void loadInitialData();
    void checkReadyNotifications();
    const interval = setInterval(() => {
      void loadOrders();
    }, 8000);
    return () => clearInterval(interval);
  }, []);

  async function checkReadyNotifications() {
    if (!localStorage.getItem('vita_customer_token')) {
      setNotificationStatus('login_required');
      return;
    }
    try {
      const state = await syncCustomerPushIfAllowed();
      if (!state.supported) setNotificationStatus('unsupported');
      else if (state.permission === 'denied') setNotificationStatus('blocked');
      else if (state.permission === 'granted' && state.subscribed) setNotificationStatus('enabled');
      else setNotificationStatus('available');
    } catch (error: any) {
      // A stale browser subscription should not leave the customer trapped on
      // an error card. The Enable button will repair/recreate it on demand.
      setNotificationStatus('available');
      setNotificationMessage(error?.message || 'Could not check notifications');
    }
  }

  async function handleEnableReadyNotifications() {
    if (!localStorage.getItem('vita_customer_token')) {
      navigate('/account');
      return;
    }
    setNotificationStatus('enabling');
    setNotificationMessage('');
    try {
      await enableCustomerPush();
      setNotificationStatus('enabled');
    } catch (error: any) {
      const message = error?.message || 'Could not enable notifications';
      setNotificationMessage(message);
      setNotificationStatus(
        typeof Notification !== 'undefined' && Notification.permission === 'denied'
          ? 'blocked'
          : 'error',
      );
    }
  }

  async function loadInitialData() {
    try {
      await Promise.all([loadOrders(), loadReviewedOrders(), loadSettings()]);
    } finally {
      setLoading(false);
    }
  }

  async function loadSettings() {
    try {
      const res = await client.entities.restaurant_settings.query({ query: {}, limit: 1 });
      const items = res?.data?.items || [];
      if (items.length > 0) {
        const s = items[0] as any;
        // Customer WhatsApp escalation is fixed at 2 minutes for Fai Fai Juice.
        if (s.order_expire_timeout_minutes) setExpireTimeout(Number(s.order_expire_timeout_minutes) || 15);
      }
    } catch {
      // Use defaults
    }
  }

  async function loadReviewedOrders() {
    try {
      const res = await client.entities.feedbacks.query({
        query: {},
        limit: 100,
      });
      if (res?.data?.items) {
        const reviewed = new Set<number>(res.data.items.map((f: any) => f.order_id));
        setReviewedOrders(reviewed);
      }
    } catch (e) {
      console.error('Failed to load feedbacks:', e);
    }
  }

  async function loadOrders() {
    try {
      setRefreshing(true);
      const res = await client.apiCall.invoke({
        url: `/api/v1/orders/my-orders?session_id=${encodeURIComponent(getGuestSessionId())}`,
        method: 'GET',
      });
      const baseItems = (res?.data?.items || []) as OrderWithDelivery[];
      const enrichedItems = await Promise.all(
        baseItems.map(async (order) => {
          const delivery = String(order.order_type || '').toLowerCase() === 'delivery' ||
            order.order_notes?.includes('Order Type: Delivery');
          if (!delivery || ['completed', 'cancelled'].includes(order.status)) return order;

          try {
            const etaRes = await client.apiCall.invoke({
              url: `/api/v1/rider/delivery-eta/${order.id}`,
              method: 'GET',
            });
            const eta = etaRes?.data || {};
            return {
              ...order,
              delivery_status: eta.status === 'no_rider' ? order.delivery_status : eta.status,
              rider_name: eta.rider_name || order.rider_name,
              rider_phone: eta.rider_phone || order.rider_phone,
              rider_lat: eta.rider_lat ?? order.rider_lat,
              rider_lng: eta.rider_lng ?? order.rider_lng,
              delivery_eta_seconds: Number(eta.eta_seconds || 0) || null,
              delivery_eta_calculated_at: eta.calculated_at || null,
            };
          } catch {
            return order;
          }
        }),
      );
      setOrders(enrichedItems);
    } catch (e) {
      console.error('Failed to load orders:', e);
    } finally {
      setRefreshing(false);
    }
  }

  const handleOrderExpired = useCallback(async (orderId: number) => {
    // Auto-cancel the expired order
    try {
      await client.apiCall.invoke({
        url: `/api/v1/orders/${orderId}/cancel`,
        method: 'POST',
        data: {
          reason: 'Auto-expired: Restaurant did not accept in time',
          session_id: getGuestSessionId(),
        },
      });
      // Reload orders to reflect the change
      await loadOrders();
    } catch (e) {
      console.error('Failed to auto-cancel expired order:', e);
    }
  }, []);

  async function handleCancelOrder(orderId: number, reason: string) {
    try {
      await client.apiCall.invoke({
        url: `/api/v1/orders/${orderId}/cancel`,
        method: 'POST',
        data: {
          reason: String(reason || '').trim() || 'Cancelled by customer',
          session_id: getGuestSessionId(),
        },
      });
      toast.success('Order cancelled');
      await loadOrders();
    } catch (e: any) {
      const msg = e?.data?.detail || e?.message || 'Failed to cancel order';
      toast.error(String(msg));
    }
  }

  async function cancelPendingPaymentOrder(orderId: number) {
    try {
      const res = await client.apiCall.invoke({
        url: '/api/v1/ziina/cancel-payment-order',
        method: 'POST',
        data: { order_id: orderId },
      });

      const data = res?.data || {};
      if (data.success && String(data.status || '').toLowerCase() === 'cancelled') {
        toast.success('Pending order cancelled');
        await loadOrders();
        return;
      }

      if (data.paid === true || String(data.status || '').toLowerCase() === 'new') {
        toast.info('Payment was already completed. Order is now active.');
        await loadOrders();
        return;
      }

      toast.error(
        String(
          data.message ||
          'Payment is still active. Retry payment or choose Cash.'
        )
      );
    } catch (e: any) {
      toast.error(
        String(e?.data?.detail || e?.message || 'Could not cancel pending order')
      );
    }
  }

  function hidePastOrder(orderId: number) {
    setHiddenPastOrderIds(current => {
      const next = new Set(current);
      next.add(orderId);
      localStorage.setItem(
        hiddenPastOrdersKey(),
        JSON.stringify(Array.from(next))
      );
      return next;
    });
    toast.success('Order removed from your list');
  }

  /** Determine if customer can cancel this order */
  function canCancelOrder(order: OrderWithDelivery): boolean {
    // Backend hard-locks customer cancellation once Kitchen accepts. Keep UI
    // aligned so it never shows a button that the API will reject.
    return order.status === 'new';
  }

  async function retryOnlinePayment(orderId: number) {
    try {
      const res = await backendRequest(
        '/api/v1/ziina/create-payment',
        'POST',
        { order_id: orderId },
      );
      if (res?.data?.already_paid === true) {
        localStorage.removeItem('vita_pending_ziina_order_id');
        await loadOrders();
        return;
      }
      const redirectUrl = String(res?.data?.redirect_url || '').trim();
      if (!redirectUrl) throw new Error('Online payment link was not returned');
      localStorage.setItem('vita_pending_ziina_order_id', String(orderId));
      window.location.assign(redirectUrl);
    } catch (e: any) {
      alert(e?.data?.detail || e?.response?.data?.detail || e?.message || 'Could not open online payment');
    }
  }

  /** Order Again - adds items from a past order back to cart */
  function handleOrderAgain(order: OrderWithDelivery) {
    try {
      let items: any[] = [];
      try { items = JSON.parse(order.items_json); } catch { return; }
      if (items.length === 0) return;

      const cart = getCart();
      for (const item of items) {
        const unitPrice = item.price / (item.quantity || 1);
        const newCartItem: CartItem = {
          id: `reorder-${order.id}-${item.name}-${item.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          menuItem: {
            id: 0,
            category_id: 0,
            name: item.name,
            description: '',
            price: unitPrice,
            price_medium: unitPrice,
            price_large: 0,
            sizes_json: JSON.stringify([{ name: item.size || 'Regular', price: unitPrice }]),
            image_url: '',
            is_active: true,
            has_extras: false,
            sort_order: 0,
          } as any,
          size: item.size || 'Regular',
          extras: (item.extras || []).map((eName: string, idx: number) => ({
            id: idx,
            name: eName,
            price: 0,
          })),
          quantity: item.quantity || 1,
          totalPrice: item.price,
        };
        cart.push(newCartItem);
      }
      saveCart(cart);
      window.dispatchEvent(new Event('cart-updated'));
      navigate('/cart');
    } catch (e) {
      console.error('Failed to reorder:', e);
    }
  }

  if (loading) {
    return (
      <CustomerLayout>
        <div className="bg-black min-h-screen flex items-center justify-center">
          <div className="text-gray-400">Loading...</div>
        </div>
      </CustomerLayout>
    );
  }


  function isDeliveryOrder(order: OrderWithDelivery): boolean {
    if (order.delivery_status !== null && order.delivery_status !== undefined) return true;
    return order.order_notes?.includes('Order Type: Delivery') || false;
  }

  function isActiveOrder(order: OrderWithDelivery): boolean {
    if (order.status === 'completed' || order.status === 'cancelled') return false;
    if (isDeliveryOrder(order) && order.delivery_status === 'delivered') return false;
    return true;
  }

  const activeOrders = orders.filter(o => isActiveOrder(o));
  const pastOrders = orders.filter(o => !isActiveOrder(o) && !hiddenPastOrderIds.has(o.id));

  return (
    <CustomerLayout>
      <div className="bg-black min-h-screen px-4 py-6 max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-white text-2xl font-bold">My Orders</h1>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadOrders()}
            disabled={refreshing}
            className="text-gray-400 hover:text-white cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <div className={`rounded-xl border p-4 mb-5 ${
          notificationStatus === 'enabled'
            ? 'border-green-600/30 bg-green-600/10'
            : notificationStatus === 'blocked' || notificationStatus === 'error'
              ? 'border-red-600/30 bg-red-600/10'
              : 'border-gray-700 bg-gray-900'
        }`}>
          <div className="flex items-start gap-3">
            <div className={`rounded-full p-2 ${
              notificationStatus === 'enabled' ? 'bg-green-600/20' : 'bg-gray-800'
            }`}>
              {notificationStatus === 'blocked' || notificationStatus === 'unsupported' ? (
                <BellOff className="w-5 h-5 text-red-400" />
              ) : (
                <Bell className={`w-5 h-5 ${notificationStatus === 'enabled' ? 'text-green-400' : 'text-yellow-400'}`} />
              )}
            </div>
            <div className="flex-1">
              <p className="text-white font-semibold text-sm">
                {notificationStatus === 'enabled'
                  ? 'Ready notifications enabled'
                  : notificationStatus === 'blocked'
                    ? 'Notifications are blocked'
                    : notificationStatus === 'unsupported'
                      ? 'Notifications are not supported'
                      : 'Get notified when your order is ready'}
              </p>
              <p className="text-gray-400 text-xs mt-1">
                {notificationStatus === 'enabled'
                  ? 'You will receive a phone alert when Kitchen marks your order Ready.'
                  : notificationStatus === 'blocked'
                    ? 'Open browser settings and allow notifications for Fai Fai Juice.'
                    : notificationMessage || 'Enable once to receive Ready alerts even when the app is in background.'}
              </p>
              {!['enabled', 'blocked', 'unsupported', 'checking'].includes(notificationStatus) && (
                <Button
                  onClick={handleEnableReadyNotifications}
                  disabled={notificationStatus === 'enabling'}
                  size="sm"
                  className="mt-3 bg-green-600 hover:bg-green-700 text-white cursor-pointer"
                >
                  <Bell className="w-4 h-4 mr-2" />
                  {notificationStatus === 'login_required'
                    ? 'Login to Enable'
                    : notificationStatus === 'enabling'
                      ? 'Enabling...'
                      : 'Enable Notifications'}
                </Button>
              )}
            </div>
          </div>
        </div>

        {orders.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-5xl mb-4">🥤</div>
            <p className="text-gray-400 text-lg font-medium">No orders yet</p>
            <p className="text-gray-600 text-sm mt-2">Your orders will appear here after you place them</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Active Orders */}
            {activeOrders.length > 0 && (
              <div>
                <h2 className="text-green-400 font-semibold text-sm uppercase tracking-wider mb-3">Active Orders</h2>
                <div className="space-y-4">
                  {activeOrders.map(order => {
                    let items: any[] = [];
                    try { items = JSON.parse(order.items_json); } catch { /* */ }
                    const isDelivery = isDeliveryOrder(order);
                    const isPaymentPending = order.status === 'payment_pending';
                    const showRiderContact = isDelivery && order.rider_name && order.rider_phone &&
                      !['rejected', 'delivered'].includes(String(order.delivery_status || ''));

                    return (
                      <Card key={order.id} className="bg-gray-900 border-green-600/20 border p-4">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className="text-white font-bold text-lg">Order #{order.id}</span>
                            {isDelivery && (
                              <Badge className="bg-blue-600/20 text-blue-400 border border-blue-600/30 text-xs">
                                <Bike className="w-3 h-3 mr-1" /> Delivery
                              </Badge>
                            )}
                            {isPaymentPending && (
                              <Badge className="bg-yellow-600/20 text-yellow-300 border border-yellow-600/30 text-xs">
                                Payment Pending
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-col items-end">
                            {order.delivery_charge > 0 && (
                              <span className="text-[10px] text-gray-400">Delivery: AED {order.delivery_charge?.toFixed(2)}</span>
                            )}
                            {order.tip_amount > 0 && (
                              <span className="text-[10px] text-green-400">Tip: AED {order.tip_amount?.toFixed(2)}</span>
                            )}
                            <span className="text-red-400 font-bold">AED {order.total_amount?.toFixed(2)}</span>
                          </div>
                        </div>
                        <p className="text-gray-500 text-xs mb-3">
                          {formatDate(order.created_at)}
                        </p>

                        {/* Unpaid Ziina orders are not sent to Kitchen. */}
                        {isPaymentPending ? (
                          <div className="mb-4 rounded-xl border border-yellow-600/30 bg-yellow-600/10 p-4">
                            <p className="text-yellow-300 font-bold text-sm">Online payment not completed</p>
                            <p className="text-yellow-200/70 text-xs mt-1">
                              This order has not been sent to Kitchen yet. Retry payment, or go back to Checkout and choose Cash.
                            </p>
                            <div className="grid grid-cols-2 gap-2 mt-3">
                              <Button
                                onClick={() => void retryOnlinePayment(order.id)}
                                size="sm"
                                className="bg-yellow-600 hover:bg-yellow-700 text-black cursor-pointer"
                              >
                                Retry Payment
                              </Button>
                              <Button
                                onClick={() => {
                                  localStorage.setItem('vita_pending_ziina_order_id', String(order.id));
                                  navigate('/checkout');
                                }}
                                size="sm"
                                variant="outline"
                                className="border-green-600/50 text-green-400 hover:bg-green-600/10 cursor-pointer"
                              >
                                Choose Cash
                              </Button>
                              <Button
                                onClick={() => void cancelPendingPaymentOrder(order.id)}
                                size="sm"
                                variant="outline"
                                className="col-span-2 border-red-600/50 text-red-400 hover:bg-red-600/10 hover:text-red-300 cursor-pointer"
                              >
                                <XCircle className="w-4 h-4 mr-2" />
                                Cancel Pending Order
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <OrderTimerNotification
                            order={order}
                            acceptTimeout={acceptTimeout}
                            expireTimeout={expireTimeout}
                            onExpired={handleOrderExpired}
                          />
                        )}

                        {/* Rider Contact Card - shown after pickup */}
                        {showRiderContact && (
                          <RiderContactCard
                            riderName={order.rider_name!}
                            riderPhone={order.rider_phone!}
                          />
                        )}

                        {/* Track Live Button for delivery orders */}
                        {isDelivery && order.delivery_status && order.delivery_status !== 'delivered' && (
                          <Button
                            onClick={() => navigate(`/track/${order.id}`)}
                            className="w-full mb-3 bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                            size="sm"
                          >
                            <Navigation className="w-4 h-4 mr-2" />
                            {order.rider_lat != null && order.rider_lng != null
                              ? 'Track Rider Live on Map'
                              : 'Open Rider Tracking'}
                          </Button>
                        )}

                        {/* Progress starts only after payment is complete. */}
                        {!isPaymentPending && (
                          <OrderProgressTracker
                            status={order.status}
                            estimatedTime={order.estimated_time}
                            referenceTime={order.updated_at || order.created_at}
                            isDelivery={isDelivery}
                            deliveryStatus={order.delivery_status || null}
                            deliveryEtaSeconds={order.delivery_eta_seconds}
                            deliveryEtaCalculatedAt={order.delivery_eta_calculated_at}
                          />
                        )}

                        {/* Items */}
                        <div className="border-t border-gray-800 pt-3">
                          <p className="text-gray-500 text-xs uppercase mb-2">Items</p>
                          {items.map((item: any, idx: number) => (
                            <div key={idx} className="flex justify-between text-sm py-0.5">
                              <span className="text-gray-300">{item.quantity}x {item.name} ({item.size})</span>
                              <span className="text-gray-400">AED {item.price?.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>

                        {/* Cancel Button */}
                        {canCancelOrder(order) && (
                          <div className="mt-3 pt-3 border-t border-gray-800">
                            <Button
                              onClick={() => setCancelDialogOrder(order)}
                              variant="outline"
                              size="sm"
                              className="border-red-600/50 text-red-400 hover:bg-red-600/10 hover:text-red-300 cursor-pointer w-full"
                            >
                              <XCircle className="w-4 h-4 mr-2" />
                              Cancel Order
                            </Button>
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Past Orders */}
            {pastOrders.length > 0 && (
              <div>
                <h2 className="text-gray-500 font-semibold text-sm uppercase tracking-wider mb-3">Past Orders</h2>
                <div className="space-y-3">
                  {pastOrders.map(order => {
                    let items: any[] = [];
                    try { items = JSON.parse(order.items_json); } catch { /* */ }
                    const hasReviewed = reviewedOrders.has(order.id);

                    return (
                      <Card key={order.id} className="bg-gray-900/50 border-gray-800 p-4">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-300 font-medium">#{order.id}</span>
                            <Badge className={`${order.status === 'completed' || order.delivery_status === 'delivered' ? 'bg-gray-700' : 'bg-red-600/20 text-red-400 border border-red-600/30'} text-xs`}>
                              {order.status === 'completed' || order.delivery_status === 'delivered' ? (
                                <><CheckCircle className="w-3 h-3 mr-1" /> Completed</>
                              ) : (
                                <><XCircle className="w-3 h-3 mr-1" /> Cancelled</>
                              )}
                            </Badge>
                          </div>
                          <div className="flex flex-col items-end">
                            {order.delivery_charge > 0 && (
                              <span className="text-[10px] text-gray-500">Delivery: AED {order.delivery_charge?.toFixed(2)}</span>
                            )}
                            {order.tip_amount > 0 && (
                              <span className="text-[10px] text-green-500">Tip: AED {order.tip_amount?.toFixed(2)}</span>
                            )}
                            <span className="text-gray-400 font-medium">AED {order.total_amount?.toFixed(2)}</span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <p className="text-gray-600 text-xs">
                            {formatDateShort(order.created_at)} • {items.length} item{items.length > 1 ? 's' : ''}
                          </p>
                          {(order.status === 'completed' || order.delivery_status === 'delivered') && (
                            hasReviewed ? (
                              <span className="text-green-500 text-xs flex items-center gap-1">
                                <CheckCircle className="w-3 h-3" /> Reviewed
                              </span>
                            ) : (
                              <button
                                onClick={() => navigate(`/feedback?order=${order.id}`)}
                                className="text-yellow-400 text-xs flex items-center gap-1 hover:text-yellow-300 cursor-pointer"
                              >
                                <MessageSquare className="w-3 h-3" /> Give Feedback
                              </button>
                            )
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => hidePastOrder(order.id)}
                          className="mt-3 flex w-full items-center justify-center gap-2 border-t border-gray-800 pt-3 text-xs font-medium text-gray-500 transition hover:text-gray-300"
                        >
                          <EyeOff className="h-3.5 w-3.5" />
                          Remove from list
                        </button>

                        {/* Order Again button for completed orders */}
                        {(order.status === 'completed' || order.delivery_status === 'delivered') && (
                          <div className="mt-3 pt-3 border-t border-gray-800">
                            <Button
                              onClick={() => handleOrderAgain(order)}
                              size="sm"
                              className="w-full bg-red-600 hover:bg-red-700 text-white cursor-pointer"
                            >
                              <ShoppingCart className="w-4 h-4 mr-2" /> Order Again
                            </Button>
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Cancel Dialog */}
        {cancelDialogOrder && (
          <CancelOrderDialog
            orderId={cancelDialogOrder.id}
            orderStatus={cancelDialogOrder.status}
            onCancel={handleCancelOrder}
            onClose={() => setCancelDialogOrder(null)}
          />
        )}
      </div>
    </CustomerLayout>
  );
}
