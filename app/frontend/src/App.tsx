import {
  lazy,
  ReactElement,
  Suspense,
} from 'react';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';

import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';

import { I18nProvider } from '@/lib/i18n';
import { LanguagePickerModal } from '@/components/LanguagePicker';
import { CustomerHeartbeatProvider } from '@/components/CustomerHeartbeatProvider';
import { CustomerAuthProvider } from '@/contexts/CustomerAuthContext';
import { useCustomerAuth } from '@/contexts/CustomerAuthContext';
import { BranchProvider } from '@/contexts/BranchContext';

// Customer home is loaded eagerly so opening the app does not show the generic
// Suspense spinner before the real Fai Fai welcome screen.
import Index from './pages/Index';

// Customer pages
const Menu = lazy(() => import('./pages/Menu'));
const Cart = lazy(() => import('./pages/Cart'));
const Checkout = lazy(() => import('./pages/Checkout'));

const OrderConfirmation = lazy(
  () => import('./pages/OrderConfirmation')
);

const MyOrders = lazy(() => import('./pages/MyOrders'));
const Contact = lazy(() => import('./pages/Contact'));
const Deals = lazy(() => import('./pages/Deals'));
const Feedback = lazy(() => import('./pages/Feedback'));
const Reviews = lazy(() => import('./pages/Reviews'));
const Rewards = lazy(() => import('./pages/Rewards'));
const Support = lazy(() => import('./pages/Support'));

const CustomerAuth = lazy(
  () => import('./pages/CustomerAuth')
);

const RiderPanel = lazy(
  () => import('./pages/RiderPanel')
);

const DeliveryTracking = lazy(
  () => import('./pages/DeliveryTracking')
);

const BlogRoutes = lazy(
  () => import('./blog-routes')
);

// Admin pages
const AdminLogin = lazy(
  () => import('./pages/admin/AdminLogin')
);

const AdminDashboard = lazy(
  () => import('./pages/admin/AdminDashboard')
);

const AdminOrders = lazy(
  () => import('./pages/admin/AdminOrders')
);

const AdminMenu = lazy(
  () => import('./pages/admin/AdminMenu')
);

const AdminCustomers = lazy(
  () => import('./pages/admin/AdminCustomers')
);

const AdminSettings = lazy(
  () => import('./pages/admin/AdminSettings')
);

const AdminBrandSettings = lazy(
  () => import('./pages/admin/AdminBrandSettings')
);

const AdminRestaurantSettings = lazy(
  () => import('./pages/admin/AdminRestaurantSettings')
);

const AdminBranches = lazy(
  () => import('./pages/admin/AdminBranches')
);

const AdminHomepageSettings = lazy(
  () => import('./pages/admin/AdminHomepageSettings')
);

const AdminCheckoutSettings = lazy(
  () => import('./pages/admin/AdminCheckoutSettings')
);

const AdminOrderSettings = lazy(
  () => import('./pages/admin/AdminOrderSettings')
);

const AdminDeliverySettings = lazy(
  () => import('./pages/admin/AdminDeliverySettings')
);

const AdminFeesSettings = lazy(
  () => import('./pages/admin/AdminFeesSettings')
);

const AdminPromotionSettings = lazy(
  () => import('./pages/admin/AdminPromotionSettings')
);

const AdminReceiptSettings = lazy(
  () => import('./pages/admin/AdminReceiptSettings')
);

const AdminSecuritySettings = lazy(
  () => import('./pages/admin/AdminSecuritySettings')
);

const AdminDataReset = lazy(
  () => import('./pages/admin/AdminDataReset')
);

const AdminFinance = lazy(
  () => import('./pages/admin/AdminFinance')
);

const AdminSales = lazy(
  () => import('./pages/admin/AdminSales')
);

const AdminOffers = lazy(
  () => import('./pages/admin/AdminOffers')
);

const AdminFeedback = lazy(
  () => import('./pages/admin/AdminFeedback')
);

// Kitchen page with Live Orders, Today, Yesterday and Menu
const KitchenShell = lazy(
  () => import('./pages/admin/KitchenShell')
);

const AdminLanguages = lazy(
  () => import('./pages/admin/AdminLanguages')
);

const AdminDeals = lazy(
  () => import('./pages/admin/AdminDeals')
);

const AdminNotifications = lazy(
  () => import('./pages/admin/AdminNotifications')
);

const AdminActivityLogs = lazy(
  () => import('./pages/admin/AdminActivityLogs')
);

const AdminAccounts = lazy(
  () => import('./pages/admin/AdminAccounts')
);

const AdminRiders = lazy(
  () => import('./pages/admin/AdminRiders')
);

