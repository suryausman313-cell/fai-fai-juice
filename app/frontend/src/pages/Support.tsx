import { ArrowLeft, Clock3, MapPin, MessageCircle, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';

const SUPPORT_PHONE_DISPLAY = '+971 54 294 0112';
const SUPPORT_PHONE_TEL = '+971542940112';
const SUPPORT_WHATSAPP = 'https://wa.me/971542940112';

export default function Support() {
  return (
    <div className="min-h-screen bg-black px-4 py-8 text-white">
      <div className="mx-auto w-full max-w-xl">
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-gray-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Fai Fai Juice
        </Link>

        <div className="rounded-3xl border border-gray-800 bg-gray-950 p-6 sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-red-500">
            Fai Fai Juice
          </p>
          <h1 className="mt-2 text-3xl font-black">Customer Support</h1>
          <p className="mt-3 text-sm leading-6 text-gray-400">
            Need help with an order, payment, delivery, account, rewards, or the app? Contact our support team using the options below.
          </p>

          <div className="mt-7 space-y-3">
            <a
              href={`tel:${SUPPORT_PHONE_TEL}`}
              className="flex items-center gap-4 rounded-2xl border border-gray-800 bg-gray-900 p-4 transition hover:border-red-700"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-600/15 text-red-500">
                <Phone className="h-5 w-5" />
              </div>
              <div>
                <p className="font-bold">Call Support</p>
                <p className="mt-0.5 text-sm text-gray-400">{SUPPORT_PHONE_DISPLAY}</p>
              </div>
            </a>

            <a
              href={SUPPORT_WHATSAPP}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-4 rounded-2xl border border-gray-800 bg-gray-900 p-4 transition hover:border-green-700"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-green-600/15 text-green-500">
                <MessageCircle className="h-5 w-5" />
              </div>
              <div>
                <p className="font-bold">WhatsApp Support</p>
                <p className="mt-0.5 text-sm text-gray-400">Send us a message for help or questions.</p>
              </div>
            </a>
          </div>

          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-gray-800 bg-black/40 p-4">
              <div className="flex items-center gap-2 text-gray-300">
                <Clock3 className="h-4 w-4 text-red-500" />
                <span className="font-semibold">Support hours</span>
              </div>
              <p className="mt-2 text-sm text-gray-400">Daily, 3:00 PM - 2:00 AM</p>
            </div>

            <div className="rounded-2xl border border-gray-800 bg-black/40 p-4">
              <div className="flex items-center gap-2 text-gray-300">
                <MapPin className="h-4 w-4 text-red-500" />
                <span className="font-semibold">Location</span>
              </div>
              <p className="mt-2 text-sm text-gray-400">Murbah, Fujairah, UAE</p>
            </div>
          </div>

          <p className="mt-7 text-xs leading-5 text-gray-500">
            For faster help, please include your order number when contacting us about an existing order.
          </p>
        </div>
      </div>
    </div>
  );
}
