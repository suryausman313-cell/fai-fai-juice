import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from 'sonner';
import { MapPin, Car, Tag, Navigation, CheckCircle, X } from 'lucide-react';
import CustomerLayout from '@/components/CustomerLayout';
import { useBranch } from '@/contexts/BranchContext';
import { backendRequest, client, CartItem, Offer, localizedMenuText } from '@/lib/api';
import { getCart, getCartTotal, getCartOriginalTotal, getCartItemDiscountTotal, clearCart } from '@/lib/cart-store';
import { useTranslation } from '@/lib/i18n';
import { isPromoOfferCurrentlyActive } from '@/lib/discounts';
import { getGuestSessionId } from '@/lib/guest-session';
import { getAPIBaseURL } from '@/lib/config';
import { CustomerReward, getMyRewards, rewardDiscountForCart } from '@/lib/rewards';
import { useCustomerAuth } from '@/contexts/CustomerAuthContext';
import { DeviceLocationError, getCurrentDeviceLocation } from '@/lib/device-location';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix leaflet default marker icon
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

function isWithinDailySchedule(start: string, end: string, now: Date): boolean {
  const toMinutes = (value: string) => {
    const [hours, minutes] = value.split(':').map(Number);
    return Number.isFinite(hours) && Number.isFinite(minutes)
      ? hours * 60 + minutes
      : -1;
  };
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (startMinutes < 0 || endMinutes < 0 || startMinutes === endMinutes) return true;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return endMinutes < startMinutes
    ? currentMinutes >= startMinutes || currentMinutes < endMinutes
    : currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function localizedRewardTitle(reward: CustomerReward, language: string): string {
  if (language !== 'ar') return reward.title;
  if (reward.type === 'free_ice_cream') return 'آيس كريم صغير مجاناً';
  if (reward.type === 'golden_free_item') return 'ذهبي: منتج مختار مجاناً حتى 15 درهماً';
  if (reward.type === 'fixed') return reward.tier === 'golden'
    ? `ذهبي: خصم ${Number(reward.value || 0).toFixed(0)} درهم`
    : `خصم ${Number(reward.value || 0).toFixed(0)} درهم`;
  if (reward.type === 'percent') {
    const cap = Number(reward.max_discount || 0);
    return reward.tier === 'golden'
      ? `ذهبي: خصم ${Number(reward.value || 0).toFixed(0)}%${cap > 0 ? ` حتى ${cap.toFixed(0)} درهماً` : ''}`
      : `خصم ${Number(reward.value || 0).toFixed(0)}%${cap > 0 ? ` حتى ${cap.toFixed(0)} دراهم` : ''}`;
  }
  return reward.title;
}

function formatScheduleTime(value: string, language: string): string {
  const [hours, minutes] = value.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return value;
  const suffix = language === 'ar'
    ? (hours >= 12 ? 'م' : 'ص')
    : (hours >= 12 ? 'PM' : 'AM');
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

type SavedDeliveryLocation = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address: string;
};

const SAVED_DELIVERY_LOCATIONS_KEY = 'vita_saved_delivery_locations_v3';
const OLD_SAVED_DELIVERY_LOCATIONS_KEY = 'vita_saved_delivery_locations_v2';
const LEGACY_SAVED_DELIVERY_LOCATION_KEY = 'vita_saved_delivery_location';
const MAX_SAVED_DELIVERY_LOCATIONS = 10;

function cleanSavedLocationName(value: unknown): string {
  return String(value || '').trim().slice(0, 30);
}

function readSavedDeliveryLocations(): SavedDeliveryLocation[] {
  try {
    const raw = localStorage.getItem(SAVED_DELIVERY_LOCATIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item: any, index: number) => {
            const lat = Number(item?.lat);
            const lng = Number(item?.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            const name = cleanSavedLocationName(item?.name) || `Location ${index + 1}`;
            return {
              id: String(item?.id || `${Date.now()}-${index}`),
              name,
              lat,
              lng,
              address: String(item?.address || ''),
            } as SavedDeliveryLocation;
          })
          .filter(Boolean)
          .slice(0, MAX_SAVED_DELIVERY_LOCATIONS) as SavedDeliveryLocation[];
      }
    }

    // Migrate the previous Home / Work / Other format.
    const oldRaw = localStorage.getItem(OLD_SAVED_DELIVERY_LOCATIONS_KEY);
    if (oldRaw) {
      const parsed = JSON.parse(oldRaw) || {};
      const migrated: SavedDeliveryLocation[] = [];
      const labels: Record<string, string> = {
        home: 'Home',
        work: 'Work',
        other: 'Other',
      };

      ['home', 'work', 'other'].forEach((slot, index) => {
        const item = parsed?.[slot];
        const lat = Number(item?.lat);
        const lng = Number(item?.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          migrated.push({
            id: `migrated-${slot}-${index}`,
            name: labels[slot],
            lat,
            lng,
            address: String(item?.address || ''),
          });
        }
      });

      if (migrated.length > 0) {
        localStorage.setItem(
          SAVED_DELIVERY_LOCATIONS_KEY,
          JSON.stringify(migrated),
        );
        return migrated;
      }
    }

    // Migrate the oldest one-location format into Home.
    const legacyRaw = localStorage.getItem(LEGACY_SAVED_DELIVERY_LOCATION_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      const lat = Number(legacy?.lat);
      const lng = Number(legacy?.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const migrated: SavedDeliveryLocation[] = [{
          id: 'legacy-home',
          name: 'Home',
          lat,
          lng,
          address: String(legacy?.address || ''),
        }];
        localStorage.setItem(
          SAVED_DELIVERY_LOCATIONS_KEY,
          JSON.stringify(migrated),
        );
        return migrated;
      }
    }
  } catch {
    // Ignore invalid local storage data.
  }

  return [];
}

const CHECKOUT_EN: Record<string, string> = {
  'checkout.login_signup': 'Login / Sign Up',
  'checkout.login_required': 'Please login to place your order',
  'checkout.restaurant_closed': 'Restaurant Closed',
  'checkout.collect_store': 'Collect from store',
  'checkout.to_your_location': 'To your location',
  'checkout.opens': 'Opens',
  'checkout.delivery_hours': 'Delivery hours',
  'checkout.delivery_closed_pickup_available': 'Delivery is closed now. Pickup is available.',
  'checkout.valid_number_delivery': 'Valid phone number required',
  'checkout.select_delivery_location': 'Delivery Location',
  'checkout.tap_drag_pin': 'Choose your location on the map',
  'checkout.getting': 'Getting...',
  'checkout.my_location': 'My Location',
  'checkout.drag_pin_popup': 'Drag me to your location',
  'checkout.pin_moved': 'Location selected',
  'checkout.location_failed': 'Could not get your location. Select it on the map.',
  'checkout.location_access_unavailable': 'Location access unavailable',
  'checkout.location_access_help': 'Select your delivery location on the map.',
  'checkout.try_again': 'Try Again',
  'checkout.still_no_access': 'Select your location manually on the map.',
  'checkout.getting_your_location': 'Getting your location...',
  'checkout.delivery_fee': 'Delivery Fee',
  'checkout.delivery_notes_label': 'Delivery Notes (optional)',
  'checkout.delivery_notes_placeholder': 'Building, floor, apartment number...',
  'checkout.estimated_delivery': 'Estimated delivery',
  'checkout.car_optional': 'Car Number & Color (optional)',
  'checkout.car_help': 'Helps us identify you for pickup',
  'checkout.applied': 'applied',
  'checkout.saving': 'saving',
  'checkout.remove': 'Remove',
  'checkout.add_tip': 'Add a Tip',
  'checkout.tip_goes_rider_note': '(goes to rider)',
  'checkout.tip_goes_shop_note': '(goes to shop staff)',
  'checkout.custom': 'Custom',
  'checkout.no_tip': 'No Tip',
  'checkout.enter_amount': 'Enter amount',
  'checkout.will_go_rider': 'will go to your delivery rider',
  'checkout.will_go_shop': 'will go to shop staff',
  'checkout.contact_restaurant': 'Please contact the restaurant.',
  'checkout.order_summary': 'Order Summary',
  'checkout.original_subtotal': 'Original Subtotal',
  'checkout.item_discounts': 'Item Discounts',
  'checkout.subtotal': 'Subtotal',
  'checkout.service_fee': 'Service Fee',
  'checkout.small_order_fee': 'Small Order Fee',
  'checkout.vat_included': 'VAT (Incl.)',
  'checkout.vat_tax': 'VAT / Tax',
  'checkout.rider': 'Rider',
  'checkout.shop': 'Shop',
  'checkout.discount': 'Discount',
  'checkout.tip': 'Tip',
  'checkout.please_fix_following': 'Please fix the following:',
  'checkout.phone_required': 'Please enter your phone number',
  'checkout.valid_phone_allowed': 'Please enter a valid phone number',
  'checkout.phone_too_short': 'Phone number is too short',
  'checkout.valid_phone_min': 'Please enter a valid phone number',
  'checkout.enter_name': 'Please enter your name',
  'checkout.select_location': 'Please select your delivery location',
  'checkout.unable_delivery_charge': 'Unable to calculate delivery charge. Re-select your location.',
  'checkout.no_payment_for_type': 'No payment methods available for this order type',
  'checkout.cart_add_items': 'Your cart is empty',
  'checkout.delivery_available_from': 'Delivery is available from',
  'checkout.to': 'to',
  'checkout.select_pickup': 'Please select Pickup',
  'checkout.fix_before_order': 'Please fix',
  'checkout.issue': 'issue',
  'checkout.issues': 'issues',
  'checkout.order_number': 'Order',
  'checkout.order_success': 'placed successfully',
  'checkout.failed_place_order': 'Failed to place order. Please try again.',
  'checkout.enter_promo': 'Please enter a promo code',
  'checkout.first_order_only': 'This offer is valid for first orders only',
  'checkout.offer_usage_limit': 'Offer usage limit reached',
  'checkout.minimum_promo_order': 'Minimum order for this promo is',
  'checkout.discount_applied': 'discount applied',
  'checkout.promo_applied': 'Promo code applied',
  'checkout.invalid_promo': 'Invalid or expired promo code',
  'checkout.promo_validate_failed': 'Failed to validate promo code',
  'checkout.delivery_not_available_area': 'Delivery is not available in your area',
  'checkout.delivery_within': 'We deliver within',
  'checkout.madha_province': 'Madha Province',
  'checkout.shop_closed_message': 'The restaurant is currently closed.',
  'checkout.shop_busy_message': 'We are currently busy. Orders may take longer.',
  'checkout.saved_locations': 'Saved locations',
  'checkout.save_location_optional': 'Save this location (optional)',
  'checkout.location_name': 'Location name',
  'checkout.location_name_placeholder': 'Home, Work, Office, etc.',
  'checkout.home': 'Home',
  'checkout.work': 'Work',
  'checkout.other': 'Other',
  'checkout.save': 'Save',
  'checkout.cancel': 'Cancel',
  'checkout.saved_as': 'Location saved as',
  'checkout.use_saved_location': 'Use saved location',
  'checkout.saved_limit': 'You can save up to 10 locations.',
  'checkout.saved_limit_reached': 'Maximum 10 saved locations. Delete one to save another.',
  'checkout.enter_location_name': 'Enter a name for this location.',
  'checkout.delete_saved_location': 'Delete saved location',
  'checkout.saved_location_success': 'Delivery location saved.',
  'checkout.saved_location_loaded': 'Saved delivery location loaded.',
  'checkout.no_saved_location': 'No saved delivery location found.',
  'checkout.select_location_first': 'Select a delivery location first.',
  'checkout.location_unsupported': 'Location is not supported. Select it on the map.',
  'checkout.location_denied': 'Location permission denied. Select it on the map.',
  'checkout.name_placeholder': 'Your full name',
  'checkout.notes_placeholder': 'Any special instructions...',
  'checkout.promo_placeholder': 'Enter promo code',
  'checkout.car_placeholder': 'e.g. White Toyota ABC 1234',
  'menu.small': 'Small',
  'menu.medium': 'Medium',
  'menu.large': 'Large',
  'deals.off': 'OFF',
};

