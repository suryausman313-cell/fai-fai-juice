import { client, CartItem } from '@/lib/api';
import { getAPIBaseURL } from '@/lib/config';

export type RewardTier = 'normal' | 'golden';
export type RewardType = 'percent' | 'fixed' | 'free_ice_cream' | 'golden_free_item';
export type RewardStatus = 'unopened' | 'available' | 'reserved' | 'redeemed' | 'expired';

export interface CustomerReward {
  id: number;
  tier: RewardTier;
  type: RewardType;
  value: number;
  max_discount: number;
  minimum_order: number;
  title: string;
  status: RewardStatus | string;
  expires_at: string | null;
  source_order_id: number;
  opened?: boolean;
}

export interface RewardsPayload {
  enabled: boolean;
  boxes: CustomerReward[];
  available: CustomerReward[];
  history: CustomerReward[];
  gold_progress: number;
  gold_required: number;
  gold_order_min: number;
  gold_window_days: number;
  normal_order_min: number;
}


export interface AdminRewardSettings {
  enabled: boolean;
}

async function adminRewardSettingsRequest(
  method: 'GET' | 'PUT',
  enabled?: boolean,
): Promise<AdminRewardSettings> {
  const token = localStorage.getItem('fai_fai_admin_token') || '';
  if (!token) throw new Error('Admin login required');

  const response = await fetch(
    `${getAPIBaseURL().replace(/\/$/, '')}/api/v1/fai-fai-admin-control/reward-settings`,
    {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'PUT'
        ? { body: JSON.stringify({ enabled: Boolean(enabled) }) }
        : {}),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.detail || payload?.message || `Request failed (${response.status})`,
    );
  }

  return { enabled: payload?.enabled !== false };
}

export async function getAdminRewardSettings(): Promise<AdminRewardSettings> {
  return adminRewardSettingsRequest('GET');
}

export async function updateAdminRewardSettings(enabled: boolean): Promise<AdminRewardSettings> {
  return adminRewardSettingsRequest('PUT', enabled);
}

export async function getRewardsStatus(): Promise<{ enabled: boolean }> {
  const response = await client.apiCall.invoke({ url: '/api/v1/rewards/status', method: 'GET' });
  return response?.data || { enabled: false };
}

export async function getMyRewards(): Promise<RewardsPayload> {
  const response = await client.apiCall.invoke({ url: '/api/v1/rewards/me', method: 'GET' });
  const data = response?.data || {};
  return {
    enabled: data.enabled !== false,
    boxes: Array.isArray(data.boxes) ? data.boxes : [],
    available: Array.isArray(data.available) ? data.available : [],
    history: Array.isArray(data.history) ? data.history : [],
    gold_progress: Number(data.gold_progress || 0),
    gold_required: Number(data.gold_required || 3),
    gold_order_min: Number(data.gold_order_min || 100),
    gold_window_days: Number(data.gold_window_days || 30),
    normal_order_min: Number(data.normal_order_min || 15),
  };
}

export async function openRewardBox(rewardId: number): Promise<CustomerReward> {
  const response = await client.apiCall.invoke({
    url: `/api/v1/rewards/${Number(rewardId)}/open`,
    method: 'POST',
    data: {},
  });
  return response?.data?.reward || response?.data;
}

function containsSmallIceCream(cart: CartItem[]): boolean {
  return cart.some(item => {
    const name = String(item?.menuItem?.name || '').toLowerCase();
    const unit = Number(item?.totalPrice || 0) / Math.max(1, Number(item?.quantity || 1));
    return name.includes('ice cream') && unit <= 5.01;
  });
}

function containsGoldenFreeItem(cart: CartItem[]): boolean {
  const blocked = ['acai', 'smoothie', 'bottle', 'box'];
  return cart.some(item => {
    const name = String(item?.menuItem?.name || '').toLowerCase();
    const unit = Number(item?.totalPrice || 0) / Math.max(1, Number(item?.quantity || 1));
    return unit <= 15.01 && !blocked.some(word => name.includes(word));
  });
}

export function rewardDiscountForCart(reward: CustomerReward, subtotal: number, cart: CartItem[]): number {
  if (!reward || Number(subtotal || 0) + 0.001 < Number(reward.minimum_order || 0)) return 0;
  if (reward.type === 'percent') {
    const raw = Number(subtotal || 0) * Number(reward.value || 0) / 100;
    const cap = Number(reward.max_discount || 0);
    return Math.max(0, cap > 0 ? Math.min(raw, cap) : raw);
  }
  if (reward.type === 'fixed') {
    return Math.max(0, Math.min(Number(subtotal || 0), Number(reward.value || 0)));
  }
  if (reward.type === 'free_ice_cream') {
    return containsSmallIceCream(cart) ? Math.min(Number(subtotal || 0), Number(reward.max_discount || reward.value || 5)) : 0;
  }
  if (reward.type === 'golden_free_item') {
    return containsGoldenFreeItem(cart) ? Math.min(Number(subtotal || 0), Number(reward.max_discount || reward.value || 15)) : 0;
  }
  return 0;
}
