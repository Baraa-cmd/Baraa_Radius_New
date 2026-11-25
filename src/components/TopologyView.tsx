import React from 'react';
import { Network, Radio, Router, Server } from 'lucide-react';
import type { RfRadioDevice, RouterDevice, TowerNode } from '../types';

interface Props {
  router: RouterDevice;
  rfRadios: RfRadioDevice[];
  towers: TowerNode[];
}

export const TopologyView: React.FC<Props> = ({ router, rfRadios, towers }) => {
  const wanPorts = router.ports.filter((p) => p.role === 'WAN' || p.role === 'ISP');
  const distPorts = router.ports.filter(
    (p) => p.status === 'up' && p.role !== 'WAN' && p.role !== 'ISP'
  );
  const linkedRadios = rfRadios.filter((r) => r.routerId === router.id);

  return (
    <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network className="w-5 h-5 text-sky-500" />
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              خريطة التوبولوجي الحية (Live Network Topology)
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              ربط خطوط الـ WAN والمنافذ النشطة والأجهزة المجاورة MNDP والسكترات المتصلة بالراوتر
            </p>
          </div>
        </div>
        <div className="text-xs font-mono text-slate-500" dir="ltr">
          {router.neighbors.length} MNDP · {linkedRadios.length} RF · {towers.length} Towers
        </div>
      </div>

      {/* 3-Tier Visual Tree Diagram */}
      <div className="space-y-6">
        {/* Tier 1: Upstream WAN / ISP */}
        <div className="flex flex-wrap justify-center gap-3">
          {wanPorts.length > 0 ? (
            wanPorts.map((p) => (
              <div
                key={p.id}
                className={`min-w-[160px] rounded-2xl border px-3.5 py-2.5 text-center text-xs ${
                  p.status === 'up'
                    ? 'border-emerald-500/40 bg-emerald-500/10'
                    : 'border-red-500/40 bg-red-500/10'
                }`}
              >
                <div className="font-bold text-slate-900 dark:text-white">{p.label}</div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5" dir="ltr">
                  {p.role} · {p.speed} · ↓{p.rxMbps}M ↑{p.txMbps}M
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-300 dark:border-white/[0.15] px-4 py-2 text-xs text-slate-400">
              لم يتم تعيين منافذ WAN / ISP (عيّنها من تبويب المنافذ)
            </div>
          )}
        </div>

        {/* Connector Line */}
        <div className="flex justify-center">
          <div className="w-0.5 h-6 bg-sky-500/40" />
        </div>

        {/* Tier 2: Core MikroTik Router */}
        <div className="flex justify-center">
          <div className="rounded-2xl bg-gradient-to-br from-sky-600 to-teal-600 text-white px-6 py-4 shadow-lg shadow-sky-900/25 flex items-center gap-3">
            <Router className="w-6 h-6 shrink-0" />
            <div>
              <div className="font-extrabold text-sm">{router.identity || router.name}</div>
              <div className="text-[11px] font-mono opacity-90" dir="ltr">
                {router.model || 'MikroTik'} · CPU {router.cpuPercent ?? 0}% · PPPoE {router.pppoeOnline}
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-center">
          <div className="w-0.5 h-6 bg-sky-500/40" />
        </div>

        {/* Tier 3: Downlink Ports, MNDP Neighbors & RF Sectors */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Active Downlinks */}
          <div className="rounded-2xl bg-slate-50 dark:bg-[#171C28] p-3.5 space-y-2 border border-slate-200/70 dark:border-white/[0.06]">
            <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-sky-500" />
              <span>منافذ التوزيع النشطة ({distPorts.length})</span>
            </div>
            {distPorts.slice(0, 8).map((p) => (
              <div key={p.id} className="flex items-center justify-between text-[11px] py-1 border-b border-slate-200/50 dark:border-white/[0.04] last:border-0">
                <span className="font-bold text-slate-800 dark:text-slate-200 truncate">{p.label}</span>
                <span className="font-mono text-slate-500" dir="ltr">
                  {p.speed} · {p.rxMbps}M
                </span>
              </div>
            ))}
          </div>

          {/* MNDP Neighbors */}
          <div className="rounded-2xl bg-slate-50 dark:bg-[#171C28] p-3.5 space-y-2 border border-slate-200/70 dark:border-white/[0.06]">
            <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
              <Network className="w-3.5 h-3.5 text-emerald-500" />
              <span>الأجهزة المجاورة MNDP ({router.neighbors.length})</span>
            </div>
            {router.neighbors.length === 0 ? (
              <div className="text-[11px] text-slate-400">لا توجد جيران MNDP مكتشفين حالياً</div>
            ) : (
              router.neighbors.slice(0, 8).map((n) => (
                <div key={n.id} className="text-[11px] py-1 border-b border-slate-200/50 dark:border-white/[0.04] last:border-0">
                  <div className="font-bold text-slate-800 dark:text-slate-200 truncate">{n.identity}</div>
                  <div className="font-mono text-slate-400" dir="ltr">
                    {n.interfaceName} · {n.ip || n.mac}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Linked RF Radios */}
          <div className="rounded-2xl bg-slate-50 dark:bg-[#171C28] p-3.5 space-y-2 border border-slate-200/70 dark:border-white/[0.06]">
            <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-amber-500" />
              <span>السكترات المرتبطة ({linkedRadios.length})</span>
            </div>
            {linkedRadios.length === 0 ? (
              <div className="text-[11px] text-slate-400">
                اربط السكترات بهذا الراوتر من صفحة الترددات والراديوهات
              </div>
            ) : (
              linkedRadios.map((rad) => (
                <div key={rad.id} className="text-[11px] py-1 border-b border-slate-200/50 dark:border-white/[0.04] last:border-0">
                  <div className="flex justify-between font-bold">
                    <span className="text-slate-800 dark:text-slate-200 truncate">{rad.name}</span>
                    <span className="font-mono text-emerald-500" dir="ltr">
                      {rad.frequencyMhz ? `${rad.frequencyMhz}M` : ''}
                    </span>
                  </div>
                  <div className="font-mono text-slate-400" dir="ltr">
                    CCQ {rad.ccqPct ?? '—'}% · {rad.clients.length} stations
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