const CHECKOUT_AR: Record<string, string> = {
  'checkout.login_signup': 'تسجيل الدخول / إنشاء حساب',
  'checkout.login_required': 'يرجى تسجيل الدخول لتقديم طلبك',
  'checkout.restaurant_closed': 'المطعم مغلق',
  'checkout.collect_store': 'الاستلام من المتجر',
  'checkout.to_your_location': 'إلى موقعك',
  'checkout.opens': 'يفتح',
  'checkout.delivery_hours': 'ساعات التوصيل',
  'checkout.delivery_closed_pickup_available': 'التوصيل مغلق الآن. الاستلام متاح أثناء ساعات عمل المتجر.',
  'checkout.valid_number_delivery': 'يلزم رقم هاتف صالح للتوصيل',
  'checkout.select_delivery_location': 'حدد موقع التوصيل',
  'checkout.tap_drag_pin': 'اضغط على الخريطة أو اسحب الدبوس إلى موقعك الدقيق',
  'checkout.getting': 'جارٍ التحديد...',
  'checkout.my_location': 'موقعي',
  'checkout.drag_pin_popup': 'اسحبني إلى موقعك',
  'checkout.pin_moved': 'تم نقل الدبوس إلى موقعك!',
  'checkout.location_failed': 'تعذر تحديد موقعك. اضغط على الخريطة لتحديد الموقع يدوياً.',
  'checkout.location_access_unavailable': 'الوصول إلى الموقع غير متاح',
  'checkout.location_access_help': 'اضغط على الخريطة أو اسحب الدبوس لتحديد موقع التوصيل.',
  'checkout.try_again': 'حاول مرة أخرى',
  'checkout.still_no_access': 'لا يزال الوصول غير متاح. حدد موقعك يدوياً على الخريطة.',
  'checkout.getting_your_location': 'جارٍ تحديد موقعك...',
  'checkout.delivery_fee': 'رسوم التوصيل',
  'checkout.delivery_notes_label': 'ملاحظات التوصيل (المبنى، الطابق، إلخ)',
  'checkout.delivery_notes_placeholder': 'اسم المبنى، الطابق، رقم الشقة...',
  'checkout.estimated_delivery': 'وقت التوصيل المتوقع',
  'checkout.car_optional': 'رقم السيارة ولونها (اختياري)',
  'checkout.car_help': 'يساعدنا في التعرف عليك عند الاستلام',
  'checkout.applied': 'تم تطبيقه!',
  'checkout.saving': 'التوفير',
  'checkout.remove': 'إزالة',
  'checkout.add_tip': 'إضافة إكرامية',
  'checkout.tip_goes_rider_note': '(تذهب للسائق)',
  'checkout.tip_goes_shop_note': '(تذهب لموظفي المتجر)',
  'checkout.custom': 'مخصص',
  'checkout.no_tip': 'بدون إكرامية',
  'checkout.enter_amount': 'أدخل المبلغ',
  'checkout.will_go_rider': 'ستذهب إلى سائق التوصيل',
  'checkout.will_go_shop': 'ستذهب إلى موظفي المتجر',
  'checkout.contact_restaurant': 'يرجى التواصل مع المطعم.',
  'checkout.order_summary': 'ملخص الطلب',
  'checkout.original_subtotal': 'المجموع الفرعي الأصلي',
  'checkout.item_discounts': 'خصومات الأصناف',
  'checkout.subtotal': 'المجموع الفرعي',
  'checkout.service_fee': 'رسوم الخدمة',
  'checkout.small_order_fee': 'رسوم الطلب الصغير',
  'checkout.vat_included': 'ضريبة القيمة المضافة (مشمولة)',
  'checkout.vat_tax': 'ضريبة القيمة المضافة / الضريبة',
  'checkout.rider': 'السائق',
  'checkout.shop': 'المتجر',
  'checkout.discount': 'الخصم',
  'checkout.tip': 'الإكرامية',
  'checkout.please_fix_following': 'يرجى تصحيح التالي:',
  'checkout.phone_required': 'يرجى إدخال رقم الهاتف',
  'checkout.valid_phone_allowed': 'يرجى إدخال رقم هاتف صالح برمز دولة مسموح',
  'checkout.phone_too_short': 'رقم الهاتف قصير جداً. يرجى إدخال الرقم كاملاً.',
  'checkout.valid_phone_min': 'يرجى إدخال رقم هاتف صالح (9 أرقام على الأقل)',
  'checkout.enter_name': 'يرجى إدخال اسمك',
  'checkout.select_location': 'يرجى تحديد موقع التوصيل على الخريطة',
  'checkout.unable_delivery_charge': 'تعذر حساب رسوم التوصيل. يرجى إعادة تحديد موقعك على الخريطة.',
  'checkout.no_payment_for_type': 'لا توجد طرق دفع متاحة لهذا النوع من الطلبات',
  'checkout.cart_add_items': 'سلة التسوق فارغة — أضف أصنافاً أولاً',
  'checkout.delivery_available_from': 'التوصيل متاح من',
  'checkout.to': 'إلى',
  'checkout.select_pickup': 'يرجى اختيار الاستلام.',
  'checkout.fix_before_order': 'يرجى تصحيح',
  'checkout.issue': 'مشكلة',
  'checkout.issues': 'مشكلات',
  'checkout.order_number': 'الطلب',
  'checkout.order_success': 'تم تقديمه بنجاح!',
  'checkout.failed_place_order': 'تعذر تقديم الطلب. يرجى المحاولة مرة أخرى.',
  'checkout.enter_promo': 'يرجى إدخال كود الخصم',
  'checkout.first_order_only': 'هذا العرض صالح للطلب الأول فقط',
  'checkout.offer_usage_limit': 'تم الوصول إلى الحد المسموح لاستخدام هذا العرض.',
  'checkout.minimum_promo_order': 'الحد الأدنى للطلب لاستخدام هذا العرض هو',
  'checkout.discount_applied': 'تم تطبيق الخصم!',
  'checkout.promo_applied': 'تم تطبيق كود الخصم!',
  'checkout.invalid_promo': 'كود الخصم غير صالح أو منتهي',
  'checkout.promo_validate_failed': 'تعذر التحقق من كود الخصم',
  'checkout.delivery_not_available_area': 'التوصيل غير متاح في منطقتك',
  'checkout.delivery_within': 'نقوم بالتوصيل ضمن',
  'checkout.madha_province': 'محافظة مدحاء',
  'checkout.shop_closed_message': 'المطعم مغلق حالياً. يرجى المحاولة خلال ساعات العمل.',
  'checkout.shop_busy_message': 'نحن مشغولون حالياً. قد تستغرق الطلبات وقتاً أطول من المعتاد.',
  'checkout.save_delivery_location': 'حفظ موقع التوصيل',
  'checkout.saved_locations': 'المواقع المحفوظة',
  'checkout.save_location_optional': 'حفظ هذا الموقع (اختياري)',
  'checkout.location_name': 'اسم الموقع',
  'checkout.location_name_placeholder': 'المنزل، العمل، المكتب، إلخ',
  'checkout.save': 'حفظ',
  'checkout.cancel': 'إلغاء',
  'checkout.saved_limit': 'يمكنك حفظ حتى 10 مواقع.',
  'checkout.saved_limit_reached': 'الحد الأقصى 10 مواقع محفوظة. احذف موقعاً لحفظ موقع آخر.',
  'checkout.enter_location_name': 'أدخل اسماً لهذا الموقع.',
  'checkout.delete_saved_location': 'حذف الموقع المحفوظ',
  'checkout.save_as': 'حفظ باسم',
  'checkout.home': 'المنزل',
  'checkout.work': 'العمل',
  'checkout.other': 'أخرى',
  'checkout.saved_as': 'تم حفظ الموقع باسم',
  'checkout.use_saved_location': 'استخدام الموقع المحفوظ',
  'checkout.saved_location_success': 'تم حفظ موقع التوصيل.',
  'checkout.saved_location_loaded': 'تم تحميل موقع التوصيل المحفوظ.',
  'checkout.no_saved_location': 'لا يوجد موقع توصيل محفوظ.',
  'checkout.select_location_first': 'حدد موقع التوصيل أولاً.',
  'checkout.location_unsupported': 'متصفحك لا يدعم خدمات الموقع. حدد موقعك يدوياً على الخريطة.',
  'checkout.location_denied': 'تم رفض إذن الموقع. يمكنك تحديد موقعك يدوياً على الخريطة.',
  'checkout.name_placeholder': 'الاسم الكامل',
  'checkout.notes_placeholder': 'أي تعليمات خاصة...',
  'checkout.promo_placeholder': 'أدخل كود الخصم',
  'checkout.car_placeholder': 'مثال: تويوتا بيضاء ABC 1234',
  'menu.small': 'صغير',
  'menu.medium': 'وسط',
  'menu.large': 'كبير',
  'deals.off': 'خصم',
};

