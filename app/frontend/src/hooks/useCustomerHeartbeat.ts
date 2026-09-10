import { useEffect, useRef } from 'react';
import { client } from '@/lib/api';
import { customerAuthApi } from '@/lib/customer-auth';

/** Keep customer presence fresh without blocking app navigation. */
export function useCustomerHeartbeat() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    function getSessionId(): string {
      let sessionId = localStorage.getItem('vita_session_id');
      if (!sessionId) {
        sessionId = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        localStorage.setItem('vita_session_id', sessionId);
      }
      return sessionId;
    }

    async function sendHeartbeat() {
      if (cancelled) return;

      const sessionId = getSessionId();
      const savedName = localStorage.getItem('vita_customer_name') || localStorage.getItem('customer_name') || '';
      const savedPhone = localStorage.getItem('vita_customer_phone') || localStorage.getItem('customer_phone') || '';

      // Guest presence is best-effort and must never block customer use.
      void client.apiCall.invoke({
        url: '/api/v1/admin/guest-heartbeat',
        method: 'POST',
        data: {
          session_id: sessionId,
          customer_name: savedName || 'Guest',
          customer_phone: savedPhone || '',
        },
      }).catch(() => undefined);

      const user = customerAuthApi.getSavedCustomer();
      if (!user || cancelled) return;

      void client.apiCall.invoke({
        url: '/api/v1/admin/customer-heartbeat',
        method: 'POST',
        data: {
          customer_name: user.name || savedName || 'Customer',
          customer_email: user.email || user.customer_email || '',
          customer_phone: user.phone || savedPhone || '',
        },
      }).catch(() => undefined);
    }

    const syncNow = () => {
      if (!cancelled && document.visibilityState !== 'hidden') void sendHeartbeat();
    };

    // Send immediately so Admin does not show a just-opened customer as Offline.
    syncNow();
    intervalRef.current = setInterval(syncNow, 25000);

    const onVisibility = () => { if (document.visibilityState === 'visible') syncNow(); };
    window.addEventListener('focus', syncNow);
    window.addEventListener('pageshow', syncNow);
    window.addEventListener('customer-auth-changed', syncNow);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      window.removeEventListener('focus', syncNow);
      window.removeEventListener('pageshow', syncNow);
      window.removeEventListener('customer-auth-changed', syncNow);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
