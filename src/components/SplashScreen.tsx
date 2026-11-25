import React, { useEffect, useState } from 'react';
import { BroLogo } from './BroLogo';

interface Props {
  onFinished: () => void;
}

export const SplashScreen: React.FC<Props> = ({ onFinished }) => {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFading(true);
      const doneTimer = window.setTimeout(() => {
        onFinished();
      }, 600);
      return () => window.clearTimeout(doneTimer);
    }, 2400);

    return () => window.clearTimeout(timer);
  }, [onFinished]);

  return (
    <div
      className={`fixed inset-0 z-[9999] bg-[#070B14] flex flex-col items-center justify-center transition-opacity duration-600 ${
        fading ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      {/* Ambient background glows */}
      <div className="absolute w-[500px] h-[500px] rounded-full bg-sky-500/10 blur-[120px] animate-pulse" />
      <div className="absolute w-[350px] h-[350px] rounded-full bg-teal-500/10 blur-[100px] animate-ping opacity-30" />

      <div className="relative z-10 flex flex-col items-center space-y-6 text-center px-4">
        {/* Animated Rotating Rings & Glowing Logo */}
        <div className="relative w-28 h-28 flex items-center justify-center">
          <div className="absolute inset-0 rounded-full border-2 border-dashed border-sky-400/40 animate-[spin_8s_linear_infinite]" />
          <div className="absolute -inset-2 rounded-full border border-teal-400/30 animate-[spin_12s_linear_infinite_reverse]" />
          <div className="p-3 rounded-[32px] bg-gradient-to-br from-sky-500/20 to-teal-500/20 backdrop-blur-xl border border-white/20 shadow-2xl animate-[bounce_2s_ease-in-out_infinite]">
            <BroLogo size="lg" />
          </div>
        </div>

        <div className="space-y-2 animate-[fade-in_1s_ease-out]">
          <h1 className="text-3xl sm:text-4xl font-black tracking-wider text-white" dir="ltr">
            Bro Radius
          </h1>
          <p className="text-xs sm:text-sm font-medium text-sky-200/80 tracking-wide">
            منصة إدارة وتوجيه راوترات MikroTik والمشتركين الذكية
          </p>
        </div>

        {/* Loading Progress Bar */}
        <div className="w-48 h-1.5 bg-white/10 rounded-full overflow-hidden mt-4">
          <div className="h-full bg-gradient-to-r from-sky-400 to-teal-400 rounded-full animate-[w-full_2.2s_ease-in-out_forwards]" style={{ width: '100%' }} />
        </div>
      </div>
    </div>
  );
};