export default function Checkout() {
  const { selectedBranch } = useBranch();
  const navigate = useNavigate();
  const { t: baseT, language } = useTranslation();
  const humanizeKey = (key: string) =>
    key.split('.').pop()?.replaceAll('_', ' ').replace(/\w/g, (c) => c.toUpperCase()) || '';
  const t = (key: string) => {
    const local = language === 'ar' ? CHECKOUT_AR[key] : CHECKOUT_EN[key];
    if (local) return local;
    const global = baseT(key);
    return global && global !== key ? global : humanizeKey(key);
  };
  const { isLoggedIn } = useCustomerAuth();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(false);
  const submittingRef = useRef(false); // Guard against double-submit
  // Auto-fill from localStorage (remember customer info from previous orders)
  const [name, setName] = useState(() => localStorage.getItem('vita_customer_name') || '');
  const [phone, setPhone] = useState(() => localStorage.getItem('vita_customer_phone') || '');
  const [carInfo, setCarInfo] = useState('');
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [ziinaEnabled, setZiinaEnabled] = useState(false);
  const [orderType, setOrderType] = useState<'pickup' | 'delivery'>('pickup');
  const [deliveryAddress, setDeliveryAddress] = useState('');

  // Field-level validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);

  // Fee settings from admin
  const [serviceFeeEnabled, setServiceFeeEnabled] = useState(false);
  const [serviceFeeAmount, setServiceFeeAmount] = useState(0);
  const [serviceFeeType, setServiceFeeType] = useState<'fixed' | 'percentage'>('fixed');
  const [serviceFeeAppliesTo, setServiceFeeAppliesTo] = useState<'pickup' | 'delivery' | 'both'>('both');
  const [smallOrderFeeEnabled, setSmallOrderFeeEnabled] = useState(false);
  const [smallOrderFeeAmount, setSmallOrderFeeAmount] = useState(0);
  const [smallOrderFeeThreshold, setSmallOrderFeeThreshold] = useState(20);
  const [taxPercent, setTaxPercent] = useState(0);
  const [vatIncluded, setVatIncluded] = useState(false);

  // Payment method settings from admin
  const [cashEnabledPickup, setCashEnabledPickup] = useState(true);
  const [cardEnabledPickup, setCardEnabledPickup] = useState(true);
  const [cashEnabledDelivery, setCashEnabledDelivery] = useState(true);
  const [cardEnabledDelivery, setCardEnabledDelivery] = useState(true);

  // Delivery settings from admin
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [deliveryScheduleEnabled, setDeliveryScheduleEnabled] = useState(false);
  const [deliveryStartTime, setDeliveryStartTime] = useState('16:00');
  const [deliveryEndTime, setDeliveryEndTime] = useState('01:00');
  const [scheduleClock, setScheduleClock] = useState(() => Date.now());
  const [deliveryCharge, setDeliveryCharge] = useState(0);
  const [estimatedDeliveryTime, setEstimatedDeliveryTime] = useState('30-45 min');

  // Delivery zone settings
  const [restaurantLat, setRestaurantLat] = useState(25.2747);
  const [restaurantLng, setRestaurantLng] = useState(56.3450);

  useEffect(() => {
    if (!selectedBranch) return;
    setRestaurantLat(Number(selectedBranch.latitude));
    setRestaurantLng(Number(selectedBranch.longitude));
  }, [selectedBranch]);
  const [nearRadius, setNearRadius] = useState(5);
  const [farRadius, setFarRadius] = useState(15);
  const [nearCharge, setNearCharge] = useState(5);
  const [farCharge, setFarCharge] = useState(15);
  const [zoneName, setZoneName] = useState('');
  const [deliveryZones, setDeliveryZones] = useState<{zone_name: string; min_distance_km: number; max_distance_km: number; charge: number}[]>([]);

  // Tip
  const [tipAmount, setTipAmount] = useState(0);
  const [customTip, setCustomTip] = useState('');
  const [showCustomTip, setShowCustomTip] = useState(false);

  // Promo code
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [promoOffer, setPromoOffer] = useState<Offer | null>(null);
  const [validatingPromo, setValidatingPromo] = useState(false);
  const [activePromoOffers, setActivePromoOffers] = useState<Offer[]>([]);

  // Fai Fai Surprise Box / Golden rewards
  const [availableRewards, setAvailableRewards] = useState<CustomerReward[]>([]);
  const [selectedReward, setSelectedReward] = useState<CustomerReward | null>(null);
  const [rewardsLoading, setRewardsLoading] = useState(false);

  // Shop status
  const [shopClosed, setShopClosed] = useState(false);
  const [shopClosedMessage, setShopClosedMessage] = useState('');

  // GPS location via map
  const [customerLat, setCustomerLat] = useState<number | null>(null);
  const [customerLng, setCustomerLng] = useState<number | null>(null);
  const [locationShared, setLocationShared] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [deliveryZoneError, setDeliveryZoneError] = useState('');
  const [calculatedDeliveryCharge, setCalculatedDeliveryCharge] = useState(0);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);
  const [gettingLocation, setGettingLocation] = useState(false);
  const [savedDeliveryLocations, setSavedDeliveryLocations] = useState<SavedDeliveryLocation[]>(() => readSavedDeliveryLocations());
  const [showSaveLocationPanel, setShowSaveLocationPanel] = useState(false);
  const [saveLocationName, setSaveLocationName] = useState('');
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    setCart(getCart());
    loadActivePromoOffers();

    let active = true;
    const refreshRewards = async () => {
      setRewardsLoading(true);
      try {
        const payload = await getMyRewards();
        if (!active) return;
        if (payload?.enabled === false) {
          setAvailableRewards([]);
          setSelectedReward(null);
          localStorage.removeItem('fai_fai_selected_reward_id');
          return;
        }
        const rewards = payload?.available || [];
        setAvailableRewards(rewards);
        const savedId = Number(localStorage.getItem('fai_fai_selected_reward_id') || 0);
        if (savedId) {
          const saved = rewards.find(reward => Number(reward.id) === savedId) || null;
          if (saved) setSelectedReward(saved);
          else {
            setSelectedReward(null);
            localStorage.removeItem('fai_fai_selected_reward_id');
          }
        } else {
          setSelectedReward(current => current && rewards.some(r => Number(r.id) === Number(current.id)) ? current : null);
        }
      } catch {
        // Reward sync must never break checkout.
      } finally {
        if (active) setRewardsLoading(false);
      }
    };

    void refreshRewards();
    const onFocus = () => void refreshRewards();
    const onVisibility = () => { if (document.visibilityState === 'visible') void refreshRewards(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Read only the public Ziina ON/OFF state. The secret API key stays on Render.
  useEffect(() => {
    backendRequest('/api/v1/ziina/config', 'GET')
      .then((response) => setZiinaEnabled(response?.data?.enabled === true))
      .catch(() => setZiinaEnabled(false));
  }, []);

  // Ziina hosted checkout returns the customer to this same Checkout route.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ziinaResult = params.get('ziina');
    const orderId = Number(params.get('order_id') || 0);
    if (!ziinaResult || !orderId) return;

    let disposed = false;
    const finishZiinaReturn = async () => {
      if (ziinaResult === 'success') {
        try {
          let finalStatus = '';

          // Ziina may redirect a fraction of a second before its final status is visible.
          for (let attempt = 0; attempt < 10; attempt += 1) {
            const verification = await backendRequest(
              '/api/v1/ziina/verify-payment',
              'POST',
              { order_id: orderId },
            );

            finalStatus = String(verification?.data?.status || '').toLowerCase();
            if (finalStatus === 'completed') break;
            if (['failed', 'canceled', 'cancelled', 'refunded', 'refund_pending', 'refund_failed', 'refund_needed'].includes(finalStatus)) break;
            await new Promise((resolve) => window.setTimeout(resolve, 1500));
          }

          if (disposed) return;

          if (finalStatus === 'completed') {
            localStorage.removeItem('vita_pending_ziina_order_id');
            clearCart();
      localStorage.removeItem('fai_fai_selected_reward_id');
      if (selectedReward) setAvailableRewards(prev => prev.filter(r => Number(r.id) !== Number(selectedReward.id)));
      setSelectedReward(null);
            window.dispatchEvent(new Event('cart-updated'));
            toast.success(`${t('checkout.order_number')} #${orderId} — online payment successful`);
            navigate('/order-confirmation', { replace: true, state: { orderId } });
            return;
          }

          if (['refunded', 'refund_pending', 'refund_failed', 'refund_needed'].includes(finalStatus)) {
            localStorage.removeItem('vita_pending_ziina_order_id');
            toast.info(
              finalStatus === 'refunded'
                ? 'This old online payment was refunded because you switched payment method.'
                : 'This old online payment is being handled for refund because you switched payment method.',
            );
            navigate('/my-orders', { replace: true });
            return;
          }

          if (['failed', 'canceled', 'cancelled'].includes(finalStatus)) {
            localStorage.removeItem('vita_pending_ziina_order_id');
            toast.error('Online payment was not completed.');
            navigate('/checkout', { replace: true });
            return;
          }

          toast.info('Payment is still processing. Please check My Orders shortly.');
          navigate('/my-orders', { replace: true });
        } catch (error: any) {
          if (disposed) return;
          toast.error(error?.response?.data?.detail || error?.message || 'Could not verify online payment.');
          navigate('/my-orders', { replace: true });
        }
        return;
      }

      // Cancel/failure: keep the cart so the customer can retry or choose cash.
      // If Ziina still reports an active payment, keep its order id so a later
      // Cash submission can safely supersede it after server-side verification.
      let cleanupStatus = '';
      try {
        const cleanup = await backendRequest(
          '/api/v1/ziina/cancel-payment-order',
          'POST',
          { order_id: orderId },
        );
        cleanupStatus = String(cleanup?.data?.status || '').toLowerCase();
      } catch {
        // A cleanup failure must not delete the cart or trap the customer.
      }
      if (cleanupStatus && cleanupStatus !== 'payment_pending') {
        localStorage.removeItem('vita_pending_ziina_order_id');
      } else {
        localStorage.setItem('vita_pending_ziina_order_id', String(orderId));
      }

      if (!disposed) {
        toast.error(ziinaResult === 'failed' ? 'Online payment failed. Please try again.' : 'Online payment cancelled.');
        navigate('/checkout', { replace: true });
      }
    };

    void finishZiinaReturn();
    return () => {
      disposed = true;
    };
  }, [navigate]);

  useEffect(() => {
    void loadDeliverySettings();
  }, [selectedBranch?.id]);

  const deliveryAvailableNow = deliveryEnabled && (
    !deliveryScheduleEnabled ||
    isWithinDailySchedule(deliveryStartTime, deliveryEndTime, new Date(scheduleClock))
  );

  useEffect(() => {
    const timer = window.setInterval(() => setScheduleClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (orderType === 'delivery' && !deliveryAvailableNow) {
      setOrderType('pickup');
      setShowMap(false);
    }
  }, [deliveryAvailableNow, orderType]);

  // Keep checkout simple: only Cash + Ziina online card.
  useEffect(() => {
    const cashAvailable =
      orderType === 'pickup' ? cashEnabledPickup : cashEnabledDelivery;

    const methods = [
      cashAvailable && 'cash',
      ziinaEnabled && 'ziina',
    ].filter(Boolean) as string[];

    if (methods.length > 0 && !methods.includes(paymentMethod)) {
      setPaymentMethod(methods[0]);
    }
  }, [
    orderType,
    cashEnabledPickup,
    cardEnabledPickup,
    cashEnabledDelivery,
    cardEnabledDelivery,
    ziinaEnabled,
    paymentMethod,
  ]);

  useEffect(() => {
    if (showMap && !mapInstanceRef.current) {
      // Small delay to ensure DOM is rendered before initializing map
      const timer = setTimeout(() => {
        if (mapRef.current && !mapInstanceRef.current) {
          initMap();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
    if (!showMap && mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }
  }, [showMap]);

  function displayZoneName(value: string): string {
    const name = String(value || '').trim();
    if (language !== 'ar') return name;
    const normalized = name.toLowerCase();
    if (normalized === 'near zone') return t('checkout.near_zone');
    if (normalized === 'far zone') return t('checkout.far_zone');
    if (normalized === 'madha province') return t('checkout.madha_province');
    return name;
  }

  function displaySize(value: string): string {
    if (language !== 'ar') return value;
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'small' || normalized === 's') return t('menu.small');
    if (normalized === 'medium' || normalized === 'm') return t('menu.medium');
    if (normalized === 'large' || normalized === 'l') return t('menu.large');
    return value;
  }

  function localizedSavedLocationName(name: string): string {
    const normalized = String(name || '').trim().toLowerCase();
    if (normalized === 'home') return t('checkout.home');
    if (normalized === 'work') return t('checkout.work');
    if (normalized === 'other') return t('checkout.other');
    return name;
  }

  async function useSavedDeliveryLocation(saved: SavedDeliveryLocation) {
    if (markerRef.current) {
      markerRef.current.setLatLng([saved.lat, saved.lng]);
    }
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setView([saved.lat, saved.lng], 15);
    }

    setDeliveryAddress(saved.address || '');
    await handleLocationSelected(saved.lat, saved.lng);
    toast.success(`${localizedSavedLocationName(saved.name)} — ${t('checkout.saved_location_loaded')}`);
  }

  function saveCurrentDeliveryLocation(nameOverride?: string) {
    if (!locationShared || customerLat === null || customerLng === null) {
      toast.error(t('checkout.select_location_first'));
      return;
    }

    const name = cleanSavedLocationName(nameOverride || saveLocationName);
    if (!name) {
      toast.error(t('checkout.enter_location_name'));
      return;
    }

    if (savedDeliveryLocations.length >= MAX_SAVED_DELIVERY_LOCATIONS) {
      toast.error(t('checkout.saved_limit_reached'));
      return;
    }

    const next: SavedDeliveryLocation[] = [
      ...savedDeliveryLocations,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        lat: customerLat,
        lng: customerLng,
        address: deliveryAddress.trim(),
      },
    ];

    localStorage.setItem(
      SAVED_DELIVERY_LOCATIONS_KEY,
      JSON.stringify(next),
    );
    setSavedDeliveryLocations(next);
    setSaveLocationName('');
    setShowSaveLocationPanel(false);
    toast.success(`${t('checkout.saved_as')} ${localizedSavedLocationName(name)}`);
  }

  function deleteSavedDeliveryLocation(id: string) {
    const next = savedDeliveryLocations.filter((item) => item.id !== id);
    localStorage.setItem(
      SAVED_DELIVERY_LOCATIONS_KEY,
      JSON.stringify(next),
    );
    setSavedDeliveryLocations(next);
  }

  async function moveToCurrentLocation(options?: {
    timeout?: number;
    maximumAge?: number;
    showSuccess?: boolean;
  }): Promise<boolean> {
    setGettingLocation(true);
    try {
      const { latitude, longitude } = await getCurrentDeviceLocation({
        timeout: options?.timeout ?? 15000,
        maximumAge: options?.maximumAge ?? 0,
      });

      if (markerRef.current) {
        markerRef.current.setLatLng([latitude, longitude]);
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.setView([latitude, longitude], 15);
      }

      await handleLocationSelected(latitude, longitude);
      setLocationPermissionDenied(false);
      if (options?.showSuccess) toast.success(t('checkout.pin_moved'));
      return true;
    } catch (error) {
      const denied =
        error instanceof DeviceLocationError &&
        error.code === 'permission-denied';
      setLocationPermissionDenied(denied);
      if (options?.showSuccess) {
        toast.warning(
          denied
            ? t('checkout.location_denied')
            : t('checkout.location_failed'),
        );
      }
      return false;
    } finally {
      setGettingLocation(false);
    }
  }

  function initMap() {
    if (!mapRef.current) return;
    const map = L.map(mapRef.current).setView([restaurantLat, restaurantLng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);

    // Restaurant marker
    const restaurantIcon = L.divIcon({
      html: '<div style="background:red;width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3)"></div>',
      className: '',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    L.marker([restaurantLat, restaurantLng], { icon: restaurantIcon }).addTo(map)
      .bindPopup('🥤 Fai Fai Juice');


    // Draggable customer marker
    const marker = L.marker([restaurantLat + 0.005, restaurantLng + 0.005], {
      draggable: true,
    }).addTo(map);
    marker.bindPopup(`📍 ${t('checkout.drag_pin_popup')}`).openPopup();

    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      handleLocationSelected(pos.lat, pos.lng);
    });

    // Click to place marker
    map.on('click', (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng);
      handleLocationSelected(e.latlng.lat, e.latlng.lng);
    });

    mapInstanceRef.current = map;
    markerRef.current = marker;

    // Auto-request current location. iOS uses the native Capacitor location
    // plugin; Android/Web keep the existing browser geolocation behavior.
    void moveToCurrentLocation({ timeout: 10000, maximumAge: 120000 });
  }

  async function handleLocationSelected(lat: number, lng: number) {
    setCustomerLat(lat);
    setCustomerLng(lng);
    setLocationShared(true);

    // Call backend zone calculation API
    try {
      const res = await client.apiCall.invoke({
        url: '/api/v1/entities/delivery_zones/calculate',
        method: 'POST',
        data: {
          branch_id: selectedBranch?.id || null,
          customer_lat: lat,
          customer_lng: lng,
          restaurant_lat: restaurantLat,
          restaurant_lng: restaurantLng,
        },
      });
      const result = res?.data;
      if (result?.available) {
        setDeliveryZoneError('');
        setCalculatedDeliveryCharge(result.charge || 0);
        setZoneName(result.zone_name || '');
      } else {
        setDeliveryZoneError(result?.message || `${t('checkout.delivery_not_available_area')} (${result?.distance_km?.toFixed(1) || '?'} km).`);
        setCalculatedDeliveryCharge(0);
        setZoneName('');
      }
    } catch {
      // Fallback to client-side near/far calculation if API fails
      const distance = getDistanceKm(restaurantLat, restaurantLng, lat, lng);
      if (distance <= nearRadius) {
        setDeliveryZoneError('');
        setCalculatedDeliveryCharge(nearCharge);
        setZoneName(t('checkout.near_zone'));
      } else if (distance <= farRadius) {
        setDeliveryZoneError('');
        setCalculatedDeliveryCharge(farCharge);
        setZoneName(t('checkout.far_zone'));
      } else {
        setDeliveryZoneError(`${t('checkout.delivery_not_available_area')} (${distance.toFixed(1)} km). ${t('checkout.delivery_within')} ${farRadius} km.`);
        setCalculatedDeliveryCharge(0);
        setZoneName('');
      }
    }
  }

  function getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  async function loadDeliverySettings() {
    try {
      // Fetch from backend entity (accessible to all users)
      const res = await client.entities.restaurant_settings.query({ query: {}, limit: 1 });
      const items = res?.data?.items || [];
      if (items.length > 0) {
        const s = items[0] as any;

        // ===== SHOP STATUS CHECK =====
        const status = String(s.restaurant_status || 'open').toLowerCase().trim();
        let effectiveStatus = status;

        if (s.auto_schedule_enabled && s.auto_open_time && s.auto_close_time) {
          const now = new Date();
          const uaeTime = new Date(
            now.getTime() + (4 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000),
          );
          const isOpenBySchedule = isWithinDailySchedule(
            String(s.auto_open_time),
            String(s.auto_close_time),
            uaeTime,
          );
          effectiveStatus = isOpenBySchedule ? (status === 'busy' ? 'busy' : 'open') : 'closed';
        }

        if (effectiveStatus === 'closed') {
          setShopClosed(true);
          setShopClosedMessage(
            s.busy_message
              || (s.auto_schedule_enabled && s.auto_open_time && s.auto_close_time
                ? `We are currently closed. Opening hours: ${s.auto_open_time} - ${s.auto_close_time}`
                : t('checkout.shop_closed_message')),
          );
        } else if (effectiveStatus === 'busy') {
          setShopClosed(false);
          setShopClosedMessage(s.busy_message || t('checkout.shop_busy_message'));
        } else {
          setShopClosed(false);
          setShopClosedMessage('');
        }
        // ===== END SHOP STATUS CHECK =====

        setDeliveryEnabled(s.delivery_enabled === true || s.delivery_enabled === 'true');
        setDeliveryScheduleEnabled(s.delivery_schedule_enabled === true);
        setDeliveryStartTime(s.delivery_start_time || '16:00');
        setDeliveryEndTime(s.delivery_end_time || '01:00');
        setDeliveryCharge(parseFloat(s.delivery_charges) || 5);
        setEstimatedDeliveryTime(s.estimated_delivery_time || '30-45 min');

        // The original/default branch keeps using the legacy restaurant settings.
        // Only additional branches apply their own delivery overrides.
        if (selectedBranch && !selectedBranch.is_default) {
          if (selectedBranch.delivery_enabled !== null && selectedBranch.delivery_enabled !== undefined) {
            setDeliveryEnabled(selectedBranch.delivery_enabled === true);
          }
          if (selectedBranch.delivery_schedule_enabled !== null && selectedBranch.delivery_schedule_enabled !== undefined) {
            setDeliveryScheduleEnabled(selectedBranch.delivery_schedule_enabled === true);
          }
          if (selectedBranch.delivery_start_time) setDeliveryStartTime(selectedBranch.delivery_start_time);
          if (selectedBranch.delivery_end_time) setDeliveryEndTime(selectedBranch.delivery_end_time);
          if (selectedBranch.estimated_delivery_time) setEstimatedDeliveryTime(selectedBranch.estimated_delivery_time);
        }
        if (!selectedBranch && s.restaurant_lat) setRestaurantLat(parseFloat(s.restaurant_lat));
        if (!selectedBranch && s.restaurant_lng) setRestaurantLng(parseFloat(s.restaurant_lng));
        if (s.near_radius) setNearRadius(parseFloat(s.near_radius));
        if (s.far_radius) setFarRadius(parseFloat(s.far_radius));
        if (s.near_charge) setNearCharge(parseFloat(s.near_charge));
        if (s.far_charge) setFarCharge(parseFloat(s.far_charge));
        // Fee settings
        setServiceFeeEnabled(s.service_fee_enabled === true);
        setServiceFeeAmount(parseFloat(s.service_fee_amount) || 0);
        setServiceFeeType(s.service_fee_type || 'fixed');
        setServiceFeeAppliesTo(s.service_fee_applies_to || 'both');
        setSmallOrderFeeEnabled(s.small_order_fee_enabled === true);
        setSmallOrderFeeAmount(parseFloat(s.small_order_fee_amount) || 0);
        setSmallOrderFeeThreshold(parseFloat(s.small_order_fee_threshold) || 20);
        setTaxPercent(Math.max(0, Math.min(100, parseFloat(s.tax_percent) || 0)));
        setVatIncluded(s.vat_included === true);
        // Payment method settings
        setCashEnabledPickup(s.cash_enabled_pickup !== false);
        setCardEnabledPickup(s.card_enabled_pickup !== false);
        setCashEnabledDelivery(s.cash_enabled_delivery !== false);
        setCardEnabledDelivery(s.card_enabled_delivery !== false);
      }
      // Load delivery zones from backend for map legend
      try {
        const zonesRes = await client.apiCall.invoke({
          url: `/api/v1/entities/delivery_zones?query=${encodeURIComponent(JSON.stringify({ is_active: true, branch_id: selectedBranch?.id || null }))}&sort=min_distance_km&limit=50`,
          method: 'GET',
        });
        const zones = zonesRes?.data?.items || [];
        if (zones.length > 0) {
          setDeliveryZones(zones);
        }
      } catch { /* zones not loaded, use legacy near/far */ }
    } catch (e) {
      console.error('Failed to load delivery settings:', e);
      // Fallback to localStorage for admin testing
      const ext = localStorage.getItem('extended_settings');
      if (ext) {
        try {
          const parsed = JSON.parse(ext);
          setDeliveryEnabled(parsed.delivery_enabled === true || parsed.delivery_enabled === 'true');
          setDeliveryScheduleEnabled(parsed.delivery_schedule_enabled === true);
          setDeliveryStartTime(parsed.delivery_start_time || '16:00');
          setDeliveryEndTime(parsed.delivery_end_time || '01:00');
          setDeliveryCharge(parseFloat(parsed.delivery_charges) || 5);
          setEstimatedDeliveryTime(parsed.estimated_delivery_time || '30-45 min');
          if (!selectedBranch && parsed.restaurant_lat) setRestaurantLat(parseFloat(parsed.restaurant_lat));
          if (!selectedBranch && parsed.restaurant_lng) setRestaurantLng(parseFloat(parsed.restaurant_lng));
          if (parsed.near_radius) setNearRadius(parseFloat(parsed.near_radius));
          if (parsed.far_radius) setFarRadius(parseFloat(parsed.far_radius));
          if (parsed.near_charge) setNearCharge(parseFloat(parsed.near_charge));
          if (parsed.far_charge) setFarCharge(parseFloat(parsed.far_charge));
        } catch { /* ignore */ }
      }
    }
  }

  async function loadActivePromoOffers() {
    try {
      const res = await client.entities.offers.query({
        query: { is_active: true },
        sort: '-created_at',
        limit: 100,
      });
      const active = (res?.data?.items || []).filter((offer: Offer) =>
        isPromoOfferCurrentlyActive(offer)
      );
      setActivePromoOffers(active);

      // Automatically remove a promo if Admin turned it OFF or it expired.
      if (promoApplied && promoOffer && !active.some((offer: Offer) => offer.id === promoOffer.id)) {
        removePromo();
      }
    } catch (error) {
      console.error('Failed to load active promo offers:', error);
      setActivePromoOffers([]);
    }
  }

  async function validatePromoCode() {
    if (!promoCode.trim()) {
      toast.error(t('checkout.enter_promo'));
      return;
    }
    setValidatingPromo(true);
    try {
      const res = await client.entities.offers.query({ query: { is_active: true }, limit: 100 });
      const offers = (res?.data?.items || []).filter((offer: Offer) =>
        isPromoOfferCurrentlyActive(offer)
      );
      setActivePromoOffers(offers);
      const matchedOffer = offers.find(
        (offer: Offer) => offer.promo_code.trim().toLowerCase() === promoCode.trim().toLowerCase()
      );
      if (matchedOffer && ((matchedOffer.discount_type || 'percentage') === 'fixed' ? Number(matchedOffer.fixed_discount_amount || 0) > 0 : Number(matchedOffer.discount_percent || 0) > 0)) {
        // Get user's previous orders for usage validation
        let previousOrders: any[] = [];
        try {
          const ordersRes = await axios.get(
            `${getAPIBaseURL().replace(/\/$/, '')}/api/v1/orders/my-orders`,
            {
              params: { session_id: getGuestSessionId() },
              headers: {
                Authorization: `Bearer ${localStorage.getItem('vita_customer_token') || ''}`,
              },
              timeout: 15000,
            },
          );
          previousOrders = ordersRes?.data?.items || [];
        } catch {
          // If we can't check orders (not logged in), allow it - will be validated on backend
        }

        // Check if this is a "first order only" offer
        if (matchedOffer.first_order_only) {
          const completedOrders = previousOrders.filter(
            (o: any) => o.status !== 'cancelled' && o.status !== 'expired'
          );
          if (completedOrders.length > 0) {
            toast.error(t('checkout.first_order_only'));
            setPromoApplied(false);
            setPromoDiscount(0);
            setPromoOffer(null);
            setValidatingPromo(false);
            return;
          }
        }

        // Check usage limit per customer (by promo code in order notes)
        const usageLimit = matchedOffer.usage_limit_per_customer ?? 1; // default 1 time
        if (usageLimit > 0 && previousOrders.length > 0) {
          // Count how many times this promo was used by this customer
          const promoCodeUpper = matchedOffer.promo_code.toUpperCase();
          const usageCount = previousOrders.filter((o: any) => {
            const savedPromo = String(o.promo_code || '').toUpperCase();
            const notes = String(o.order_notes || '').toUpperCase();
            return (savedPromo === promoCodeUpper || notes.includes(`PROMO: ${promoCodeUpper}`)) && o.status !== 'cancelled' && o.status !== 'expired';
          }).length;

          if (usageCount >= usageLimit) {
            toast.error(`${t('checkout.offer_usage_limit')} ${usageLimit > 1 ? `(${usageLimit})` : ''}`.trim());
            setPromoApplied(false);
            setPromoDiscount(0);
            setPromoOffer(null);
            setValidatingPromo(false);
            return;
          }
        }

        const minimumOrder = Number(matchedOffer.minimum_order_amount || 0);
        if (subtotal < minimumOrder) {
          toast.error(`${t('checkout.minimum_promo_order')} AED ${minimumOrder.toFixed(2)}`);
          setPromoApplied(false);
          setPromoOffer(null);
          return;
        }

        const isFixed = (matchedOffer.discount_type || 'percentage') === 'fixed';
        const value = isFixed
          ? Number(matchedOffer.fixed_discount_amount || 0)
          : Number(matchedOffer.discount_percent || 0);
        setSelectedReward(null);
        localStorage.removeItem('fai_fai_selected_reward_id');
        setPromoApplied(true);
        setPromoDiscount(value);
        setPromoOffer(matchedOffer);
        toast.success(isFixed ? `🎉 AED ${value.toFixed(2)} ${t('checkout.discount_applied')}` : `🎉 ${t('checkout.promo_applied')} ${value}% ${t('deals.off')}`);
      } else {
        toast.error(t('checkout.invalid_promo'));
        setPromoApplied(false);
        setPromoDiscount(0);
        setPromoOffer(null);
      }
    } catch {
      toast.error(t('checkout.promo_validate_failed'));
    } finally {
      setValidatingPromo(false);
    }
  }

  function removePromo() {
    setPromoApplied(false);
    setPromoDiscount(0);
    setPromoOffer(null);
    setPromoCode('');
  }

  function chooseReward(reward: CustomerReward) {
    removePromo();
    setSelectedReward(reward);
    localStorage.setItem('fai_fai_selected_reward_id', String(reward.id));
  }

  function removeReward() {
    setSelectedReward(null);
    localStorage.removeItem('fai_fai_selected_reward_id');
  }

  const subtotal = getCartTotal(cart);
  const originalSubtotal = getCartOriginalTotal(cart);
  const itemDiscountTotal = getCartItemDiscountTotal(cart);
  const deliveryFee = orderType === 'delivery' ? (locationShared ? calculatedDeliveryCharge : deliveryCharge) : 0;
  const rawPromoDiscount = !promoApplied || !promoOffer
    ? 0
    : (promoOffer.discount_type || 'percentage') === 'fixed'
      ? Math.min(subtotal, Number(promoOffer.fixed_discount_amount || promoDiscount || 0))
      : (subtotal * Number(promoOffer.discount_percent || promoDiscount || 0)) / 100;
  const maximumPromoDiscount = Number(promoOffer?.maximum_discount_amount || 0);
  const promoDiscountAmount = maximumPromoDiscount > 0
    ? Math.min(rawPromoDiscount, maximumPromoDiscount)
    : rawPromoDiscount;
  const rewardDiscountAmount = selectedReward
    ? rewardDiscountForCart(selectedReward, subtotal, cart)
    : 0;
  // Discount applies to item subtotal only. Fees/delivery/tip stay unchanged.
  const discountAmount = Math.min(subtotal, selectedReward ? rewardDiscountAmount : promoDiscountAmount);
  const itemsAfterDiscount = Math.max(0, subtotal - discountAmount);
  // Service fee only applies based on admin setting (pickup/delivery/both)
  const shouldApplyServiceFee = serviceFeeEnabled && (
    serviceFeeAppliesTo === 'both' ||
    (serviceFeeAppliesTo === 'pickup' && orderType === 'pickup') ||
    (serviceFeeAppliesTo === 'delivery' && orderType === 'delivery')
  );
  // Calculate service fee: fixed amount OR percentage of subtotal
  const serviceFee = shouldApplyServiceFee
    ? (serviceFeeType === 'percentage' ? (subtotal * serviceFeeAmount) / 100 : serviceFeeAmount)
    : 0;
  const smallOrderFee = (smallOrderFeeEnabled && subtotal < smallOrderFeeThreshold) ? smallOrderFeeAmount : 0;
  const taxableAmount = Math.max(0, itemsAfterDiscount + deliveryFee + serviceFee + smallOrderFee);
  const taxAmount = taxPercent > 0
    ? vatIncluded
      ? taxableAmount - taxableAmount / (1 + taxPercent / 100)
      : (taxableAmount * taxPercent) / 100
    : 0;
  const taxAddedToTotal = vatIncluded ? 0 : taxAmount;
  const total = itemsAfterDiscount + deliveryFee + serviceFee + smallOrderFee + taxAddedToTotal + tipAmount;

  // Simple customer-facing payment choices: Cash + Ziina online card only.
  const availablePaymentMethods: { value: string; label: string }[] = [];

  const cashAvailable =
    orderType === 'pickup' ? cashEnabledPickup : cashEnabledDelivery;
  if (cashAvailable) {
    availablePaymentMethods.push({
      value: 'cash',
      label: language === 'ar' ? '💵 نقداً' : '💵 Cash',
    });
  }

  // Fai Fai has one card method only: Ziina online payment.
  // Never fall back to an unpaid physical-card order if Ziina is unavailable.
  if (ziinaEnabled) {
    availablePaymentMethods.push({
      value: 'ziina',
      label: language === 'ar' ? '💳 بطاقة (دفع أونلاين)' : '💳 Card (Online Payment)',
    });
  }

  // Allowed country codes from admin settings
  const [allowedCountryCodes, setAllowedCountryCodes] = useState<string[]>(['+971']);

  useEffect(() => {
    // Load allowed country codes from backend settings
    async function loadCountryCodes() {
      try {
        const res = await client.entities.restaurant_settings.query({ query: {}, limit: 1 });
        const items = res?.data?.items || [];
        if (items.length > 0) {
          const s = items[0] as any;
          if (s.allowed_country_codes) {
            const codes = s.allowed_country_codes.split(',').map((c: string) => c.trim()).filter(Boolean);
            if (codes.length > 0) setAllowedCountryCodes(codes);
          }
        }
      } catch { /* use default */ }
    }
    loadCountryCodes();
  }, []);

  // Phone validation with admin-configured country codes
  function validatePhone(phoneNumber: string, strict: boolean): string | null {
    const cleaned = phoneNumber.trim().replace(/[\s\-()]/g, '');
    
    if (!cleaned) {
      return t('checkout.phone_required');
    }

    if (strict) {
      // For delivery: must start with an allowed country code + have enough digits
      const hasValidCode = allowedCountryCodes.some(code => {
        const codeClean = code.replace(/[\s\-()]/g, '');
        // Check with + prefix or 00 prefix
        const withPlus = cleaned.startsWith(codeClean);
        const with00 = cleaned.startsWith('00' + codeClean.replace('+', ''));
        // Also allow local format (e.g., 05X for UAE)
        if (codeClean === '+971') {
          return withPlus || with00 || /^05[0-9]\d{7}$/.test(cleaned);
        }
        return withPlus || with00;
      });

      if (!hasValidCode) {
        return `${t('checkout.valid_phone_allowed')} (${allowedCountryCodes.join(', ')})`;
      }

      // Check minimum digits after country code
      const digitsOnly = cleaned.replace(/\D/g, '');
      if (digitsOnly.length < 9) {
        return t('checkout.phone_too_short');
      }
    } else {
      // For pickup: minimum 9 digits (allows any number)
      const digitsOnly = cleaned.replace(/\D/g, '');
      if (digitsOnly.length < 9) {
        return t('checkout.valid_phone_min');
      }
    }
    
    return null;
  }

  function validateForm(): Record<string, string> {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = t('checkout.enter_name');
    }
    
    // For delivery: strict validation with allowed country codes. For pickup: minimum 9 digits
    const phoneError = validatePhone(phone, orderType === 'delivery');
    if (phoneError) {
      newErrors.phone = phoneError;
    }
    if (orderType === 'delivery' && !locationShared) {
      newErrors.location = t('checkout.select_location');
    }
    if (orderType === 'delivery' && deliveryZoneError) {
      newErrors.location = deliveryZoneError;
    }
    // CRITICAL: Block delivery orders with zero delivery charge (pin not in valid zone)
    if (orderType === 'delivery' && locationShared && calculatedDeliveryCharge <= 0 && !deliveryZoneError) {
      newErrors.location = t('checkout.unable_delivery_charge');
    }
    if (availablePaymentMethods.length === 0) {
      newErrors.payment = t('checkout.no_payment_for_type');
    }
    if (cart.length === 0) {
      newErrors.cart = t('checkout.cart_add_items');
    }
    if (!isLoggedIn) {
      newErrors.auth = t('checkout.login_required');
    }

    return newErrors;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Prevent duplicate submissions
    if (submittingRef.current || loading) return;

    // Block if shop is closed
    if (shopClosed) {
      toast.error(shopClosedMessage || t('checkout.restaurant_closed'));
      return;
    }

    if (orderType === 'delivery' && !deliveryAvailableNow) {
      toast.error(
        `${t('checkout.delivery_available_from')} ${formatScheduleTime(deliveryStartTime, language)} ${t('checkout.to')} ${formatScheduleTime(deliveryEndTime, language)}. ${t('checkout.select_pickup')}`,
      );
      setOrderType('pickup');
      setShowMap(false);
      return;
    }

    // Block if not logged in
    if (!isLoggedIn) {
      toast.error(t('checkout.login_required'));
      return;
    }

    const validationErrors = validateForm();
    setErrors(validationErrors);
    setShowErrors(true);

    if (Object.keys(validationErrors).length > 0) {
      // Show summary toast
      const errorCount = Object.keys(validationErrors).length;
      toast.error(`${t('checkout.fix_before_order')} ${errorCount} ${errorCount === 1 ? t('checkout.issue') : t('checkout.issues')}`);

      // Scroll to first error field
      const errorFieldIds: Record<string, string> = {
        name: 'name',
        phone: 'phone',
        location: 'delivery-map',
        payment: 'payment-section',
        cart: 'order-summary',
        auth: 'auth-section',
      };
      const firstErrorKey = Object.keys(validationErrors)[0];
      const elementId = errorFieldIds[firstErrorKey];
      if (elementId) {
        const el = document.getElementById(elementId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // Handle auth redirect
      if (validationErrors.auth) {
        navigate('/account');
      }
      return;
    }

    setLoading(true);
    submittingRef.current = true;
    try {
      const itemsData = cart.map(item => ({
        menu_item_id: item.isDeal ? null : item.menuItem.id,
        name: item.menuItem.name,
        size: item.size,
        quantity: item.quantity,
        extras: item.extras.map(e => e.name),
        price: item.totalPrice,
        original_price: Number(item.originalTotalPrice ?? item.totalPrice),
        item_discount_amount: Number(item.itemDiscountAmount || 0),
        item_discount_label: item.itemDiscountLabel || '',
        is_deal: item.isDeal === true,
        deal_id: item.isDeal ? item.dealId : null,
        deal_selected_items: item.isDeal ? (item.dealSelectedItems || []) : [],
      }));

      // ONE-TIME REWARD FRONTEND CHECK:
      // Refresh right before order placement so a reward already used in another
      // order/tab/device disappears before the customer can submit again.
      if (selectedReward) {
        try {
          const latestRewards = await getMyRewards();
          const latestAvailable = latestRewards?.available || [];
          const stillAvailable = latestAvailable.some(
            reward => Number(reward.id) === Number(selectedReward.id)
          );
          if (!stillAvailable) {
            setAvailableRewards(latestAvailable);
            setSelectedReward(null);
            localStorage.removeItem('fai_fai_selected_reward_id');
            toast.error(language === 'ar'
              ? 'تم استخدام هذه المكافأة بالفعل. اختر مكافأة أخرى.'
              : 'This reward was already used. Choose another reward.');
            return;
          }
        } catch {
          // Backend still performs the final atomic one-time claim.
        }
      }

      // Combine notes with car info or delivery address
      const noteParts = [notes];
      if (orderType === 'pickup' && carInfo) {
        noteParts.push(`Car: ${carInfo}`);
      }
      if (orderType === 'delivery') {
        if (deliveryAddress) noteParts.push(`Delivery Address: ${deliveryAddress}`);
        if (deliveryFee > 0) noteParts.push(`Delivery Fee: AED ${deliveryFee.toFixed(2)}`);
        if (zoneName) noteParts.push(`Zone: ${zoneName}`);
        if (customerLat && customerLng) {
          noteParts.push(`GPS: ${customerLat.toFixed(6)},${customerLng.toFixed(6)}`);
        }
      }
      if (promoApplied && promoOffer) {
        const promoLabel = (promoOffer.discount_type || 'percentage') === 'fixed'
          ? `AED ${Number(promoOffer.fixed_discount_amount || promoDiscount).toFixed(2)}`
          : `${Number(promoOffer.discount_percent || promoDiscount)}%`;
        noteParts.push(`Promo: ${promoOffer.promo_code} (-${promoLabel})`);
      }
      if (selectedReward) {
        noteParts.push(`Reward: ${selectedReward.title} (#${selectedReward.id})`);
      }
      noteParts.push(`Order Type: ${orderType === 'delivery' ? 'Delivery' : 'Pickup'}`);
      const fullNotes = noteParts.filter(Boolean).join(' | ');

      const response = await axios.post(
        `${getAPIBaseURL().replace(/\/$/, '')}/api/v1/orders/place`,
        {
          session_id: getGuestSessionId(),
          customer_name: name.trim(),
          customer_phone: phone.trim(),
          order_notes: fullNotes,
          payment_method:
            paymentMethod === 'ziina'
              ? 'Ziina Online'
              : paymentMethod === 'cash'
                ? orderType === 'delivery'
                  ? 'Cash on Delivery'
                  : 'Cash on Pickup'
                : orderType === 'delivery'
                  ? 'Card on Delivery'
                  : 'Card on Pickup',
          total_amount: Number(total.toFixed(2)),
          subtotal_amount: Number(subtotal.toFixed(2)),
          promo_code: promoApplied && promoOffer ? promoOffer.promo_code : '',
          discount_type: promoApplied && promoOffer ? (promoOffer.discount_type || 'percentage') : '',
          discount_percent: promoApplied && promoOffer && (promoOffer.discount_type || 'percentage') !== 'fixed' ? Number(promoOffer.discount_percent || 0) : 0,
          discount_amount: Number(discountAmount.toFixed(2)),
          reward_id: selectedReward ? Number(selectedReward.id) : null,
          service_fee: Number(serviceFee.toFixed(2)),
          small_order_fee: Number(smallOrderFee.toFixed(2)),
          delivery_charge: orderType === 'delivery' ? Number(deliveryFee.toFixed(2)) : 0,
          tax_amount: Number(taxAmount.toFixed(2)),
          tip_amount: Number(tipAmount.toFixed(2)),
          tip_type: tipAmount > 0 ? (orderType === 'delivery' ? 'rider' : 'shop') : '',
          items_json: JSON.stringify(itemsData),
          order_type: orderType,
          customer_lat: orderType === 'delivery' ? customerLat : null,
          customer_lng: orderType === 'delivery' ? customerLng : null,
          customer_address: orderType === 'delivery' ? deliveryAddress.trim() : '',
          branch_id: selectedBranch?.id || null,
          replace_pending_payment_order_id:
            paymentMethod === 'ziina'
              ? null
              : Number(localStorage.getItem('vita_pending_ziina_order_id') || 0) || null,
        },
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('vita_customer_token') || ''}`,
          },
          timeout: 30000,
        },
      );

      const orderId = response?.data?.order_id;

      // If the customer came back from Ziina and selected Cash while the old
      // online payment had actually completed, backend returns the paid order
      // instead of creating a duplicate Cash order.
      if (response?.data?.payment_already_completed === true) {
        localStorage.removeItem('vita_pending_ziina_order_id');
        clearCart();
      localStorage.removeItem('fai_fai_selected_reward_id');
      if (selectedReward) setAvailableRewards(prev => prev.filter(r => Number(r.id) !== Number(selectedReward.id)));
      setSelectedReward(null);
        window.dispatchEvent(new Event('cart-updated'));
        toast.success(`${t('checkout.order_number')} #${orderId} — online payment already completed`);
        navigate('/order-confirmation', { state: { orderId } });
        return;
      }

      // Ziina online checkout: keep cart until backend confirms completed payment.
      if (paymentMethod === 'ziina') {
        localStorage.setItem('vita_customer_name', name.trim());
        localStorage.setItem('vita_customer_phone', phone.trim());

        try {
          const payment = await backendRequest(
            '/api/v1/ziina/create-payment',
            'POST',
            { order_id: orderId },
          );

          if (payment?.data?.already_paid === true) {
            localStorage.removeItem('vita_pending_ziina_order_id');
            clearCart();
      localStorage.removeItem('fai_fai_selected_reward_id');
      if (selectedReward) setAvailableRewards(prev => prev.filter(r => Number(r.id) !== Number(selectedReward.id)));
      setSelectedReward(null);
            window.dispatchEvent(new Event('cart-updated'));
            navigate('/order-confirmation', { state: { orderId } });
            return;
          }

          const redirectUrl = String(payment?.data?.redirect_url || '').trim();
          if (!redirectUrl) throw new Error('Ziina payment link was not returned');

          localStorage.setItem('vita_pending_ziina_order_id', String(orderId));
          window.location.assign(redirectUrl);
          return;
        } catch (paymentError) {
          try {
            const cleanup = await backendRequest(
              '/api/v1/ziina/cancel-payment-order',
              'POST',
              { order_id: orderId },
            );
            const cleanupStatus = String(cleanup?.data?.status || '').toLowerCase();
            if (cleanupStatus && cleanupStatus !== 'payment_pending') {
              localStorage.removeItem('vita_pending_ziina_order_id');
            } else {
              localStorage.setItem('vita_pending_ziina_order_id', String(orderId));
            }
          } catch {
            localStorage.setItem('vita_pending_ziina_order_id', String(orderId));
            // Keep the original payment error.
          }
          throw paymentError;
        }
      }
      
      // Existing Cash flow stays unchanged. Any pending Ziina order that
      // this Cash order superseded has already been handled by the backend.
      localStorage.setItem('vita_customer_name', name.trim());
      localStorage.setItem('vita_customer_phone', phone.trim());
      localStorage.removeItem('vita_pending_ziina_order_id');
      
      clearCart();
      localStorage.removeItem('fai_fai_selected_reward_id');
      if (selectedReward) setAvailableRewards(prev => prev.filter(r => Number(r.id) !== Number(selectedReward.id)));
      setSelectedReward(null);
      window.dispatchEvent(new Event('cart-updated'));
      toast.success(`${t('checkout.order_number')} #${orderId} ${t('checkout.order_success')}`);
      navigate('/order-confirmation', { state: { orderId } });
    } catch (e: any) {
      const errorMsg = e?.data?.detail || e?.response?.data?.detail || e?.message || t('checkout.failed_place_order');
      toast.error(errorMsg);
      console.error('Order placement failed:', e);
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }

  return (
    <CustomerLayout>
      <div className="bg-black min-h-screen px-4 py-6 max-w-lg mx-auto">
        <h1 className="text-white text-2xl font-bold mb-6">{t('checkout.title')}</h1>

        {!isLoggedIn && (
          <div id="auth-section" className="mb-6 p-4 rounded-xl bg-red-600/10 border border-red-600/30">
            <p className="text-red-400 text-sm mb-3">{t('checkout.login_required')}</p>
            <Button
              onClick={() => navigate('/account')}
              className="bg-red-600 hover:bg-red-700 text-white cursor-pointer"
            >
              {t('checkout.login_signup')}
            </Button>
          </div>
        )}

        {/* Shop Closed Banner */}
        {shopClosed && (
          <div className="mb-6 p-4 rounded-xl bg-orange-600/10 border border-orange-600/30">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">🚫</span>
              <h3 className="text-orange-400 font-bold text-lg">{t('checkout.restaurant_closed')}</h3>
            </div>
            <p className="text-orange-300 text-sm">{shopClosedMessage}</p>
          </div>
        )}

        {/* Busy Warning (not blocking) */}
        {!shopClosed && shopClosedMessage && (
          <div className="mb-6 p-3 rounded-xl bg-yellow-600/10 border border-yellow-600/30">
            <p className="text-yellow-400 text-sm">⚠️ {shopClosedMessage}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Order Type Selection */}
          {deliveryEnabled && (
            <div>
              <Label className="text-gray-300 mb-3 block">{t('checkout.order_type')}</Label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => { setOrderType('pickup'); setShowMap(false); }}
                  className={`p-4 rounded-xl border-2 transition-all cursor-pointer flex flex-col items-center gap-2 ${
                    orderType === 'pickup'
                      ? 'border-red-600 bg-red-600/10'
                      : 'border-gray-700 bg-gray-900 hover:border-gray-500'
                  }`}
                >
                  <Car className={`w-6 h-6 ${orderType === 'pickup' ? 'text-red-400' : 'text-gray-400'}`} />
                  <span className={`font-medium ${orderType === 'pickup' ? 'text-white' : 'text-gray-400'}`}>{t('checkout.pickup')}</span>
                  <span className="text-gray-500 text-xs">{t('checkout.collect_store')}</span>
                </button>
                <button
                  type="button"
                  disabled={!deliveryAvailableNow}
                  onClick={() => {
                    if (!deliveryAvailableNow) return;
                    setOrderType('delivery');
                    setShowMap(true);
                  }}
                  className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${
                    !deliveryAvailableNow
                      ? 'border-gray-800 bg-gray-900/60 opacity-60 cursor-not-allowed'
                      : 'cursor-pointer ' + (
                    orderType === 'delivery'
                      ? 'border-red-600 bg-red-600/10'
                      : 'border-gray-700 bg-gray-900 hover:border-gray-500'
                      )
                  }`}
                >
                  <MapPin className={`w-6 h-6 ${orderType === 'delivery' ? 'text-red-400' : 'text-gray-400'}`} />
                  <span className={`font-medium ${orderType === 'delivery' ? 'text-white' : 'text-gray-400'}`}>{t('checkout.delivery')}</span>
                  <span className="text-gray-500 text-xs">
                    {deliveryAvailableNow
                      ? t('checkout.to_your_location')
                      : `${t('checkout.opens')} ${formatScheduleTime(deliveryStartTime, language)}`}
                  </span>
                </button>
              </div>
            </div>
          )}

          {!shopClosed && deliveryEnabled && deliveryScheduleEnabled && (
            <div className={`rounded-xl border p-3 ${
              deliveryAvailableNow
                ? 'border-green-700/40 bg-green-900/10 text-green-300'
                : 'border-yellow-700/40 bg-yellow-900/10 text-yellow-300'
            }`}>
              <p className="text-sm">
                {t('checkout.delivery_hours')}: {formatScheduleTime(deliveryStartTime, language)} – {formatScheduleTime(deliveryEndTime, language)}
              </p>
              {!deliveryAvailableNow && (
                <p className="text-xs mt-1">
                  {t('checkout.delivery_closed_pickup_available')}
                </p>
              )}
            </div>
          )}

          {/* Customer Info */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="name" className="text-gray-300">{t('checkout.your_name')} *</Label>
              <Input
                id="name"
                value={name}
                onChange={e => { setName(e.target.value); if (showErrors) setErrors(prev => { const n = {...prev}; delete n.name; return n; }); }}
                placeholder={t('checkout.name_placeholder')}
                className={`bg-gray-900 border-gray-700 text-white mt-1 ${showErrors && errors.name ? 'border-red-500' : ''}`}
                required
              />
              {showErrors && errors.name && <p className="text-red-400 text-xs mt-1">⚠️ {errors.name}</p>}
            </div>
            <div>
              <Label htmlFor="phone" className="text-gray-300">{t('checkout.phone')} *</Label>
              <Input
                id="phone"
                value={phone}
                onChange={e => { setPhone(e.target.value); if (showErrors) setErrors(prev => { const n = {...prev}; delete n.phone; return n; }); }}
                placeholder={`${allowedCountryCodes[0] || '+971'} XX XXX XXXX`}
                className={`bg-gray-900 border-gray-700 text-white mt-1 ${showErrors && errors.phone ? 'border-red-500' : ''}`}
                required
              />
              {showErrors && errors.phone && <p className="text-red-400 text-xs mt-1">⚠️ {errors.phone}</p>}
            </div>

            {/* Delivery Map Location */}
            {orderType === 'delivery' && (
              <>
                <div id="delivery-map" className="space-y-3">
                  {/* Saved locations + current GPS: compact actions only */}
                  <div className="flex flex-wrap items-center gap-2">
                    {savedDeliveryLocations.map((saved) => (
                      <div
                        key={saved.id}
                        className="inline-flex items-center overflow-hidden rounded-xl border border-gray-700 bg-gray-900"
                      >
                        <button
                          type="button"
                          onClick={() => void useSavedDeliveryLocation(saved)}
                          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-100 hover:bg-gray-800"
                        >
                          <MapPin className="h-4 w-4 text-green-400" />
                          {localizedSavedLocationName(saved.name)}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteSavedDeliveryLocation(saved.id)}
                          className="border-l border-gray-700 px-2 py-2 text-gray-500 hover:bg-gray-800 hover:text-red-400"
                          aria-label={t('checkout.delete_saved_location')}
                          title={t('checkout.delete_saved_location')}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}

                    <Button
                      type="button"
                      size="sm"
                      disabled={gettingLocation}
                      onClick={() => {
                        void moveToCurrentLocation({
                          timeout: 15000,
                          maximumAge: 0,
                          showSuccess: true,
                        });
                      }}
                      className="ml-auto rounded-xl bg-blue-600 px-4 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Navigation className="mr-1.5 h-4 w-4" />
                      {gettingLocation ? t('checkout.getting') : t('checkout.my_location')}
                    </Button>
                  </div>

                  {/* Map */}
                  <div
                    ref={mapRef}
                    className="h-[250px] w-full overflow-hidden rounded-2xl border border-gray-700 bg-gray-900"
                    style={{ zIndex: 1 }}
                  />

                  {/* GPS permission fallback: only shown when actually needed */}
                  {locationPermissionDenied && !locationShared && (
                    <div className="rounded-xl border border-yellow-700/40 bg-yellow-900/10 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm text-yellow-200">
                          {t('checkout.location_access_help')}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => {
                            void moveToCurrentLocation({
                              timeout: 10000,
                              maximumAge: 0,
                              showSuccess: true,
                            });
                          }}
                          className="shrink-0 bg-yellow-600 text-white hover:bg-yellow-700"
                        >
                          {t('checkout.try_again')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {gettingLocation && !locationShared && (
                    <div className="flex items-center justify-center gap-2 py-1 text-sm text-blue-400">
                      <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                      <span>{t('checkout.getting_your_location')}</span>
                    </div>
                  )}

                  {/* Clean delivery price card — no zones, no km slabs, no technical text */}
                  {locationShared && !deliveryZoneError && (
                    <div className="flex items-center justify-between rounded-2xl border border-green-900/60 bg-green-950/20 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-5 w-5 text-green-400" />
                        <span className="font-medium text-gray-200">
                          {language === 'ar' ? 'رسوم التوصيل' : 'Delivery Fee'}
                        </span>
                      </div>
                      <span className="text-lg font-bold text-green-400">
                        AED {Number(calculatedDeliveryCharge || 0).toFixed(2)}
                      </span>
                    </div>
                  )}

                  {/* Optional save: understated until customer chooses it */}
                  {locationShared && !deliveryZoneError && (
                    <div>
                      {!showSaveLocationPanel ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (savedDeliveryLocations.length >= MAX_SAVED_DELIVERY_LOCATIONS) {
                              toast.error(t('checkout.saved_limit_reached'));
                              return;
                            }
                            setShowSaveLocationPanel(true);
                          }}
                          className="inline-flex items-center gap-2 rounded-xl px-1 py-1 text-sm font-medium text-green-400 hover:text-green-300"
                        >
                          <MapPin className="h-4 w-4" />
                          {language === 'ar' ? 'حفظ الموقع للطلب القادم' : 'Save location for next time'}
                        </button>
                      ) : (
                        <div className="rounded-2xl border border-gray-700 bg-gray-900/70 p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <p className="font-semibold text-white">
                              {language === 'ar' ? 'حفظ هذا الموقع' : 'Save this location'}
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setShowSaveLocationPanel(false);
                                setSaveLocationName('');
                              }}
                              className="rounded-lg p-1 text-gray-500 hover:bg-gray-800 hover:text-white"
                              aria-label={t('checkout.cancel')}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>

                          <div className="grid grid-cols-3 gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => saveCurrentDeliveryLocation('Home')}
                              className="rounded-xl border-gray-700 bg-gray-950 text-gray-200 hover:border-green-600 hover:text-green-400"
                            >
                              {t('checkout.home')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => saveCurrentDeliveryLocation('Work')}
                              className="rounded-xl border-gray-700 bg-gray-950 text-gray-200 hover:border-green-600 hover:text-green-400"
                            >
                              {t('checkout.work')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setSaveLocationName(t('checkout.other'))}
                              className="rounded-xl border-gray-700 bg-gray-950 text-gray-200 hover:border-green-600 hover:text-green-400"
                            >
                              {t('checkout.other')}
                            </Button>
                          </div>

                          {saveLocationName && (
                            <div className="mt-3 flex gap-2">
                              <Input
                                value={saveLocationName}
                                onChange={(event) => setSaveLocationName(event.target.value)}
                                maxLength={30}
                                placeholder={t('checkout.location_name_placeholder')}
                                className="rounded-xl border-gray-700 bg-gray-950 text-white"
                              />
                              <Button
                                type="button"
                                onClick={() => saveCurrentDeliveryLocation()}
                                className="rounded-xl bg-green-600 text-white hover:bg-green-700"
                              >
                                {t('checkout.save')}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {deliveryZoneError && (
                    <div className="rounded-xl border border-red-700/40 bg-red-900/10 p-3">
                      <p className="text-sm text-red-400">{deliveryZoneError}</p>
                    </div>
                  )}

                  {showErrors && errors.location && !deliveryZoneError && (
                    <p className="text-xs text-red-400">⚠️ {errors.location}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="address" className="text-gray-300">{language === 'ar' ? 'ملاحظات التوصيل (اختياري)' : 'Delivery Notes (optional)'}</Label>
                  <Textarea
                    id="address"
                    value={deliveryAddress}
                    onChange={e => setDeliveryAddress(e.target.value)}
                    placeholder={language === 'ar' ? 'اسم المبنى، الطابق، رقم الشقة...' : 'Building, floor, apartment number...'}
                    className="bg-gray-900 border-gray-700 text-white mt-1 rounded-xl"
                  />
</div>
              </>
            )}

            {/* Car Info (only for pickup) */}
            {orderType === 'pickup' && (
              <div>
                <Label htmlFor="carInfo" className="text-gray-300">{t('checkout.car_optional')}</Label>
                <Input
                  id="carInfo"
                  value={carInfo}
                  onChange={e => setCarInfo(e.target.value)}
                  placeholder={t('checkout.car_placeholder')}
                  className="bg-gray-900 border-gray-700 text-white mt-1"
                />
                <p className="text-gray-500 text-xs mt-1">{t('checkout.car_help')}</p>
              </div>
            )}

            <div>
              <Label htmlFor="notes" className="text-gray-300">{t('checkout.order_notes')}</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder={t('checkout.notes_placeholder')}
                className="bg-gray-900 border-gray-700 text-white mt-1"
              />
            </div>
          </div>

          {/* Fai Fai Rewards */}
          {(rewardsLoading || availableRewards.length > 0) && (
            <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/5 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="font-bold text-white">🎁 {language === 'ar' ? 'مكافآت فاي فاي' : 'Fai Fai Rewards'}</p>
                  <p className="text-xs text-gray-400">{language === 'ar' ? 'استخدم مكافأة واحدة في هذا الطلب.' : 'Use one reward on this order.'}</p>
                </div>
                <button type="button" onClick={() => navigate('/rewards')} className="text-xs font-semibold text-yellow-400 hover:text-yellow-300">{language === 'ar' ? 'عرض الكل' : 'View all'}</button>
              </div>
              {rewardsLoading ? (
                <p className="text-sm text-gray-500">{language === 'ar' ? 'جارٍ تحميل المكافآت…' : 'Loading rewards…'}</p>
              ) : selectedReward ? (
                <div className="rounded-xl border border-yellow-500/30 bg-black/30 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-yellow-300">{localizedRewardTitle(selectedReward, language)}</p>
                      <p className="mt-1 text-xs text-gray-400">{language === 'ar' ? 'الحد الأدنى للطلب' : 'Minimum order'} AED {Number(selectedReward.minimum_order || 0).toFixed(0)}</p>
                      {rewardDiscountAmount > 0 && <p className="mt-1 text-xs text-green-400">{language === 'ar' ? 'توفير' : 'Saving'} AED {rewardDiscountAmount.toFixed(2)}</p>}
                    </div>
                    <button type="button" onClick={removeReward} className="text-xs text-gray-400 hover:text-red-400">{language === 'ar' ? 'إزالة' : 'Remove'}</button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {availableRewards.slice(0, 3).map(reward => (
                    <button key={reward.id} type="button" onClick={() => chooseReward(reward)} className="flex w-full items-center justify-between rounded-xl border border-gray-800 bg-black/30 p-3 text-left hover:border-yellow-500/40">
                      <div>
                        <p className="text-sm font-semibold text-white">{reward.tier === 'golden' ? '👑 ' : '🎁 '}{localizedRewardTitle(reward, language)}</p>
                        <p className="text-xs text-gray-500">{language === 'ar' ? 'الحد الأدنى' : 'Min.'} AED {Number(reward.minimum_order || 0).toFixed(0)}</p>
                      </div>
                      <span className="text-xs font-bold text-yellow-400">{language === 'ar' ? 'استخدم' : 'Use'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Promo Code — hidden until Admin has a currently active promo-code offer */}
          {activePromoOffers.length > 0 && (
            <div>
              <Label className="text-gray-300 mb-2 block">{t('checkout.promo_code')}</Label>
              {promoApplied ? (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-green-600/10 border border-green-600/30">
                  <Tag className="w-5 h-5 text-green-400" />
                  <div className="flex-1">
                    <p className="text-green-400 font-medium text-sm">{promoOffer?.promo_code} {t('checkout.applied')}</p>
                    <p className="text-green-400/70 text-xs">
                      {(promoOffer?.discount_type || 'percentage') === 'fixed'
                        ? `AED ${Number(promoOffer?.fixed_discount_amount || promoDiscount).toFixed(2)} ${t('checkout.discount')}`
                        : `${Number(promoOffer?.discount_percent || promoDiscount)}% ${t('checkout.discount')}`}
                      {' — '}{t('checkout.saving')} AED {discountAmount.toFixed(2)}
                    </p>
                  </div>
                  <button type="button" onClick={removePromo} className="text-gray-400 text-xs hover:text-red-400 cursor-pointer">
                    {t('checkout.remove')}
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    value={promoCode}
                    onChange={e => setPromoCode(e.target.value)}
                    placeholder={t('checkout.promo_placeholder')}
                    className="bg-gray-900 border-gray-700 text-white flex-1"
                  />
                  <Button
                    type="button"
                    onClick={validatePromoCode}
                    disabled={validatingPromo}
                    className="bg-gray-800 hover:bg-gray-700 text-white cursor-pointer"
                  >
                    {validatingPromo ? '...' : t('checkout.apply')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Tip Section */}
          <div>
            <Label className="text-gray-300 mb-3 block">
              💝 {t('checkout.add_tip')} {orderType === 'delivery' ? t('checkout.tip_goes_rider_note') : t('checkout.tip_goes_shop_note')}
            </Label>
            <div className="flex flex-wrap gap-2 mb-2">
              {[5, 10, 15].map(amount => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => { setTipAmount(amount); setShowCustomTip(false); setCustomTip(''); }}
                  className={`px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all cursor-pointer ${
                    tipAmount === amount && !showCustomTip
                      ? 'border-green-500 bg-green-600/20 text-green-400'
                      : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-500'
                  }`}
                >
                  AED {amount}
                </button>
              ))}
              <button
                type="button"
                onClick={() => { setShowCustomTip(true); setTipAmount(0); }}
                className={`px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all cursor-pointer ${
                  showCustomTip
                    ? 'border-green-500 bg-green-600/20 text-green-400'
                    : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-500'
                }`}
              >
                {t('checkout.custom')}
              </button>
              {tipAmount > 0 && (
                <button
                  type="button"
                  onClick={() => { setTipAmount(0); setShowCustomTip(false); setCustomTip(''); }}
                  className="px-3 py-2.5 rounded-lg border-2 border-gray-700 bg-gray-900 text-gray-500 text-sm cursor-pointer hover:border-red-600 hover:text-red-400"
                >
                  {t('checkout.no_tip')}
                </button>
              )}
            </div>
            {showCustomTip && (
              <div className="flex items-center gap-2">
                <span className="text-gray-400 text-sm">AED</span>
                <Input
                  type="number"
                  min="1"
                  max="500"
                  value={customTip}
                  onChange={e => {
                    setCustomTip(e.target.value);
                    const val = parseFloat(e.target.value);
                    setTipAmount(val > 0 ? val : 0);
                  }}
                  placeholder={t('checkout.enter_amount')}
                  className="bg-gray-900 border-gray-700 text-white w-32"
                />
              </div>
            )}
            {tipAmount > 0 && (
              <p className="text-green-400/80 text-xs mt-2">
                ✓ AED {tipAmount.toFixed(0)} {t('checkout.tip')} {orderType === 'delivery' ? t('checkout.will_go_rider') : t('checkout.will_go_shop')}
              </p>
            )}
          </div>

          {/* Payment Method */}
          <div id="payment-section">
            <Label className="text-gray-300 mb-3 block">{t('checkout.payment_method')}</Label>
            {availablePaymentMethods.length === 0 ? (
              <div className="p-4 rounded-xl bg-red-600/10 border border-red-600/30">
                <p className="text-red-400 text-sm">{t('checkout.no_payment_for_type')}. {t('checkout.contact_restaurant')}</p>
              </div>
            ) : (
              <RadioGroup value={availablePaymentMethods.some(m => m.value === paymentMethod) ? paymentMethod : availablePaymentMethods[0]?.value || 'cash'} onValueChange={setPaymentMethod} className="space-y-3">
                {availablePaymentMethods.map(method => (
                  <label key={method.value} className="flex items-center gap-3 p-4 rounded-xl border border-gray-700 hover:border-gray-500 cursor-pointer">
                    <RadioGroupItem value={method.value} id={method.value} />
                    <div className="text-white font-medium">{method.label}</div>
                  </label>
                ))}
              </RadioGroup>
            )}
          </div>

          {/* Order Summary */}
          <div id="order-summary" className={`p-4 rounded-xl bg-gray-900 border ${showErrors && errors.cart ? 'border-red-500' : 'border-gray-800'}`}>
            <h3 className="text-white font-semibold mb-3">{t('checkout.order_summary')}</h3>
            {showErrors && errors.cart && <p className="text-red-400 text-xs mb-3">⚠️ {errors.cart}</p>}
            {cart.map(item => (
              <div key={item.id} className="flex justify-between text-sm py-1.5">
                <span className="text-gray-400">
                  {item.quantity}x {localizedMenuText(item.menuItem, language)} ({displaySize(item.size)})
                  {item.extras.length > 0 && (
                    <span className="text-gray-600 text-xs block">
                      + {item.extras.map(e => localizedMenuText(e, language)).join(', ')}
                    </span>
                  )}
                </span>
                <div className="text-right">
                  {Number(item.itemDiscountAmount || 0) > 0 && (
                    <span className="text-gray-600 text-xs line-through block">
                      AED {Number(item.originalTotalPrice ?? item.totalPrice).toFixed(2)}
                    </span>
                  )}
                  <span className={Number(item.itemDiscountAmount || 0) > 0 ? 'text-green-400' : 'text-gray-300'}>
                    AED {item.totalPrice.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
            <div className="border-t border-gray-700 mt-3 pt-3 space-y-1.5">
              {itemDiscountTotal > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">{t('checkout.original_subtotal')}</span>
                    <span className="text-gray-500 line-through">AED {originalSubtotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-green-400">{t('checkout.item_discounts')}</span>
                    <span className="text-green-400">-AED {itemDiscountTotal.toFixed(2)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">{t('checkout.subtotal')}</span>
                <span className="text-gray-300">AED {subtotal.toFixed(2)}</span>
              </div>
              {orderType === 'delivery' && deliveryFee > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">{t('checkout.delivery_fee')}</span>
                  <span className="text-gray-300">AED {deliveryFee.toFixed(2)}</span>
                </div>
              )}
              {serviceFee > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">{t('checkout.service_fee')}</span>
                  <span className="text-gray-300">AED {serviceFee.toFixed(2)}</span>
                </div>
              )}
              {smallOrderFee > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-yellow-400">{t('checkout.small_order_fee')}</span>
                  <span className="text-yellow-400">AED {smallOrderFee.toFixed(2)}</span>
                </div>
              )}
              {taxAmount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">
                    {vatIncluded ? t('checkout.vat_included') : `${t('checkout.vat_tax')} (${taxPercent.toFixed(2)}%)`}
                  </span>
                  <span className="text-gray-300">AED {taxAmount.toFixed(2)}</span>
                </div>
              )}
              {tipAmount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-green-400">{t('checkout.tip')} ({orderType === 'delivery' ? t('checkout.rider') : t('checkout.shop')})</span>
                  <span className="text-green-400">AED {tipAmount.toFixed(2)}</span>
                </div>
              )}
              {(promoApplied || selectedReward) && discountAmount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-green-400">{selectedReward ? `${language === 'ar' ? 'المكافأة' : 'Reward'}: ${localizedRewardTitle(selectedReward, language)}` : `${t('checkout.discount')} (${(promoOffer?.discount_type || 'percentage') === 'fixed' ? `AED ${Number(promoOffer?.fixed_discount_amount || promoDiscount).toFixed(2)}` : `${Number(promoOffer?.discount_percent || promoDiscount)}%`})`}</span>
                  <span className="text-green-400">-AED {discountAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t border-gray-700">
                <span className="text-white font-semibold">{t('checkout.total')}</span>
                <span className="text-red-400 font-bold text-lg">AED {total.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {showErrors && Object.keys(errors).length > 0 && (
            <div className="p-3 rounded-xl bg-red-600/10 border border-red-500/30 mb-3">
              <p className="text-red-400 text-sm font-medium mb-1">⚠️ {t('checkout.please_fix_following')}</p>
              <ul className="space-y-0.5">
                {Object.values(errors).map((err, i) => (
                  <li key={i} className="text-red-400/80 text-xs">• {err}</li>
                ))}
              </ul>
            </div>
          )}

          <Button
            type="submit"
            disabled={loading || shopClosed || !isLoggedIn || (orderType === 'delivery' && (!deliveryAvailableNow || !!deliveryZoneError || !locationShared || calculatedDeliveryCharge <= 0))}
            className="w-full bg-red-600 hover:bg-red-700 text-white py-6 text-lg font-semibold rounded-xl cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? t('checkout.placing') : `${t('checkout.place_order')} — ${t('common.aed')} ${total.toFixed(2)}`}
          </Button>
        </form>
      </div>
    </CustomerLayout>
  );
}