const AdminRewardsSettings = lazy(
  () => import('./pages/admin/AdminRewardsSettings')
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60000,
      gcTime: 300000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function PageLoader() {
  // Keep route/auth loading visually neutral so the customer sees only the
  // single approved welcome artwork owned by pages/Index.tsx.
  return <div className="min-h-screen bg-gray-950" aria-busy="true" />;
}

interface ProtectedCustomerRouteProps {
  children: ReactElement;
}

function ProtectedCustomerRoute({
  children,
}: ProtectedCustomerRouteProps) {
  const {
    isLoggedIn,
    loading,
  } = useCustomerAuth();
  const location = useLocation();

  if (loading) {
    return <PageLoader />;
  }

  if (!isLoggedIn) {
    const requestedPath = `${location.pathname}${location.search}${location.hash}`;
    const next = encodeURIComponent(requestedPath);

    return (
      <Navigate
        to={`/account?next=${next}`}
        replace
      />
    );
  }

  return children;
}

const AppRoutes = () => (
  <Suspense fallback={<PageLoader />}>
    <Routes>
      <Route
        path="/account"
        element={<CustomerAuth />}
      />

      {/* Apple 5.1.1(v): browsing must not require an account. */}
      <Route path="/" element={<Index />} />
      <Route path="/menu" element={<Menu />} />
      <Route path="/support" element={<Support />} />

      {/* Cart is browsing/pre-checkout; login is required only when checkout starts. */}
      <Route path="/cart" element={<Cart />} />

      <Route
        path="/checkout"
        element={
          <ProtectedCustomerRoute>
            <Checkout />
          </ProtectedCustomerRoute>
        }
      />

      <Route
        path="/order-confirmation"
        element={
          <ProtectedCustomerRoute>
            <OrderConfirmation />
          </ProtectedCustomerRoute>
        }
      />

      <Route
        path="/rewards"
        element={
          <ProtectedCustomerRoute>
            <Rewards />
          </ProtectedCustomerRoute>
        }
      />

      <Route
        path="/my-orders"
        element={
          <ProtectedCustomerRoute>
            <MyOrders />
          </ProtectedCustomerRoute>
        }
      />

      <Route
        path="/contact"
        element={
          <ProtectedCustomerRoute>
            <Contact />
          </ProtectedCustomerRoute>
        }
      />

      <Route
        path="/deals"
        element={
          <ProtectedCustomerRoute>
            <Deals />
          </ProtectedCustomerRoute>
        }
      />

      <Route
        path="/feedback"
        element={
          <ProtectedCustomerRoute>
            <Feedback />
          </ProtectedCustomerRoute>
        }
      />

      <Route
        path="/reviews"
        element={
          <ProtectedCustomerRoute>
            <Reviews />
          </ProtectedCustomerRoute>
        }
      />

      <Route
        path="/blog/*"
        element={
          <ProtectedCustomerRoute>
            <BlogRoutes />
          </ProtectedCustomerRoute>
        }
      />

      <Route
        path="/rider"
        element={<RiderPanel />}
      />

      <Route
        path="/track/:orderId"
        element={<DeliveryTracking />}
      />

      <Route
        path="/admin"
        element={<AdminLogin />}
      />

      <Route
        path="/admin/dashboard"
        element={<AdminDashboard />}
      />

      <Route
        path="/admin/orders"
        element={<AdminOrders />}
      />

      <Route
        path="/admin/menu"
        element={<AdminMenu />}
      />

      <Route
        path="/admin/customers"
        element={<AdminCustomers />}
      />

      <Route
        path="/admin/settings"
        element={<AdminSettings />}
      />

      <Route
        path="/admin/settings/brand"
        element={<AdminBrandSettings />}
      />

      <Route
        path="/admin/settings/restaurant"
        element={<AdminRestaurantSettings />}
      />

      <Route
        path="/admin/settings/branches"
        element={<AdminBranches />}
      />

      <Route
        path="/admin/settings/homepage"
        element={<AdminHomepageSettings />}
      />

      <Route
        path="/admin/settings/checkout"
        element={<AdminCheckoutSettings />}
      />

      <Route
        path="/admin/settings/orders"
        element={<AdminOrderSettings />}
      />

      <Route
        path="/admin/settings/delivery"
        element={<AdminDeliverySettings />}
      />

      <Route
        path="/admin/settings/fees"
        element={<AdminFeesSettings />}
      />

      <Route
        path="/admin/settings/promotions"
        element={<AdminPromotionSettings />}
      />

      <Route
        path="/admin/settings/receipt"
        element={<AdminReceiptSettings />}
      />

      <Route
        path="/admin/settings/rewards"
        element={<AdminRewardsSettings />}
      />

      <Route
        path="/admin/settings/security"
        element={<AdminSecuritySettings />}
      />

      <Route
        path="/admin/settings/data-reset"
        element={<AdminDataReset />}
      />

      <Route
        path="/admin/finance"
        element={<AdminFinance />}
      />

      <Route
        path="/admin/sales"
        element={<AdminSales />}
      />

      <Route
        path="/admin/offers"
        element={<AdminOffers />}
      />

      <Route
        path="/admin/feedback"
        element={<AdminFeedback />}
      />

      <Route
        path="/admin/languages"
        element={<AdminLanguages />}
      />

      <Route
        path="/admin/deals"
        element={<AdminDeals />}
      />

      <Route
        path="/admin/notifications"
        element={<AdminNotifications />}
      />

      <Route
        path="/admin/activity-logs"
        element={<AdminActivityLogs />}
      />

      <Route
        path="/admin/accounts"
        element={<AdminAccounts />}
      />

      <Route
        path="/admin/riders"
        element={<AdminRiders />}
      />

      <Route
        path="/kitchen"
        element={<KitchenShell />}
      />

    </Routes>
  </Suspense>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <I18nProvider>
      <TooltipProvider>
        <Toaster />
        <LanguagePickerModal />

        <BrowserRouter>
          <CustomerAuthProvider>
            <BranchProvider>
              <CustomerHeartbeatProvider>
                <AppRoutes />
              </CustomerHeartbeatProvider>
            </BranchProvider>
          </CustomerAuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </I18nProvider>
  </QueryClientProvider>
);

export default App;
export { AppRoutes };
