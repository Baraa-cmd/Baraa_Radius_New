import React, { useState } from 'react';
import { Download, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className={`inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold transition-colors whitespace-nowrap shrink-0 min-h-[44px] ${
          compact ? 'px-3 py-2 text-xs' : 'px-4 py-2.5 text-sm w-full'
        }`}
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>تثبيت كتطبيق</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className={`inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-slate-800 dark:text-slate-100 font-semibold transition-colors whitespace-nowrap shrink-0 min-h-[44px] ${
            compact ? 'px-3 py-2 text-xs' : 'px-4 py-2.5 text-sm w-full'
          }`}
        >
          <Smartphone className="w-4 h-4 shrink-0 text-sky-500" />
          <span>تثبيت على آيفون</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">تثبيت Bro Radius على iOS</h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                  aria-label="إغلاق"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <ol className="space-y-3 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                <li>1. اضغط على زر <strong>المشاركة (Share)</strong> في شريط متصفح Safari.</li>
                <li>2. مرّر للأسفل واختر <strong>إضافة إلى الشاشة الرئيسية (Add to Home Screen)</strong>.</li>
                <li>3. اضغط <strong>إضافة</strong> ليظهر كتطبيق مستقل على هاتفك.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full min-h-[44px] rounded-xl bg-sky-600 text-white font-semibold text-sm hover:bg-sky-500 transition-colors"
              >
                فهمت
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-20 lg:bottom-6 left-4 right-4 lg:right-auto lg:w-80 z-50 flex items-center gap-3 rounded-2xl bg-amber-600 text-white px-4 py-3 text-xs font-semibold shadow-lg">
      <WifiOff className="w-4 h-4 shrink-0" />
      <span>أنت غير متصل بالإنترنت — يتم عرض البيانات المخزنة مؤقتاً</span>
    </div>
  );
};
