import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  ArrowLeft,
  Banknote,
  BarChart3,
  Bike,
  CalendarDays,
  ChevronRight,
  CircleDollarSign,
  CreditCard,
  Download,
  MapPin,
  PackageCheck,
  Percent,
  RefreshCw,
  Search,
  ShoppingBag,
  TrendingDown,
  TrendingUp,
  Truck,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getAPIBaseURL } from '@/lib/config';

type FinancePeriod =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'month'
  | 'year'
  | 'all'
  | 'custom';

interface FinanceTotals {
  orders: number;
  delivered_orders: number;
  customer_total: number;
  food_subtotal: number;
  discount_amount: number;
  shop_food_sale: number;
  service_fee: number;
  small_order_fee: number;
  developer_fees: number;
  delivery_charges: number;
  rider_tips: number;
  shop_tips: number;
  rider_earnings: number;
  cash_collected: number;
  card_collected: number;
  cash_payable_to_shop: number;
  cash_orders: number;
  card_orders: number;
}

interface FinanceSummary {
  period: {
    key: FinancePeriod;
    label: string;
    date_from: string | null;
    date_to: string | null;
  };
  totals: FinanceTotals;
  settlements?: {
    approved_cash: number;
    awaiting_approval: number;
    rejected_cash: number;
    submissions: number;
  };
  current_balance?: {
    cash_due_to_shop: number;
    approved_cash: number;
    awaiting_approval: number;
    remaining_to_submit: number;
    total_pending_cash: number;
  };
  cash_control?: {
    rider_approved_cash: number;
    pickup_approved_cash: number;
    gross_approved_cash: number;
    cash_refunds: number;
    cash_refund_orders: number;
    net_received: number;
    awaiting_approval: number;
  };
}

interface ReportOrder {
  id: number | string;
  customer_name?: string;
  customer_phone?: string;
  payment_method?: string;
  status?: string;
  order_type?: string;
  total_amount?: number;
  subtotal_amount?: number;
  discount_amount?: number;
  service_fee?: number;
  small_order_fee?: number;
  delivery_charge?: number;
  tip_amount?: number;
  tip_type?: string;
  rider_name?: string;
  order_notes?: string;
  delivery_area_name?: string;
  delivery_country?: string;
  delivery_distance_km?: number | null;
  delivery_zone_name?: string;
  items_json?: string;
  created_at?: string;
  updated_at?: string | null;
  accepted_at?: string | null;
  promised_ready_at?: string | null;
  preparing_at?: string | null;
  ready_at?: string | null;
  rider_picked_up_at?: string | null;
  promised_delivery_at?: string | null;
  delivered_at?: string | null;
}

interface DailyPoint {
  date: string;
  label: string;
  revenue: number;
  orders: number;
}

const PERIODS: Array<{ key: FinancePeriod; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: '7 Days' },
  { key: 'month', label: '30 Days' },
  { key: 'year', label: 'Year' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: 'Custom' },
];

const EMPTY_TOTALS: FinanceTotals = {
  orders: 0,
  delivered_orders: 0,
  customer_total: 0,
  food_subtotal: 0,
  discount_amount: 0,
  shop_food_sale: 0,
  service_fee: 0,
  small_order_fee: 0,
  developer_fees: 0,
  delivery_charges: 0,
  rider_tips: 0,
  shop_tips: 0,
  rider_earnings: 0,
  cash_collected: 0,
  card_collected: 0,
  cash_payable_to_shop: 0,
  cash_orders: 0,
  card_orders: 0,
};

function money(value: unknown): string {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : '0.00';
}

