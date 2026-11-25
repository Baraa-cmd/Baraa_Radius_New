import React from 'react';

interface BroLogoProps {
  size?: 'sm' | 'md' | 'lg';
}

export const BroLogo: React.FC<BroLogoProps> = ({ size = 'md' }) => {
  const dims =
    size === 'lg' ? 'w-20 h-20 rounded-3xl' : size === 'sm' ? 'w-9 h-9 rounded-xl' : 'w-11 h-11 rounded-2xl';

  return (
    <div
      className={`${dims} bg-gradient-to-br from-sky-500 to-teal-500 flex items-center justify-center shadow-lg shadow-sky-900/25 shrink-0`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" className="w-3/5 h-3/5">
        <rect x="10" y="38" width="8" height="14" rx="4" fill="#FFFFFF" />
        <rect x="22" y="30" width="8" height="22" rx="4" fill="#FFFFFF" />
        <rect x="34" y="21" width="8" height="31" rx="4" fill="#FFFFFF" />
        <rect x="46" y="16" width="8" height="36" rx="4" fill="#FFFFFF" />
        <circle cx="50" cy="10" r="4" fill="#BAE6FD" />
      </svg>
    </div>
  );
};
