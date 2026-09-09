import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Home, UtensilsCrossed, ShoppingCart, ClipboardList, UserRound } from 'lucide-react';
import { getCartItemCount, getCart } from '@/lib/cart-store';
import { useTranslation } from '@/lib/i18n';
import { LanguageSwitcher } from '@/components/LanguagePicker';
import FaiFaiWordmark from '@/components/FaiFaiWordmark';

interface CustomerLayoutProps {
  children: ReactNode;
}

export default function CustomerLayout({ children }: CustomerLayoutProps) {
  const location = useLocation();
  const { t } = useTranslation();
  const [cartCount, setCartCount] = useState(0);

  useEffect(() => {
    const updateCount = () => setCartCount(getCartItemCount(getCart()));
    updateCount();
    
    // Listen for storage events to update cart count
    window.addEventListener('storage', updateCount);
    // Custom event for same-tab updates
    window.addEventListener('cart-updated', updateCount);
    return () => {
      window.removeEventListener('storage', updateCount);
      window.removeEventListener('cart-updated', updateCount);
    };
  }, [location]);

  const navItems = [
    { path: '/', icon: Home, label: t('nav.home') },
    { path: '/menu', icon: UtensilsCrossed, label: t('nav.menu') },
    { path: '/cart', icon: ShoppingCart, label: t('nav.cart'), badge: cartCount },
    { path: '/my-orders', icon: ClipboardList, label: t('nav.orders') },
    { path: '/account?manage=1', activePath: '/account', icon: UserRound, label: t('nav.account') },
  ];

  return (
    <div className="fai-customer-app min-h-screen bg-background flex flex-col">
      <style>{`
        .fai-customer-app, .fai-customer-app * {
          -webkit-user-select: none !important;
          user-select: none !important;
          -webkit-touch-callout: none !important;
        }
        .fai-customer-app input,
        .fai-customer-app textarea,
        .fai-customer-app [contenteditable="true"] {
          -webkit-user-select: text !important;
          user-select: text !important;
          -webkit-touch-callout: default !important;
        }
      `}</style>
      {/* Header */}
      <header className="sticky top-0 z-50 bg-black border-b border-red-900/30">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-red-600 to-green-700 flex items-center justify-center">
              <span className="text-white font-bold text-sm">FF</span>
            </div>
            <FaiFaiWordmark compact className="text-xl" />
          </Link>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
          </div>

        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 pb-20">
        {children}
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-black border-t border-red-900/30">
        <div className="max-w-7xl mx-auto flex items-center justify-around py-2">
          {navItems.map(({ path, activePath, icon: Icon, label, badge }) => {
            const isActive = location.pathname === (activePath || path);
            return (
              <Link
                key={path}
                to={path}
                className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-colors relative cursor-pointer ${
                  isActive ? 'text-red-500' : 'text-gray-400 hover:text-white'
                }`}
              >
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {badge && badge > 0 && (
                    <span className="absolute -top-2 -right-2 bg-red-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-medium">{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

    </div>
  );
}