function numeric(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function parseBackendDate(value: string | undefined): Date {
  const raw = String(value || '').trim();
  if (!raw) return new Date(NaN);

  // Python datetime.isoformat() can return UTC timestamps without Z/offset.
  // Treat timezone-less backend timestamps as UTC, then JS converts them to UAE/local time.
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
  return new Date(hasTimezone ? raw : `${raw}Z`);
}

function buildFallbackTotals(orders: ReportOrder[]): FinanceTotals {
  return orders.filter(isCountedOrder).reduce<FinanceTotals>(
    (totals, order) => {
      const customerTotal = numeric(order.total_amount);
      const subtotal = numeric(order.subtotal_amount);
      const discount = numeric(order.discount_amount);
      const serviceFee = numeric(order.service_fee);
      const smallOrderFee = numeric(order.small_order_fee);
      const deliveryCharge = numeric(order.delivery_charge);
      const tip = numeric(order.tip_amount);
      const isDelivery = String(order.order_type || '').toLowerCase() === 'delivery';
      const riderTip = String(order.tip_type || '').toLowerCase() === 'rider' ? tip : 0;
      const shopTip = String(order.tip_type || '').toLowerCase() === 'shop' ? tip : 0;

      totals.orders += 1;
      totals.delivered_orders += isDelivery ? 1 : 0;
      totals.customer_total += customerTotal;
      totals.food_subtotal += subtotal;
      totals.discount_amount += discount;
      totals.shop_food_sale += Math.max(subtotal - discount, 0);
      totals.service_fee += serviceFee;
      totals.small_order_fee += smallOrderFee;
      totals.developer_fees += serviceFee + smallOrderFee;
      totals.delivery_charges += deliveryCharge;
      totals.rider_tips += riderTip;
      totals.shop_tips += shopTip;
      totals.rider_earnings += isDelivery ? deliveryCharge + riderTip : 0;

      if (isCashPayment(order.payment_method)) {
        totals.cash_collected += customerTotal;
        totals.cash_orders += 1;
        // Only delivery cash is physically held by the Rider. Pickup cash is already at the shop.
        if (isDelivery) totals.cash_payable_to_shop += customerTotal;
      } else {
        totals.card_collected += customerTotal;
        totals.card_orders += 1;
      }

      return totals;
    },
    { ...EMPTY_TOTALS },
  );
}

function isCountedOrder(order: ReportOrder): boolean {
  const status = String(order.status || '').toLowerCase();
  return status === 'completed' || status === 'delivered';
}

function reportDateValue(order: ReportOrder): string | undefined {
  return isCountedOrder(order)
    ? (order.delivered_at || order.updated_at || order.created_at)
    : order.created_at;
}

function orderFoodSale(order: ReportOrder): number {
  const subtotal = numeric(order.subtotal_amount);
  const discount = numeric(order.discount_amount);
  if (subtotal > 0) return Math.max(subtotal - discount, 0);
  return Math.max(
    numeric(order.total_amount)
      - numeric(order.service_fee)
      - numeric(order.small_order_fee)
      - numeric(order.delivery_charge)
      - numeric(order.tip_amount),
    0,
  );
}

function isCashPayment(method: string | undefined): boolean {
  return String(method || '').toLowerCase().includes('cash');
}

function paymentLabel(method: string | undefined): string {
  return isCashPayment(method) ? 'Cash' : 'Online Payment';
}

function parseOrderItems(order: ReportOrder): any[] {
  try {
    const parsed = JSON.parse(String(order.items_json || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isDeliveryReportOrder(order: ReportOrder): boolean {
  const explicit = String(order.order_type || '').toLowerCase().trim();
  if (explicit === 'delivery') return true;
  const notes = String(order.order_notes || '').toLowerCase();
  const payment = String(order.payment_method || '').toLowerCase();
  return (
    notes.includes('order type: delivery') ||
    notes.includes('delivery address:') ||
    payment.includes('cash on delivery') ||
    payment.includes('card on delivery')
  );
}


function formatDate(value: string | undefined): string {
  if (!value) return '-';
  try {
    return parseBackendDate(value).toLocaleString('en-AE', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return value;
  }
}

function dateKey(value: string | undefined): string {
  if (!value) return '';
  const date = parseBackendDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}


function minutesBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const startMs = parseBackendDate(start || undefined).getTime();
  const endMs = parseBackendDate(end || undefined).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.round((endMs - startMs) / 60_000);
}

function timingResult(actual?: string | null, promised?: string | null): {
  text: string;
  className: string;
} | null {
  const difference = minutesBetween(promised, actual);
  if (difference === null) return null;
  if (difference > 0) return { text: `${difference} min late`, className: 'text-red-400' };
  if (difference < 0) return { text: `${Math.abs(difference)} min early`, className: 'text-green-400' };
  return { text: 'On time', className: 'text-green-400' };
}

function orderAreaName(order: ReportOrder): string {
  const direct = String(order.delivery_area_name || '').trim();
  if (direct) return direct;
  const notes = String(order.order_notes || '');
  const match = notes.match(/(?:^|\|)\s*Zone:\s*([^|]+)/i);
  if (match?.[1]) return match[1].trim();
  const legacy = String(order.delivery_zone_name || '').trim();
  return legacy || 'Unknown Area';
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

export default function AdminSales() {
  const navigate = useNavigate();
  const [selectedReportOrder, setSelectedReportOrder] = useState<ReportOrder | null>(null);

  const [period, setPeriod] = useState<FinancePeriod>('today');
  const [customFrom, setCustomFrom] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [customTo, setCustomTo] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [orders, setOrders] = useState<ReportOrder[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    try {
      const auth = JSON.parse(localStorage.getItem('admin_auth') || '{}');
      if (!auth.loggedIn) {
        navigate('/admin');
        return;
      }
    } catch {
      navigate('/admin');
      return;
    }

    void loadData();
  }, []);

  useEffect(() => {
    if (period === 'custom') return;
    void loadData(true);
  }, [period]);

  function summaryUrl(): string {
    const params = new URLSearchParams({ period });
    if (period === 'custom') {
      params.set('date_from', customFrom);
      params.set('date_to', customTo);
    }
    return `/api/v1/finance/admin/summary?${params.toString()}`;
  }

  async function loadData(silent = false): Promise<void> {
    if (period === 'custom' && (!customFrom || !customTo)) {
      toast.error('Select both custom dates');
      return;
    }

    if (!silent) setLoading(true);
    else setRefreshing(true);

    try {
      const baseURL = getAPIBaseURL().replace(/\/$/, '');
      const token = localStorage.getItem('fai_fai_admin_token') || '';
      const adminHeaders = { Authorization: `Bearer ${token}` };
      const [summaryResult, ordersResult] = await Promise.allSettled([
        axios.get(`${baseURL}${summaryUrl()}`, {
          headers: adminHeaders,
          timeout: 20000,
        }),
        axios.get(`${baseURL}/api/v1/admin/orders`, {
          params: { sort: '-created_at', limit: 2000 },
          headers: adminHeaders,
          timeout: 20000,
        }),
      ]);

      if (summaryResult.status === 'fulfilled') {
        setSummary(summaryResult.value.data as FinanceSummary);
      } else {
        console.error('Finance summary failed:', summaryResult.reason);
        setSummary(null);
        // The detailed orders endpoint is independent. If finance summary fails,
        // the screen will calculate the visible sales totals from those orders
        // instead of incorrectly showing AED 0.00 everywhere.
        // Sales totals are calculated from detailed orders; no user-facing error needed.
      }

      if (ordersResult.status === 'fulfilled') {
        setOrders((ordersResult.value.data?.items || []) as ReportOrder[]);
      } else {
        console.error('Orders report failed:', ordersResult.reason);
        toast.error('Could not load order details');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const periodOrders = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const nextDay = new Date(todayStart);
    nextDay.setDate(nextDay.getDate() + 1);

    return orders.filter(order => {
      const created = parseBackendDate(reportDateValue(order));
      if (Number.isNaN(created.getTime())) return false;

      if (period === 'today') {
        return created >= todayStart && created < nextDay;
      }

      if (period === 'yesterday') {
        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        return created >= yesterdayStart && created < todayStart;
      }

      if (period === 'week') {
        const start = new Date(todayStart);
        start.setDate(start.getDate() - 6);
        return created >= start;
      }

      if (period === 'month') {
        const start = new Date(todayStart);
        start.setDate(start.getDate() - 29);
        return created >= start;
      }

      if (period === 'year') {
        return created.getFullYear() === now.getFullYear();
      }

      if (period === 'custom') {
        const from = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
        const to = customTo ? new Date(`${customTo}T23:59:59`) : null;
        return (!from || created >= from) && (!to || created <= to);
      }

      return true;
    });
  }, [orders, period, customFrom, customTo]);

  const visibleOrders = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return periodOrders;

    return periodOrders.filter(order =>
      [
        order.id,
        order.customer_name,
        order.customer_phone,
        order.payment_method,
        order.status,
        order.rider_name,
      ]
        .map(value => String(value || '').toLowerCase())
        .some(value => value.includes(query)),
    );
  }, [periodOrders, search]);

  const countedOrders = useMemo(
    () => periodOrders.filter(isCountedOrder),
    [periodOrders],
  );


  const bestSellers = useMemo(() => {
    const items = new Map<string, { quantity: number; revenue: number }>();

    countedOrders.forEach(order => {
      try {
        const parsed = JSON.parse(order.items_json || '[]');
        if (!Array.isArray(parsed)) return;

        parsed.forEach((item: any) => {
          const name = String(item.name || 'Unknown item');
          const quantity = Math.max(1, numeric(item.quantity));
          const price = numeric(item.price);
          const current = items.get(name) || { quantity: 0, revenue: 0 };
          current.quantity += quantity;
          current.revenue += price;
          items.set(name, current);
        });
      } catch {
        // Ignore invalid historical item JSON.
      }
    });

    return [...items.entries()]
      .map(([name, values]) => ({ name, ...values }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 8);
  }, [countedOrders]);

  const statusBreakdown = useMemo(() => {
    const result = new Map<string, number>();
    periodOrders.forEach(order => {
      const status = String(order.status || 'unknown').toLowerCase();
      result.set(status, (result.get(status) || 0) + 1);
    });
    return [...result.entries()].sort((a, b) => b[1] - a[1]);
  }, [periodOrders]);

  const dailyTrend = useMemo<DailyPoint[]>(() => {
    const grouped = new Map<string, DailyPoint>();

    countedOrders.forEach(order => {
      const key = dateKey(reportDateValue(order));
      if (!key) return;

      const current = grouped.get(key) || {
        date: key,
        label: new Date(`${key}T00:00:00`).toLocaleDateString('en-AE', {
          day: '2-digit',
          month: 'short',
        }),
        revenue: 0,
        orders: 0,
      };

      current.revenue += orderFoodSale(order);
      current.orders += 1;
      grouped.set(key, current);
    });

    return [...grouped.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14);
  }, [countedOrders]);

  const maxDailyRevenue = Math.max(
    1,
    ...dailyTrend.map(point => point.revenue),
  );
  const locationStats = useMemo(() => {
    const grouped = new Map<string, { sales: number; orders: number; distanceTotal: number; distanceCount: number }>();
    countedOrders.forEach(order => {
      if (!isDeliveryReportOrder(order)) return;
      const area = orderAreaName(order);
      const current = grouped.get(area) || { sales: 0, orders: 0, distanceTotal: 0, distanceCount: 0 };
      current.sales += orderFoodSale(order);
      current.orders += 1;
      const distance = Number(order.delivery_distance_km);
      if (Number.isFinite(distance) && distance > 0) { current.distanceTotal += distance; current.distanceCount += 1; }
      grouped.set(area, current);
    });
    return [...grouped.entries()].map(([area, value]) => ({
      area, sales: value.sales, orders: value.orders,
      averageDistance: value.distanceCount ? value.distanceTotal / value.distanceCount : null,
    })).sort((a, b) => b.sales - a.sales);
  }, [countedOrders]);


  const fallbackTotals = useMemo(
    () => buildFallbackTotals(periodOrders),
    [periodOrders],
  );
  const totals = useMemo(
    () => summary?.totals ? { ...EMPTY_TOTALS, ...summary.totals } : fallbackTotals,
    [summary, fallbackTotals],
  );
  const averageOrder =
    totals.orders > 0 ? totals.customer_total / totals.orders : 0;
  const cashControl = summary?.cash_control;
  const adminCashReceived = cashControl ? numeric(cashControl.net_received) : 0;
  const adminCashWaiting = cashControl ? numeric(cashControl.awaiting_approval) : 0;
  const cashRefunds = cashControl ? numeric(cashControl.cash_refunds) : 0;

  // Service Fee is displayed as one combined customer charge.
  // Small Order Fee is included here and must NOT be added again elsewhere.
  const serviceFeeTotal =
    numeric(totals.service_fee) + numeric(totals.small_order_fee);

  // VAT is already included in the product prices, so it is intentionally
  // NOT added as a separate amount in the sales reconciliation.
  const salesBreakdownTotal =
    numeric(totals.shop_food_sale) +
    serviceFeeTotal +
    numeric(totals.delivery_charges) +
    numeric(totals.shop_tips) +
    numeric(totals.rider_tips);

  const salesDifference =
    Math.round((numeric(totals.customer_total) - salesBreakdownTotal) * 100) / 100;

  // Rider settlement is handled by the existing Rider/Admin Rider report.
  // Therefore delivery charges and rider tips are NOT included in Shop Payable.
  const shopPayable =
    numeric(totals.shop_food_sale) + numeric(totals.shop_tips);

  const paymentDifference =
    Math.round(
      (numeric(totals.customer_total) -
        numeric(totals.cash_collected) -
        numeric(totals.card_collected)) *
        100,
    ) / 100;

  function exportCsv(): void {
    const headers = [
      'Order ID',
      'Date',
      'Customer',
      'Phone',
      'Payment',
      'Status',
      'Order Type',
      'Subtotal',
      'Discount',
      'Service Fee',
      'Small Order Fee',
      'Delivery Charge',
      'Tip',
      'Customer Total',
      'Rider',
      'Delivery Area',
      'Road Distance Km',
    ];

    const rows = visibleOrders.map(order => [
      order.id,
      reportDateValue(order),
      order.customer_name,
      order.customer_phone,
      paymentLabel(order.payment_method),
      order.status,
      order.order_type,
      numeric(order.subtotal_amount),
      numeric(order.discount_amount),
      numeric(order.service_fee),
      numeric(order.small_order_fee),
      numeric(order.delivery_charge),
      numeric(order.tip_amount),
      numeric(order.total_amount),
      order.rider_name,
      orderAreaName(order),
      order.delivery_distance_km ?? '',
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(escapeCsv).join(','))
      .join('\n');

    const blob = new Blob([csv], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `fai-fai-sales-${period}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success('Sales report downloaded');
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">Loading complete sales report...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 px-4 py-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-start gap-3 mb-5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/admin/dashboard')}
            className="text-gray-400 hover:text-white mt-0.5"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>

          <div className="flex-1">
            <h1 className="text-white text-2xl font-bold">Sales & Reports <span className="text-[10px] text-emerald-400">FINAL V5</span></h1>
            <p className="text-gray-500 text-xs mt-1">
              Complete Fai Fai revenue, fees, payment and rider report
            </p>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadData(true)}
            disabled={refreshing}
            className="text-gray-400 hover:text-white"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>

          <Button
            size="sm"
            onClick={exportCsv}
            className="bg-emerald-600 hover:bg-emerald-500"
          >
            <Download className="w-4 h-4 mr-2" />
            CSV
          </Button>
        </div>

        <Card className="bg-gray-900 border-gray-800 p-3 mb-5">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {PERIODS.map(option => (
              <button
                key={option.key}
                onClick={() => setPeriod(option.key)}
                className={`px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition ${
                  period === option.key
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {period === 'custom' && (
            <div className="grid grid-cols-2 md:grid-cols-[1fr_1fr_auto] gap-2 mt-3">
              <Input
                type="date"
                value={customFrom}
                onChange={event => setCustomFrom(event.target.value)}
                className="bg-gray-950 border-gray-700 text-white"
              />
              <Input
                type="date"
                value={customTo}
                onChange={event => setCustomTo(event.target.value)}
                className="bg-gray-950 border-gray-700 text-white"
              />
              <Button
                onClick={() => void loadData(true)}
                className="col-span-2 md:col-span-1 bg-emerald-600 hover:bg-emerald-500"
              >
                Apply Dates
              </Button>
            </div>
          )}
        </Card>

        {/* ================= SALES & SETTLEMENT SUMMARY ================= */}
        <div className="grid lg:grid-cols-[1.35fr_1fr] gap-4 mb-5">
          {/* TOTAL CUSTOMER PAID */}
          <Card className="relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-900 to-emerald-950/40 border-gray-800 p-5">
            <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-emerald-500/5 blur-3xl" />
            <div className="relative">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-emerald-300 text-[11px] font-bold uppercase tracking-wider">
                    Total Customer Paid
                  </p>
                  <p className="text-gray-500 text-xs mt-1">
                    Completed sales for {summary?.period?.label || 'selected period'}
                  </p>
                </div>
                <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                  <CircleDollarSign className="w-5 h-5 text-emerald-400" />
                </div>
              </div>

              <div className="mt-5 flex items-end justify-between gap-4">
                <div>
                  <p className="text-white text-4xl font-black tracking-tight">
                    AED {money(totals.customer_total)}
                  </p>
                  <p className="text-gray-500 text-xs mt-2">
                    {totals.orders} completed orders
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-gray-500 text-[10px] uppercase">Average Order</p>
                  <p className="text-white font-bold mt-1">AED {money(averageOrder)}</p>
                </div>
              </div>
            </div>
          </Card>

          {/* PAYMENT BREAKDOWN */}
          <Card className="bg-gray-900 border-gray-800 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-white font-bold">Payment Breakdown</p>
                <p className="text-gray-500 text-xs mt-1">How customers paid</p>
              </div>
              <Wallet className="w-5 h-5 text-gray-500" />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl bg-gray-950/70 border border-gray-800 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-green-500/10 flex items-center justify-center">
                    <Banknote className="w-4 h-4 text-green-400" />
                  </div>
                  <div>
                    <p className="text-white text-sm font-semibold">Cash</p>
                    <p className="text-gray-600 text-[10px]">{totals.cash_orders} orders</p>
                  </div>
                </div>
                <p className="text-green-400 font-black">AED {money(totals.cash_collected)}</p>
              </div>

              <div className="flex items-center justify-between rounded-xl bg-gray-950/70 border border-gray-800 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-blue-500/10 flex items-center justify-center">
                    <CreditCard className="w-4 h-4 text-blue-400" />
                  </div>
                  <div>
                    <p className="text-white text-sm font-semibold">Visa / Online</p>
                    <p className="text-gray-600 text-[10px]">{totals.card_orders} orders</p>
                  </div>
                </div>
                <p className="text-blue-400 font-black">AED {money(totals.card_collected)}</p>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-gray-800">
                <p className="text-gray-400 text-xs font-semibold">Total Paid</p>
                <p className="text-white font-black">
                  AED {money(numeric(totals.cash_collected) + numeric(totals.card_collected))}
                </p>
              </div>

              <div className={`text-[10px] font-semibold text-right ${Math.abs(paymentDifference) < 0.01 ? 'text-emerald-400' : 'text-red-400'}`}>
                {Math.abs(paymentDifference) < 0.01
                  ? '✓ Payment total matches customer paid'
                  : `⚠ Payment difference AED ${money(paymentDifference)}`}
              </div>
            </div>
          </Card>
        </div>

        {/* ================= CUSTOMER SALE + SHOP SETTLEMENT ================= */}
        <Card className="bg-gray-900 border-gray-800 overflow-hidden mb-5">
          <div className="p-5 border-b border-gray-800">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
                <ShoppingBag className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <h2 className="text-white font-bold">Sales Breakdown</h2>
                <p className="text-gray-500 text-xs mt-1">
                  Clear customer sale and shop settlement
                </p>
              </div>
            </div>
          </div>

          <div className="p-5 grid lg:grid-cols-2 gap-5">
            {/* CUSTOMER SALE */}
            <div className="rounded-2xl bg-gray-950/60 border border-gray-800 p-4">
              <p className="text-gray-500 text-[10px] uppercase font-bold tracking-wider mb-4">
                Customer Sale
              </p>

              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-gray-300 text-sm">Food Sale</span>
                  <span className="text-white font-bold">AED {money(totals.shop_food_sale)}</span>
                </div>

                <div className="flex justify-between items-center gap-4">
                  <div>
                    <span className="text-gray-300 text-sm">Service Fee</span>
                    <p className="text-gray-600 text-[10px]">Small Order Fee included</p>
                  </div>
                  <span className="text-amber-300 font-bold">AED {money(serviceFeeTotal)}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-gray-300 text-sm">Delivery Charges</span>
                  <span className="text-purple-300 font-bold">AED {money(totals.delivery_charges)}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-gray-300 text-sm">Shop Tip</span>
                  <span className="text-green-300 font-bold">AED {money(totals.shop_tips)}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-gray-300 text-sm">Rider Tip</span>
                  <span className="text-pink-300 font-bold">AED {money(totals.rider_tips)}</span>
                </div>

                <div className="border-t border-gray-800 pt-3 flex justify-between items-center">
                  <span className="text-white font-bold">Customer Paid</span>
                  <span className="text-emerald-400 text-xl font-black">
                    AED {money(totals.customer_total)}
                  </span>
                </div>

                <div className={`rounded-xl border px-3 py-2.5 ${
                  Math.abs(salesDifference) < 0.01
                    ? 'bg-emerald-500/5 border-emerald-900/40'
                    : 'bg-red-500/5 border-red-900/40'
                }`}>
                  <div className="flex justify-between items-center gap-3">
                    <span className="text-gray-500 text-[10px]">Sales Check</span>
                    <span className={`text-[10px] font-black ${
                      Math.abs(salesDifference) < 0.01 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {Math.abs(salesDifference) < 0.01
                        ? '✓ AED 0.00 Difference'
                        : `⚠ AED ${money(salesDifference)} Difference`}
                    </span>
                  </div>
                </div>

                <p className="text-gray-600 text-[10px] leading-relaxed">
                  VAT is already included in product prices and is not added again here.
                </p>
              </div>
            </div>

            {/* SHOP SETTLEMENT */}
            <div className="rounded-2xl bg-gradient-to-br from-emerald-950/30 to-gray-950/60 border border-emerald-900/40 p-4">
              <p className="text-gray-500 text-[10px] uppercase font-bold tracking-wider mb-4">
                Shop Settlement
              </p>

              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-gray-300 text-sm">Food Sale</span>
                  <span className="text-white font-bold">AED {money(totals.shop_food_sale)}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-gray-300 text-sm">Shop Tip</span>
                  <span className="text-green-300 font-bold">AED {money(totals.shop_tips)}</span>
                </div>

                <div className="border-t border-gray-800 pt-4 mt-2">
                  <p className="text-gray-500 text-[10px] uppercase">Shop Payable</p>
                  <p className="text-emerald-400 text-3xl font-black mt-1">
                    AED {money(shopPayable)}
                  </p>
                </div>

              </div>
            </div>
          </div>
        </Card>

        {/* EXISTING CASH CONTROL */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
          <Card className="bg-gray-900 border-gray-800 p-4">
            <div className="flex items-center justify-between">
              <p className="text-gray-400 text-[11px] uppercase">Admin Cash Received</p>
              <Banknote className="w-4 h-4 text-green-400" />
            </div>
            <p className="text-green-400 text-xl font-black mt-2">AED {money(adminCashReceived)}</p>
            <p className="text-gray-500 text-[11px] mt-1">
              Approved Kitchen + Rider cash − refunds
              {cashRefunds > 0 ? ` AED ${money(cashRefunds)}` : ''}
              {adminCashWaiting > 0 ? ` · Waiting AED ${money(adminCashWaiting)}` : ''}
            </p>
          </Card>

          <Card className="bg-gray-900 border-gray-800 p-4">
            <div className="flex items-center justify-between">
              <p className="text-gray-400 text-[11px] uppercase">Online Payment</p>
              <CreditCard className="w-4 h-4 text-blue-400" />
            </div>
            <p className="text-blue-400 text-xl font-black mt-2">AED {money(totals.card_collected)}</p>
            <p className="text-gray-500 text-[11px] mt-1">
              Completed online orders · {totals.card_orders} orders
            </p>
          </Card>

          <Card className="bg-gray-900 border-gray-800 p-4">
            <div className="flex items-center justify-between">
              <p className="text-gray-400 text-[11px] uppercase">Completed Orders</p>
              <ShoppingBag className="w-4 h-4 text-cyan-400" />
            </div>
            <p className="text-white text-xl font-black mt-2">{totals.orders}</p>
            <p className="text-gray-500 text-[11px] mt-1">Counted on completion date</p>
          </Card>
        </div>

        <div className="grid lg:grid-cols-2 gap-4 mb-4">
          <Card className="bg-gray-900 border-gray-800 p-4">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <h2 className="text-white font-semibold">Sales Trend</h2>
            </div>

            {dailyTrend.length === 0 ? (
              <div className="h-44 flex items-center justify-center text-gray-600 text-sm">
                No sales in this period
              </div>
            ) : (
              <div className="h-44 flex items-end gap-2 overflow-x-auto pb-1">
                {dailyTrend.map(point => (
                  <div
                    key={point.date}
                    className="min-w-[38px] flex-1 h-full flex flex-col justify-end items-center gap-1"
                    title={`${point.label}: AED ${money(point.revenue)} · ${point.orders} orders`}
                  >
                    <span className="text-gray-500 text-[9px]">
                      {point.orders}
                    </span>
                    <div
                      className="w-full max-w-[34px] bg-emerald-500/70 rounded-t-lg min-h-[4px]"
                      style={{
                        height: `${Math.max(
                          4,
                          (point.revenue / maxDailyRevenue) * 125,
                        )}px`,
                      }}
                    />
                    <span className="text-gray-600 text-[9px] whitespace-nowrap">
                      {point.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card className="bg-gray-900 border-gray-800 p-4 mb-4">
          <div className="flex items-center gap-2 mb-4">
            <MapPin className="w-4 h-4 text-orange-400" />
            <div>
              <h2 className="text-white font-semibold">Sales by Location</h2>
              <p className="text-gray-500 text-xs">Delivery area saved from the customer's actual order pin</p>
            </div>
          </div>
          {locationStats.length === 0 ? (
            <p className="text-gray-600 text-sm">No delivery-location sales in this period</p>
          ) : (
            <div className="divide-y divide-gray-800 border border-gray-800 rounded-xl overflow-hidden">
              {locationStats.map(item => (
                <div key={item.area} className="flex items-center gap-3 px-4 py-3 bg-gray-950/50">
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium truncate">{item.area}</p>
                    <p className="text-gray-500 text-xs">{item.orders} orders{item.averageDistance !== null ? ` · avg road ${item.averageDistance.toFixed(1)} km` : ''}</p>
                  </div>
                  <p className="text-white font-bold">AED {money(item.sales)}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="grid lg:grid-cols-2 gap-4 mb-4">
          <Card className="bg-gray-900 border-gray-800 p-4">
            <div className="flex items-center gap-2 mb-4">
              <ShoppingBag className="w-4 h-4 text-cyan-400" />
              <h2 className="text-white font-semibold">Best Sellers</h2>
            </div>

            {bestSellers.length === 0 ? (
              <p className="text-gray-600 text-sm">No item sales in this period</p>
            ) : (
              <div className="space-y-2">
                {bestSellers.map((item, index) => (
                  <div
                    key={item.name}
                    className="flex items-center gap-3 bg-gray-950/70 rounded-xl px-3 py-2.5"
                  >
                    <span className="w-6 h-6 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-bold flex items-center justify-center">
                      {index + 1}
                    </span>
                    <span className="text-gray-200 text-sm flex-1 truncate">
                      {item.name}
                    </span>
                    <span className="text-white text-sm font-bold">
                      {item.quantity}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="bg-gray-900 border-gray-800 p-4">
            <div className="flex items-center gap-2 mb-4">
              <CalendarDays className="w-4 h-4 text-purple-400" />
              <h2 className="text-white font-semibold">Order Status</h2>
            </div>

            {statusBreakdown.length === 0 ? (
              <p className="text-gray-600 text-sm">No orders in this period</p>
            ) : (
              <div className="space-y-2">
                {statusBreakdown.map(([status, count]) => (
                  <div
                    key={status}
                    className="flex items-center justify-between bg-gray-950/70 rounded-xl px-3 py-2.5"
                  >
                    <span className="text-gray-300 text-sm capitalize">{status}</span>
                    <span className="text-white font-bold">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card className="bg-gray-900 border-gray-800 overflow-hidden">
          <div className="p-4 border-b border-gray-800">
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <div>
                <h2 className="text-white font-semibold">Order Report</h2>
                <p className="text-gray-500 text-xs mt-1">
                  Showing {visibleOrders.length} orders
                </p>
              </div>

              <div className="md:ml-auto relative w-full md:w-80">
                <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <Input
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Order, customer, phone, payment..."
                  className="pl-9 bg-gray-950 border-gray-700 text-white"
                />
              </div>
            </div>
          </div>

          {visibleOrders.length === 0 ? (
            <div className="p-10 text-center text-gray-600">
              No matching orders
            </div>
          ) : (
            <div className="divide-y divide-gray-800">
              {visibleOrders.slice(0, 300).map(order => (
                <button
                  key={String(order.id)}
                  type="button"
                  onClick={() => setSelectedReportOrder(order)}
                  className="w-full p-4 text-left hover:bg-gray-800/30 transition-colors cursor-pointer"
                  aria-label={`Open details for order ${order.id}`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                        isCashPayment(order.payment_method)
                          ? 'bg-green-500/10'
                          : 'bg-blue-500/10'
                      }`}
                    >
                      {isCashPayment(order.payment_method) ? (
                        <Banknote className="w-5 h-5 text-green-400" />
                      ) : (
                        <CreditCard className="w-5 h-5 text-blue-400" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-white font-semibold">
                          Order #{order.id}
                        </span>
                        <span className="text-gray-500 text-xs capitalize">
                          {order.status || 'unknown'}
                        </span>
                        <span className="text-gray-600 text-xs">
                          {order.order_type || ''}
                        </span>
                      </div>

                      <p className="text-gray-300 text-sm mt-1 truncate">
                        {order.customer_name || 'Guest'} · {paymentLabel(order.payment_method)}
                      </p>
                      <p className="text-gray-600 text-[11px] mt-1">
                        {formatDate(reportDateValue(order))}
                      </p>
                      {(() => {
                        const kitchenResult = timingResult(order.ready_at, order.promised_ready_at);
                        const deliveryResult = timingResult(order.delivered_at, order.promised_delivery_at);
                        const kitchenActual = minutesBetween(order.accepted_at, order.ready_at);
                        const riderActual = minutesBetween(order.rider_picked_up_at, order.delivered_at);
                        const totalActual = minutesBetween(order.created_at, order.delivered_at);

                        if (!kitchenResult && !deliveryResult && kitchenActual === null && riderActual === null && totalActual === null) {
                          return null;
                        }

                        return (
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                            {kitchenActual !== null && <span className="text-gray-400">Kitchen time: {kitchenActual} min</span>}
                            {kitchenResult && <span className={kitchenResult.className}>Kitchen: {kitchenResult.text}</span>}
                            {riderActual !== null && <span className="text-gray-400">Rider delivery: {riderActual} min</span>}
                            {deliveryResult && <span className={deliveryResult.className}>Delivery: {deliveryResult.text}</span>}
                            {totalActual !== null && <span className="text-blue-400">Order → Delivered: {totalActual} min</span>}
                          </div>
                        );
                      })()}
                    </div>

                    <div className="text-right">
                      <p className="text-white font-black">
                        AED {money(order.total_amount)}
                      </p>
                      <p className="text-gray-600 text-[10px] mt-1">
                        Fees AED {money(
                          numeric(order.service_fee) +
                            numeric(order.small_order_fee) +
                            numeric(order.delivery_charge),
                        )}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        {selectedReportOrder && (() => {
          const order = selectedReportOrder;
          const items = parseOrderItems(order);
          const itemSubtotal = numeric(order.subtotal_amount) || items.reduce((sum, item) => {
            const qty = Math.max(1, numeric(item?.quantity) || 1);
            return sum + numeric(item?.price) * qty;
          }, 0);

          return (
            <div
              className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
              onClick={() => setSelectedReportOrder(null)}
            >
              <div
                className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-gray-700 bg-gray-950 p-5 shadow-2xl"
                onClick={event => event.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-4 mb-5">
                  <div>
                    <h2 className="text-white text-xl font-black">Order #{order.id}</h2>
                    <p className="text-gray-500 text-xs mt-1">{formatDate(reportDateValue(order))}</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedReportOrder(null)}
                    className="border-gray-700 text-gray-300"
                  >
                    Close
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-4 text-sm">
                  <div className="rounded-xl bg-gray-900 p-3"><p className="text-gray-500 text-xs">Status</p><p className="text-white font-semibold capitalize mt-1">{order.status || '-'}</p></div>
                  <div className="rounded-xl bg-gray-900 p-3"><p className="text-gray-500 text-xs">Order Type</p><p className="text-white font-semibold capitalize mt-1">{order.order_type || '-'}</p></div>
                  <div className="rounded-xl bg-gray-900 p-3"><p className="text-gray-500 text-xs">Payment</p><p className="text-white font-semibold mt-1">{paymentLabel(order.payment_method)}</p></div>
                  <div className="rounded-xl bg-gray-900 p-3"><p className="text-gray-500 text-xs">Total</p><p className="text-emerald-400 font-black mt-1">AED {money(order.total_amount)}</p></div>
                </div>

                <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-4 mb-4">
                  <h3 className="text-white font-semibold mb-3">Customer</h3>
                  <p className="text-gray-300">{order.customer_name || 'Guest'}</p>
                  <p className="text-gray-500 text-sm mt-1">{order.customer_phone || 'No phone'}</p>
                  {order.delivery_area_name && <p className="text-gray-500 text-sm mt-1">Area: {order.delivery_area_name}</p>}
                </div>

                <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-4 mb-4">
                  <h3 className="text-white font-semibold mb-3">Items</h3>
                  {items.length === 0 ? (
                    <p className="text-gray-500 text-sm">Item details unavailable</p>
                  ) : (
                    <div className="space-y-3">
                      {items.map((item, index) => (
                        <div key={`${item?.id || item?.name || 'item'}-${index}`} className="border-b border-gray-800 pb-3 last:border-0 last:pb-0">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-white font-medium">{numeric(item?.quantity) || 1}× {item?.name || 'Item'}</p>
                              {item?.size && <p className="text-gray-500 text-xs mt-1">Size: {item.size}</p>}
                              {Array.isArray(item?.extras) && item.extras.length > 0 && <p className="text-gray-500 text-xs mt-1">Extras: {item.extras.join(', ')}</p>}
                            </div>
                            <p className="text-white font-semibold">AED {money(numeric(item?.price) * Math.max(1, numeric(item?.quantity) || 1))}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-4 space-y-2 text-sm">
                  <div className="flex justify-between text-gray-300"><span>Items</span><span>AED {money(itemSubtotal)}</span></div>
                  {numeric(order.discount_amount) > 0 && <div className="flex justify-between text-green-400"><span>Discount</span><span>- AED {money(order.discount_amount)}</span></div>}
                  {numeric(order.service_fee) > 0 && <div className="flex justify-between text-gray-300"><span>Service Fee</span><span>AED {money(order.service_fee)}</span></div>}
                  {numeric(order.small_order_fee) > 0 && <div className="flex justify-between text-gray-300"><span>Small Order Fee</span><span>AED {money(order.small_order_fee)}</span></div>}
                  {numeric(order.delivery_charge) > 0 && <div className="flex justify-between text-gray-300"><span>Delivery</span><span>AED {money(order.delivery_charge)}</span></div>}
                  {numeric(order.tip_amount) > 0 && <div className="flex justify-between text-gray-300"><span>Tip{order.tip_type ? ` (${order.tip_type})` : ''}</span><span>AED {money(order.tip_amount)}</span></div>}
                  <div className="border-t border-gray-700 pt-2 mt-2 flex justify-between text-white font-black text-base"><span>Customer Paid</span><span>AED {money(order.total_amount)}</span></div>
                </div>

                {order.order_notes && (
                  <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-4 mt-4">
                    <h3 className="text-white font-semibold mb-2">Order Notes</h3>
                    <p className="text-gray-400 text-sm whitespace-pre-wrap">{order.order_notes}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
