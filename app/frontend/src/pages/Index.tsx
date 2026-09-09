import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingBag, Clock, Phone, MapPin, ChevronRight, Tag, MessageSquare, Star, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { client, MenuItem, Category, RestaurantSettings, Offer, getItemSizes } from '@/lib/api';
import { getItemPriceBreakdown, isPromoOfferCurrentlyActive } from '@/lib/discounts';
import { useTranslation } from '@/lib/i18n';
import { LanguageSwitcher } from '@/components/LanguagePicker';
import NotificationBanner from '@/components/NotificationBanner';

// Welcome animation is shown once per app load, not every time the Home route is opened.
let welcomeHasBeenShown = false;

const CACHE_KEY = 'fai_home_cache_v6';
const CACHE_TTL = 120000; // 2 minutes

interface CachedData {
  settings: RestaurantSettings | null;
  featuredItems: MenuItem[];
  categories: Category[];
  offers: Offer[];
  timestamp: number;
}

function getCachedData(): CachedData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedData;
    // Return cache even if expired (we'll refresh in background)
    return parsed;
  } catch {
    return null;
  }
}

function setCachedData(data: Omit<CachedData, 'timestamp'>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, timestamp: Date.now() }));
  } catch { /* storage full - ignore */ }
}

export default function Index() {
  const navigate = useNavigate();
  const { t, isRTL, language } = useTranslation();
  // Show the welcome animation only once for this app/page-load session.
  // Navigating to Home again will NOT restart it. A full app reload starts a new session.
  const [showWelcome, setShowWelcome] = useState(() => {
    if (welcomeHasBeenShown) return false;
    welcomeHasBeenShown = true;
    return true;
  });

  useEffect(() => {
    if (!showWelcome) return;
    const timer = window.setTimeout(() => setShowWelcome(false), 22000);
    return () => window.clearTimeout(timer);
  }, [showWelcome]);

  // Initialize from cache for instant display
  const cached = getCachedData();
  const [settings, setSettings] = useState<RestaurantSettings | null>(cached?.settings || null);
  const [featuredItems, setFeaturedItems] = useState<MenuItem[]>(cached?.featuredItems || []);
  const [categories, setCategories] = useState<Category[]>(cached?.categories || []);
  const [offers, setOffers] = useState<Offer[]>(cached?.offers || []);
  // Only show loading spinner if we have NO cached data
  const [loading, setLoading] = useState(!cached);

  const loadData = useCallback(async () => {
    try {
      const [settingsRes, itemsRes, catRes, offersRes, popularRes] = await Promise.all([
        client.entities.restaurant_settings.query({ query: {}, limit: 1 }),
        client.entities.menu_items.query({ query: { is_active: true }, sort: 'sort_order', limit: 200 }),
        client.entities.categories.query({ query: { is_active: true }, sort: 'sort_order', limit: 20 }),
        client.entities.offers.query({ query: { is_active: true }, limit: 100 }),
        client.apiCall.invoke({ url: '/api/v1/public/popular-items', method: 'GET' }).catch(() => null),
      ]);
      const settingsData = settingsRes?.data?.items?.[0] || null;
      const allItems = itemsRes?.data?.items || [];
      const popularItems = popularRes?.data?.items || [];
      const maxPopular = Math.max(2, Math.min(12, Number((settingsData as any)?.popular_max_items || 6)));
      const items = popularItems.length > 0 ? popularItems.slice(0, maxPopular) : allItems.slice(0, maxPopular);
      const cats = catRes?.data?.items || [];
      const offersList = (offersRes?.data?.items || []).filter((offer: Offer) => isPromoOfferCurrentlyActive(offer));

      setSettings(settingsData);
      setFeaturedItems(items);
      setCategories(cats);
      setOffers(offersList);

      // Cache for next visit
      setCachedData({ settings: settingsData, featuredItems: items, categories: cats, offers: offersList });

    } catch (e) {
      console.error('Failed to load data:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // If we have cache, still refresh in background but don't block UI
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      // Cache is fresh enough, refresh silently in background
      setLoading(false);
      // Background refresh after a short delay
      const timer = setTimeout(loadData, 2000);
      return () => clearTimeout(timer);
    } else {
      // No cache or stale - load immediately
      loadData();
    }
  }, [loadData]);

  function getStatusColor(status: string) {
    switch (status) {
      case 'open': return 'bg-green-500';
      case 'busy': return 'bg-yellow-500';
      case 'closed': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  }

  function getStatusText(status: string) {
    switch (status) {
      case 'open': return t('home.open_now');
      case 'busy': return t('home.busy');
      case 'closed': return t('home.closed');
      default: return 'Unknown';
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl font-black mb-2">
            <span className="text-white">{settings?.restaurant_name || 'Fai Fai Juice'}</span>
          </div>
          <div className="w-8 h-8 border-2 border-red-600 border-t-transparent rounded-full animate-spin mx-auto mt-2" />
          <p className="text-gray-500 text-sm mt-2">{t('home.loading')}</p>
        </div>
      </div>
    );
  }

  const restaurantStatus = settings?.restaurant_status || 'open';

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-gray-950/95 backdrop-blur-sm border-b border-gray-800">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {settings?.logo_url && (
              <img src={settings.logo_url} alt="Logo" className="w-8 h-8 rounded-full object-cover" />
            )}
            <div>
              <span className="text-white font-black text-lg">
                {settings?.restaurant_name || 'Fai Fai Juice'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <div className="flex items-center gap-1.5">
              <div className={`w-2.5 h-2.5 rounded-full ${getStatusColor(restaurantStatus)} animate-pulse`} />
              <span className="text-xs text-gray-300 font-medium">{getStatusText(restaurantStatus)}</span>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-lg mx-auto px-4 pb-24">
        {/* Notifications - deferred loading */}
        <NotificationBanner />

        {/* Hero Branding */}
        <div className="py-8 text-center">
          <h1 className="text-5xl font-black mb-1">
            <span className="text-white">{settings?.restaurant_name || 'Fai Fai Juice'}</span>
          </h1>
          <p className="text-gray-400 text-sm">{t('home.tagline')}</p>
          {settings?.banner_text && (
            <div className="mt-4 rounded-xl border border-red-600/30 bg-red-600/10 px-4 py-3">
              <p className="text-red-200 text-sm font-medium">{settings.banner_text}</p>
            </div>
          )}
          
          {settings?.show_status_banner !== false && restaurantStatus === 'busy' && (
            <div className="mt-4 bg-yellow-600/10 border border-yellow-600/30 rounded-xl px-4 py-3">
              <p className="text-yellow-400 text-sm font-medium">
                {settings?.busy_message || 'We are currently very busy. Your order may take longer than usual.'}
              </p>
              {settings?.estimated_wait_time && (
                <p className="text-yellow-500/70 text-xs mt-1">Estimated wait: {settings.estimated_wait_time}</p>
              )}
            </div>
          )}
          {settings?.show_status_banner !== false && restaurantStatus === 'closed' && (
            <div className="mt-4 bg-red-600/10 border border-red-600/30 rounded-xl px-4 py-3">
              <p className="text-red-400 text-sm font-medium">
                {t('home.closed_message')}
              </p>
              <p className="text-red-500/70 text-xs mt-1">{t('home.closed_subtitle')}</p>
            </div>
          )}
        </div>

        {/* Active Offers */}
        {settings?.show_offers !== false && offers.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Tag className="w-4 h-4 text-red-500" />
              <h2 className="text-white font-bold text-sm">{t('home.special_offers')}</h2>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide">
              {offers.map(offer => (
                <div
                  key={offer.id}
                  className="flex-shrink-0 w-64 bg-gradient-to-br from-red-600/20 to-orange-600/10 border border-red-600/30 rounded-xl p-4"
                >
                  <h3 className="text-white font-bold text-sm">{offer.title}</h3>
                  <p className="text-gray-400 text-xs mt-1">{offer.description}</p>
                  {((offer.discount_type || 'percentage') === 'fixed'
                    ? Number(offer.fixed_discount_amount || 0) > 0
                    : Number(offer.discount_percent || 0) > 0) && (
                    <Badge className="bg-red-600 text-white mt-2 text-xs">
                      {(offer.discount_type || 'percentage') === 'fixed'
                        ? `AED ${Number(offer.fixed_discount_amount || 0).toFixed(2)} OFF`
                        : `${Number(offer.discount_percent || 0)}% OFF`}
                    </Badge>
                  )}
                  {offer.promo_code && (
                    <p className="text-orange-400 text-xs mt-1 font-mono">Code: {offer.promo_code}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick Actions */}
        {settings?.show_quick_actions !== false && (
        <div className="grid grid-cols-4 gap-2 mb-6">
          <Button
            onClick={() => navigate('/menu')}
            className="bg-red-600 hover:bg-red-700 text-white h-14 rounded-xl font-semibold cursor-pointer flex flex-col items-center justify-center gap-0.5"
          >
            <ShoppingBag className="w-5 h-5" />
            <span className="text-[10px]">{t('nav.menu')}</span>
          </Button>
          <Button
            onClick={() => navigate('/deals')}
            className="bg-orange-600 hover:bg-orange-700 text-white h-14 rounded-xl font-semibold cursor-pointer flex flex-col items-center justify-center gap-0.5"
          >
            <Package className="w-5 h-5" />
            <span className="text-[10px]">Deals</span>
          </Button>
          <Button
            onClick={() => navigate('/my-orders')}
            variant="outline"
            className="border-gray-700 text-gray-300 hover:text-white h-14 rounded-xl font-semibold cursor-pointer flex flex-col items-center justify-center gap-0.5"
          >
            <Clock className="w-5 h-5" />
            <span className="text-[10px]">{t('home.my_orders')}</span>
          </Button>
          <Button
            onClick={() => navigate('/contact')}
            variant="outline"
            className="border-gray-700 text-gray-300 hover:text-white h-14 rounded-xl font-semibold cursor-pointer flex flex-col items-center justify-center gap-0.5"
          >
            <Phone className="w-5 h-5" />
            <span className="text-[10px]">{t('nav.contact')}</span>
          </Button>
        </div>
        )}

        {/* Featured Items */}
        {settings?.show_popular_items !== false && featuredItems.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white font-bold">{t('home.popular_items')}</h2>
            <button onClick={() => navigate('/menu')} className="text-red-500 text-sm flex items-center gap-1 cursor-pointer">
              {t('home.view_all')} <ChevronRight className={`w-4 h-4 ${isRTL ? 'rotate-180' : ''}`} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {featuredItems.slice(0, Math.max(2, Math.min(12, Number(settings?.popular_max_items || 6)))).map(item => {
              const sizes = getItemSizes(item);
              const lowestSize = sizes.reduce((lowest, size) => size.price < lowest.price ? size : lowest, sizes[0]);
              const lowestPrice = lowestSize?.price || 0;
              const lowestBreakdown = getItemPriceBreakdown(item, lowestPrice);
              return (
                <Card
                  key={item.id}
                  className="bg-gray-900 border-gray-800 overflow-hidden cursor-pointer hover:border-gray-700 transition-colors"
                  onClick={() => navigate('/menu')}
                >
                  <div className="relative">
                    {item.image_url ? (
                      <img src={item.image_url} alt={item.name} className="w-full h-28 object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-28 bg-gray-800 flex items-center justify-center">
                        <span className="text-3xl">🍕</span>
                      </div>
                    )}
                    {lowestBreakdown.discountActive && item.is_active && (
                      <Badge className="absolute top-2 left-2 bg-green-600 text-white text-[10px]">
                        {lowestBreakdown.discountLabel}
                      </Badge>
                    )}
                    {!item.is_active && (
                      <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
                        <Badge className="bg-red-600 text-white text-xs">{t('home.out_of_stock')}</Badge>
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <h3 className="text-white text-sm font-semibold truncate">{item.name}</h3>
                    {lowestBreakdown.discountActive ? (
                      <div className="mt-1">
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="text-gray-500 text-xs line-through">AED {lowestBreakdown.originalPrice.toFixed(2)}</span>
                          <span className="text-green-400 text-sm font-bold">AED {lowestBreakdown.finalPrice.toFixed(2)}</span>
                        </div>
                        <p className="text-green-500 text-[10px]">{lowestBreakdown.discountLabel} • Save AED {lowestBreakdown.saving.toFixed(2)}</p>
                      </div>
                    ) : (
                      <p className="text-red-500 text-sm font-bold mt-1">
                        {t('home.from_aed')} {lowestPrice}
                      </p>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
        )}

        {/* Customer Reviews Section */}
        {settings?.show_reviews !== false && (
        <div className="mb-6">
          <button
            onClick={() => navigate('/reviews')}
            className="w-full bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between cursor-pointer hover:border-gray-700 transition-colors"
          >
            <div className="flex items-center gap-3">
              <Star className="w-5 h-5 text-yellow-400 fill-yellow-400" />
              <div className={isRTL ? 'text-right' : 'text-left'}>
                <span className="text-white font-semibold text-sm block">{t('home.customer_reviews')}</span>
                <span className="text-gray-500 text-xs">{t('home.reviews_subtitle')}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        )}

        {/* Blog Section */}
        {(settings as any)?.blog_enabled !== false && (
        <div className="mb-6">
          <a
            href="/blog/"
            className="w-full bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between cursor-pointer hover:border-gray-700 transition-colors block"
          >
            <div className="flex items-center gap-3">
              <ShoppingBag className="w-5 h-5 text-red-500" />
              <div className={isRTL ? 'text-right' : 'text-left'}>
                <span className="text-white font-semibold text-sm block">Blog & Pizza Tips</span>
                <span className="text-gray-500 text-xs">Local food guides & Italian pizza stories</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-500" />
          </a>
        </div>
        )}

        {/* Restaurant Info */}
        {settings?.show_restaurant_info !== false && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-white font-bold text-sm">{t('home.restaurant_info')}</h3>
          <div className="flex items-start gap-3">
            <Clock className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-gray-300 text-sm">{settings?.opening_hours || 'Daily 3:00 PM - 2:00 AM'}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Phone className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
            <p className="text-gray-300 text-sm">{settings?.phone || '+971 54 294 0112'}</p>
          </div>
          <div className="flex items-start gap-3">
            <MapPin className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
            <p className="text-gray-300 text-sm">{settings?.address || 'Murbah, Fujairah, UAE'}</p>
          </div>
        </div>
        )}
      </div>

      {/* Bottom Navigation */}
      {settings?.show_bottom_nav !== false && (
      <nav className="fixed bottom-0 left-0 right-0 bg-gray-900/95 backdrop-blur-sm border-t border-gray-800 z-50">
        <div className="max-w-lg mx-auto flex items-center justify-around py-3">
          <button onClick={() => navigate('/')} className="flex flex-col items-center gap-1 cursor-pointer">
            <div className="w-6 h-6 rounded-full bg-red-600 flex items-center justify-center">
              <span className="text-white text-xs font-bold">V</span>
            </div>
            <span className="text-red-500 text-[10px] font-medium">{t('nav.home')}</span>
          </button>
          <button onClick={() => navigate('/menu')} className="flex flex-col items-center gap-1 cursor-pointer">
            <ShoppingBag className="w-5 h-5 text-gray-500" />
            <span className="text-gray-500 text-[10px]">{t('nav.menu')}</span>
          </button>
          <button onClick={() => navigate('/my-orders')} className="flex flex-col items-center gap-1 cursor-pointer">
            <Clock className="w-5 h-5 text-gray-500" />
            <span className="text-gray-500 text-[10px]">{t('nav.orders')}</span>
          </button>
          <button onClick={() => navigate('/feedback')} className="flex flex-col items-center gap-1 cursor-pointer">
            <MessageSquare className="w-5 h-5 text-gray-500" />
            <span className="text-gray-500 text-[10px]">{t('nav.feedback')}</span>
          </button>
        </div>
      </nav>
      )}

      {showWelcome && (
        <div className="fixed inset-0 z-[2147483647] bg-black" role="dialog" aria-label="Welcome">
          <img
            src="/fai-fai-welcome-animation.webp"
            alt="Welcome"
            className="absolute inset-0 h-full w-full object-cover pointer-events-none select-none"
            draggable={false}
          />
          <button
            type="button"
            onClick={() => setShowWelcome(false)}
            className="absolute right-4 top-4 z-10 rounded-full bg-black/65 px-4 py-2 text-sm font-bold text-white"
          >
            {language === 'ar' ? 'تخطي' : language === 'ur' ? 'چھوڑیں' : 'Skip'}
          </button>
        </div>
      )}
    </div>
  );
}
