import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Crosshair,
  Flame,
  Layers,
  LocateFixed,
  MapPin,
  Minus,
  Navigation,
  Network,
  Phone,
  Plus,
  Radio,
  Ruler,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { SubscriberBillingStatus, SubscriberRecord, TowerNode } from '../types';

interface SubscribersMapViewProps {
  subscribers: SubscriberRecord[];
  towers: TowerNode[];
  focusedSubId: string | null;
  onClearFocused: () => void;
  onUpdateSubscriber: (subId: string, patch: Partial<SubscriberRecord>) => Promise<void>;
  onAddTower: (tower: Omit<TowerNode, 'id' | 'ownerId'>) => Promise<void>;
  onDeleteTower: (towerId: string) => Promise<void>;
}

const PIN_STYLES: Record<SubscriberBillingStatus, { fill: string; label: string }> = {
  active: { fill: '#10B981', label: 'نشط' },
  expiring: { fill: '#F59E0B', label: 'ينتهي قريباً' },
  expired: { fill: '#64748B', label: 'منتهي' },
  debtor: { fill: '#EF4444', label: 'مدين' },
};

const TILE_LAYERS = {
  streets: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};

function computeSectorPolygon(
  lat: number,
  lng: number,
  azimuthDeg: number,
  beamwidthDeg: number,
  radiusMeters: number
): Array<[number, number]> {
  const pts: Array<[number, number]> = [[lat, lng]];
  const R = 6371000;
  const start = azimuthDeg - beamwidthDeg / 2;
  const steps = 16;
  const latRad = (lat * Math.PI) / 180;

  for (let i = 0; i <= steps; i++) {
    const bearing = ((start + (beamwidthDeg * i) / steps) * Math.PI) / 180;
    const dLat = (radiusMeters / R) * Math.cos(bearing);
    const dLng = (radiusMeters / (R * Math.cos(latRad))) * Math.sin(bearing);
    pts.push([lat + (dLat * 180) / Math.PI, lng + (dLng * 180) / Math.PI]);
  }
  return pts;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const f1 = (lat1 * Math.PI) / 180;
  const f2 = (lat2 * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const SubscribersMapView: React.FC<SubscribersMapViewProps> = ({
  subscribers,
  towers,
  focusedSubId,
  onClearFocused,
  onUpdateSubscriber,
  onAddTower,
  onDeleteTower,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const overlayLayerRef = useRef<L.LayerGroup | null>(null);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SubscriberBillingStatus>('all');
  const [mapStyle, setMapStyle] = useState<'streets' | 'satellite' | 'dark'>('streets');
  const [clustered, setClustered] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showTowerModal, setShowTowerModal] = useState(false);
  const [showFresnelModal, setShowFresnelModal] = useState(false);
  const [fresnelTowerId, setFresnelTowerId] = useState('');
  const [fresnelSubId, setFresnelSubId] = useState('');
  const [fresnelFreqGhz, setFresnelFreqGhz] = useState('5.8');
  const [fresnelTowerMastM, setFresnelTowerMastM] = useState('18');
  const [fresnelCpeMastM, setFresnelCpeMastM] = useState('8');

  const [towerName, setTowerName] = useState('');
  const [towerLat, setTowerLat] = useState('33.3260');
  const [towerLng, setTowerLng] = useState('44.3650');
  const [towerAzimuth, setTowerAzimuth] = useState('45');
  const [towerBeam, setTowerBeam] = useState('120');
  const [towerRadius, setTowerRadius] = useState('1500');

  const [selectedSubId, setSelectedSubId] = useState<string | null>(focusedSubId);
  const [pickingLocationForId, setPickingLocationForId] = useState<string | null>(null);
  const pickingRef = useRef<string | null>(null);

  useEffect(() => {
    pickingRef.current = pickingLocationForId;
  }, [pickingLocationForId]);

  const geoSubscribers = useMemo(
    () => subscribers.filter((s) => s.lat !== null && s.lng !== null),
    [subscribers]
  );

  const unlocatedSubs = useMemo(
    () => subscribers.filter((s) => s.lat === null || s.lng === null),
    [subscribers]
  );

  const counts = useMemo(
    () => ({
      all: geoSubscribers.length,
      debtor: geoSubscribers.filter((s) => s.billingStatus === 'debtor').length,
      expired: geoSubscribers.filter((s) => s.billingStatus === 'expired').length,
      expiring: geoSubscribers.filter((s) => s.billingStatus === 'expiring').length,
      active: geoSubscribers.filter((s) => s.billingStatus === 'active').length,
    }),
    [geoSubscribers]
  );

  const visibleSubs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return geoSubscribers.filter((s) => {
      if (statusFilter !== 'all' && s.billingStatus !== statusFilter) return false;
      if (!q) return true;
      return (
        s.fullName.toLowerCase().includes(q) ||
        s.username.toLowerCase().includes(q) ||
        s.area.toLowerCase().includes(q) ||
        s.phone.includes(q)
      );
    });
  }, [geoSubscribers, query, statusFilter]);

  const activeSub =
    subscribers.find((s) => s.id === (selectedSubId || focusedSubId)) || null;

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [33.326, 44.365],
      zoom: 12,
      zoomControl: false,
      attributionControl: true,
    });

    const layer = L.tileLayer(TILE_LAYERS[mapStyle], {
      maxZoom: 19,
      attribution: 'Esri / OSM',
    }).addTo(map);

    const overlayGroup = L.layerGroup().addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      const targetId = pickingRef.current;
      if (!targetId) return;
      void onUpdateSubscriber(targetId, {
        lat: Number(e.latlng.lat.toFixed(6)),
        lng: Number(e.latlng.lng.toFixed(6)),
      });
      setSelectedSubId(targetId);
      setPickingLocationForId(null);
    });

    mapRef.current = map;
    tileLayerRef.current = layer;
    overlayLayerRef.current = overlayGroup;

    return () => {
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      overlayLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }
    tileLayerRef.current = L.tileLayer(TILE_LAYERS[mapStyle], {
      maxZoom: 19,
      attribution: 'Esri / OSM',
    }).addTo(map);
  }, [mapStyle]);

  useEffect(() => {
    if (!focusedSubId || !mapRef.current) return;
    const sub = subscribers.find((s) => s.id === focusedSubId);
    if (sub && sub.lat !== null && sub.lng !== null) {
      setSelectedSubId(sub.id);
      mapRef.current.setView([sub.lat, sub.lng], 15, { animate: true });
    } else if (sub) {
      setPickingLocationForId(sub.id);
    }
  }, [focusedSubId, subscribers]);

  // Render Towers, Sectors (#62), Line-of-Sight (#64), Heatmap (#67), Pins/Clusters (#65,#66)
  useEffect(() => {
    const group = overlayLayerRef.current;
    const map = mapRef.current;
    if (!group || !map) return;
    group.clearLayers();

    const towerMap = new Map(towers.map((t) => [t.id, t]));

    // Draw Towers + Sector Coverage Wedges (#62)
    towers.forEach((tower) => {
      const wedge = computeSectorPolygon(
        tower.lat,
        tower.lng,
        tower.azimuthDeg,
        tower.beamwidthDeg,
        tower.radiusMeters
      );
      L.polygon(wedge, {
        color: '#0EA5E9',
        weight: 1.5,
        fillColor: '#0EA5E9',
        fillOpacity: 0.14,
      }).addTo(group);

      const health = typeof tower.healthScore === 'number' ? tower.healthScore : null;
      const healthBadge =
        health !== null
          ? `<span style="margin-right:4px;color:${health >= 80 ? '#10B981' : health >= 50 ? '#F59E0B' : '#EF4444'}">${health}%</span>`
          : '';
      const towerIcon = L.divIcon({
        className: 'bro-tower-icon',
        html: `<div style="padding:4px 8px;border-radius:10px;background:#0F172A;color:#38BDF8;border:2px solid #0EA5E9;font-size:11px;font-weight:800;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.4);">📡 ${tower.name} ${healthBadge}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      L.marker([tower.lat, tower.lng], { icon: towerIcon }).addTo(group);
    });

    if (showHeatmap) {
      visibleSubs.forEach((sub) => {
        if (sub.lat === null || sub.lng === null) return;
        L.circle([sub.lat, sub.lng], {
          radius: 420,
          stroke: false,
          fillColor: sub.billingStatus === 'debtor' ? '#EF4444' : '#0EA5E9',
          fillOpacity: 0.22,
        }).addTo(group);
      });
    }

    if (clustered && visibleSubs.length > 0) {
      const buckets = new Map<string, { latSum: number; lngSum: number; count: number }>();
      visibleSubs.forEach((s) => {
        if (s.lat === null || s.lng === null) return;
        const key = `${Math.round(s.lat * 20)}:${Math.round(s.lng * 20)}`;
        const cur = buckets.get(key) || { latSum: 0, lngSum: 0, count: 0 };
        cur.latSum += s.lat;
        cur.lngSum += s.lng;
        cur.count += 1;
        buckets.set(key, cur);
      });
      buckets.forEach((b) => {
        const cLat = b.latSum / b.count;
        const cLng = b.lngSum / b.count;
        const icon = L.divIcon({
          className: 'bro-pin-icon',
          html: `<div style="width:46px;height:46px;border-radius:9999px;background:#0284C7;border:3px solid #fff;box-shadow:0 6px 18px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-family:'JetBrains Mono',monospace;font-size:14px;">${b.count}</div>`,
          iconSize: [46, 46],
          iconAnchor: [23, 23],
        });
        const m = L.marker([cLat, cLng], { icon }).addTo(group);
        m.on('click', () => {
          setClustered(false);
          map.setView([cLat, cLng], 14, { animate: true });
        });
      });
      return;
    }

    visibleSubs.forEach((sub) => {
      if (sub.lat === null || sub.lng === null) return;

      // Line of Sight link to Tower (#64)
      if (sub.towerId && towerMap.has(sub.towerId)) {
        const twr = towerMap.get(sub.towerId)!;
        L.polyline(
          [
            [twr.lat, twr.lng],
            [sub.lat, sub.lng],
          ],
          {
            color: sub.online ? '#10B981' : '#EF4444',
            weight: 1.5,
            dashArray: '5 5',
            opacity: 0.75,
          }
        ).addTo(group);
      }

      const pin = PIN_STYLES[sub.billingStatus];
      const isSelected = activeSub?.id === sub.id;
      const ring = isSelected
        ? `box-shadow:0 0 0 6px ${pin.fill}44, 0 4px 12px rgba(0,0,0,0.4);`
        : 'box-shadow:0 4px 12px rgba(0,0,0,0.35);';
      const dotColor = sub.online ? pin.fill : '#475569';
      const icon = L.divIcon({
        className: 'bro-pin-icon',
        html: `
          <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-50%);">
            <div style="background:rgba(17,21,30,0.9);color:#fff;padding:2px 7px;border-radius:8px;font-size:11px;font-weight:700;white-space:nowrap;margin-bottom:4px;border:1px solid ${pin.fill};">${sub.username}</div>
            <div style="width:18px;height:18px;border-radius:9999px;background:${dotColor};border:3px solid #fff;${ring}"></div>
          </div>
        `,
        iconSize: [24, 36],
        iconAnchor: [0, 0],
      });

      const marker = L.marker([sub.lat, sub.lng], { icon }).addTo(group);
      marker.on('click', () => {
        if (pickingRef.current) return;
        setSelectedSubId(sub.id);
      });
    });
  }, [visibleSubs, towers, clustered, showHeatmap, activeSub?.id]);

  const captureGps = (onCoords: (lat: number, lng: number) => void) => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = Number(pos.coords.latitude.toFixed(6));
      const lng = Number(pos.coords.longitude.toFixed(6));
      onCoords(lat, lng);
      mapRef.current?.setView([lat, lng], 15, { animate: true });
    });
  };

  const resetView = () => {
    onClearFocused();
    setSelectedSubId(null);
    if (towers[0]) {
      mapRef.current?.setView([towers[0].lat, towers[0].lng], 13, { animate: true });
    } else {
      mapRef.current?.setView([33.326, 44.365], 12, { animate: true });
    }
  };

  const handleSaveTower = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!towerName.trim()) return;
    await onAddTower({
      name: towerName.trim(),
      lat: Number(towerLat) || 33.326,
      lng: Number(towerLng) || 44.365,
      azimuthDeg: Number(towerAzimuth) || 0,
      beamwidthDeg: Number(towerBeam) || 120,
      radiusMeters: Number(towerRadius) || 1500,
    });
    setTowerName('');
    setShowTowerModal(false);
  };

  return (
    <div className="space-y-4">
      <div className="relative h-[74vh] min-h-[520px] rounded-[26px] overflow-hidden border border-slate-200/80 dark:border-white/[0.08] shadow-xl">
        <div
          ref={mapContainerRef}
          className={`w-full h-full z-0 ${pickingLocationForId ? 'cursor-crosshair' : ''}`}
        />

        {/* Floating Top Controls */}
        <div className="absolute top-3 left-3 right-3 z-[400] space-y-2.5 pointer-events-none">
          <div className="flex items-center gap-2 max-w-2xl mx-auto pointer-events-auto">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ابحث عن مشترك، رقم أو منطقة"
                className="w-full min-h-[46px] rounded-2xl border border-slate-200/90 dark:border-white/[0.1] bg-white/95 dark:bg-[#11151E]/95 backdrop-blur-md pr-11 pl-4 text-sm text-slate-900 dark:text-white shadow-lg focus:outline-none focus:border-sky-500"
              />
            </div>

            <button
              type="button"
              onClick={() => {
                if (!fresnelTowerId && towers[0]) setFresnelTowerId(towers[0].id);
                if (!fresnelSubId && geoSubscribers[0]) setFresnelSubId(geoSubscribers[0].id);
                setShowFresnelModal(true);
              }}
              className="min-h-[46px] px-3.5 rounded-2xl bg-white/95 dark:bg-[#11151E]/95 border border-slate-200/90 dark:border-white/[0.1] text-slate-800 dark:text-slate-100 text-xs font-bold shadow-lg inline-flex items-center gap-1.5 whitespace-nowrap"
              title="حساب خط النظر ومنطقة فرينل LoS / Fresnel"
            >
              <Ruler className="w-4 h-4 text-teal-500" />
              <span className="hidden sm:inline">خط النظر LoS</span>
            </button>

            <button
              type="button"
              onClick={() => setShowTowerModal(true)}
              className="min-h-[46px] px-3.5 rounded-2xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold shadow-lg inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Radio className="w-4 h-4" />
              <span>الأبراج ({towers.length})</span>
            </button>
          </div>

          <div className="flex items-center justify-center gap-2 overflow-x-auto no-scrollbar pb-1 pointer-events-auto">
            {[
              { id: 'all' as const, label: `الكل ${counts.all}`, dot: '#0EA5E9' },
              { id: 'debtor' as const, label: `مدينون ${counts.debtor}`, dot: '#EF4444' },
              { id: 'expired' as const, label: `منتهون ${counts.expired}`, dot: '#64748B' },
              { id: 'expiring' as const, label: `ينتهي قريباً ${counts.expiring}`, dot: '#F59E0B' },
              { id: 'active' as const, label: `نشطون ${counts.active}`, dot: '#10B981' },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`min-h-[36px] px-3.5 rounded-full text-xs font-bold whitespace-nowrap shrink-0 border shadow-md inline-flex items-center gap-2 transition-colors ${
                  statusFilter === f.id
                    ? 'bg-sky-600 border-sky-600 text-white'
                    : 'bg-white/95 dark:bg-[#11151E]/95 border-slate-200/90 dark:border-white/[0.1] text-slate-800 dark:text-slate-200'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: statusFilter === f.id ? '#FFFFFF' : f.dot }}
                />
                <span>{f.label}</span>
              </button>
            ))}
          </div>

          {pickingLocationForId && (
            <div className="max-w-md mx-auto rounded-2xl bg-sky-600 text-white px-4 py-2.5 flex items-center justify-between gap-2 text-xs font-bold shadow-lg pointer-events-auto">
              <span>اضغط على الخريطة أو استخدم GPS</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    captureGps((lat, lng) => {
                      void onUpdateSubscriber(pickingLocationForId, { lat, lng });
                      setSelectedSubId(pickingLocationForId);
                      setPickingLocationForId(null);
                    })
                  }
                  className="px-2.5 py-1 rounded-lg bg-emerald-500 text-white inline-flex items-center gap-1"
                >
                  <LocateFixed className="w-3.5 h-3.5" /> GPS
                </button>
                <button
                  type="button"
                  onClick={() => setPickingLocationForId(null)}
                  className="px-2.5 py-1 rounded-lg bg-white/20 hover:bg-white/30"
                >
                  إلغاء
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Map Tools (Bottom-Left) */}
        <div className="absolute bottom-4 left-4 z-[400] flex flex-col gap-2">
          <button
            type="button"
            onClick={() =>
              setMapStyle((prev) =>
                prev === 'streets' ? 'satellite' : prev === 'satellite' ? 'dark' : 'streets'
              )
            }
            className="w-11 h-11 rounded-2xl bg-white/95 dark:bg-[#11151E]/95 border border-slate-200/90 dark:border-white/[0.1] shadow-lg flex items-center justify-center text-slate-700 dark:text-slate-200 hover:text-sky-500"
            title="شوارع / قمر صناعي / ليلي"
          >
            <Layers className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => setShowHeatmap((h) => !h)}
            className={`w-11 h-11 rounded-2xl border shadow-lg flex items-center justify-center transition-colors ${
              showHeatmap
                ? 'bg-orange-600 border-orange-600 text-white'
                : 'bg-white/95 dark:bg-[#11151E]/95 border-slate-200/90 dark:border-white/[0.1] text-slate-700 dark:text-slate-200'
            }`}
            title="خريطة حرارية للكثافة"
          >
            <Flame className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => setClustered((c) => !c)}
            className={`w-11 h-11 rounded-2xl border shadow-lg flex items-center justify-center transition-colors ${
              clustered
                ? 'bg-sky-600 border-sky-600 text-white'
                : 'bg-white/95 dark:bg-[#11151E]/95 border-slate-200/90 dark:border-white/[0.1] text-slate-700 dark:text-slate-200'
            }`}
            title="تجميع النقاط"
          >
            <Network className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={resetView}
            className="w-11 h-11 rounded-2xl bg-white/95 dark:bg-[#11151E]/95 border border-slate-200/90 dark:border-white/[0.1] shadow-lg flex items-center justify-center text-slate-700 dark:text-slate-200 hover:text-sky-500"
            title="إعادة التمركز"
          >
            <Crosshair className="w-5 h-5" />
          </button>
          <div className="flex flex-col rounded-2xl bg-white/95 dark:bg-[#11151E]/95 border border-slate-200/90 dark:border-white/[0.1] shadow-lg overflow-hidden">
            <button
              type="button"
              onClick={() => mapRef.current?.zoomIn()}
              className="w-11 h-10 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06]"
              aria-label="تكبير"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => mapRef.current?.zoomOut()}
              className="w-11 h-10 flex items-center justify-center border-t border-slate-200/80 dark:border-white/[0.07] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06]"
              aria-label="تصغير"
            >
              <Minus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Selected Subscriber Sheet with Google Maps Directions (#70) */}
        {activeSub ? (
          <div className="absolute bottom-4 right-4 left-20 sm:left-auto sm:w-80 z-[400] rounded-2xl bg-white/95 dark:bg-[#11151E]/95 backdrop-blur-md border border-slate-200/90 dark:border-white/[0.1] p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-bold text-sm text-slate-900 dark:text-white">{activeSub.fullName}</h3>
                <p className="text-xs font-mono text-slate-500 dark:text-slate-400" dir="ltr">
                  {activeSub.username} · {activeSub.ip || 'Offline'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedSubId(null);
                  onClearFocused();
                }}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-2.5 text-xs text-slate-600 dark:text-slate-300 space-y-1">
              <div>المنطقة: {activeSub.area || 'غير محددة'}</div>
              <div>
                الحالة:{' '}
                <strong style={{ color: PIN_STYLES[activeSub.billingStatus].fill }}>
                  {PIN_STYLES[activeSub.billingStatus].label}
                </strong>
                {activeSub.debtAmountIqd > 0 && ` · دين ${activeSub.debtAmountIqd.toLocaleString()} د.ع`}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPickingLocationForId(activeSub.id)}
                className="flex-1 min-h-[38px] rounded-xl bg-sky-600 text-white text-xs font-bold inline-flex items-center justify-center gap-1"
              >
                <MapPin className="w-3.5 h-3.5" />
                <span>تثبيت الموقع</span>
              </button>
              {activeSub.lat !== null && activeSub.lng !== null && (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${activeSub.lat},${activeSub.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-h-[38px] px-3 rounded-xl bg-emerald-600 text-white text-xs font-bold inline-flex items-center gap-1"
                >
                  <Navigation className="w-3.5 h-3.5" />
                  <span>التوجيه</span>
                </a>
              )}
              {activeSub.phone && (
                <a
                  href={`tel:${activeSub.phone}`}
                  className="min-h-[38px] px-3 rounded-xl border border-slate-200 dark:border-white/[0.1] text-xs font-bold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1"
                >
                  <Phone className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>
        ) : unlocatedSubs.length > 0 ? (
          <div className="hidden sm:block absolute bottom-4 right-4 max-w-xs z-[400] rounded-2xl bg-white/95 dark:bg-[#11151E]/95 backdrop-blur-md border border-slate-200/90 dark:border-white/[0.1] p-3.5 text-xs shadow-lg space-y-2">
            <div className="font-bold text-slate-900 dark:text-white">
              {unlocatedSubs.length} مشترك بدون إحداثيات GPS
            </div>
            <button
              type="button"
              onClick={() => setPickingLocationForId(unlocatedSubs[0].id)}
              className="w-full min-h-[36px] rounded-xl bg-sky-600 text-white font-bold"
            >
              تحديد موقع: {unlocatedSubs[0].username}
            </button>
          </div>
        ) : null}
      </div>

      {/* Towers & Sectors Modal (#62) */}
      {showTowerModal && (
        <div className="fixed inset-0 z-[500] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                إدارة الأبراج وزوايا السكتر
              </h3>
              <button
                type="button"
                onClick={() => setShowTowerModal(false)}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveTower(e)} className="space-y-3">
              <input
                type="text"
                required
                value={towerName}
                onChange={(e) => setTowerName(e.target.value)}
                placeholder="اسم البرج (مثال: برج المنصور الشمالي)"
                className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm text-slate-900 dark:text-white"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <input
                  type="text"
                  dir="ltr"
                  value={towerLat}
                  onChange={(e) => setTowerLat(e.target.value)}
                  placeholder="Lat"
                  className="min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-slate-900 dark:text-white"
                />
                <input
                  type="text"
                  dir="ltr"
                  value={towerLng}
                  onChange={(e) => setTowerLng(e.target.value)}
                  placeholder="Lng"
                  className="min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-slate-900 dark:text-white"
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  captureGps((lat, lng) => {
                    setTowerLat(String(lat));
                    setTowerLng(String(lng));
                  })
                }
                className="w-full min-h-[40px] rounded-xl border border-sky-500/35 bg-sky-500/10 text-sky-600 dark:text-sky-400 text-xs font-bold inline-flex items-center justify-center gap-1.5"
              >
                <LocateFixed className="w-4 h-4" />
                <span>التقاط إحداثيات موقعي الحالي GPS</span>
              </button>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">الاتجاه (درجة)</label>
                  <input
                    type="number"
                    min={0}
                    max={360}
                    dir="ltr"
                    value={towerAzimuth}
                    onChange={(e) => setTowerAzimuth(e.target.value)}
                    className="w-full min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-xs font-mono text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">زاوية السكتر</label>
                  <input
                    type="number"
                    min={15}
                    max={360}
                    dir="ltr"
                    value={towerBeam}
                    onChange={(e) => setTowerBeam(e.target.value)}
                    className="w-full min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-xs font-mono text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">المدى (متر)</label>
                  <input
                    type="number"
                    min={100}
                    max={25000}
                    dir="ltr"
                    value={towerRadius}
                    onChange={(e) => setTowerRadius(e.target.value)}
                    className="w-full min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-xs font-mono text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full min-h-[44px] rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-bold"
              >
                حفظ وإظهار البرج على الخريطة
              </button>
            </form>

            {towers.length > 0 && (
              <div className="divide-y divide-slate-200 dark:divide-white/[0.07] pt-2">
                {towers.map((t) => {
                  const hs = typeof t.healthScore === 'number' ? t.healthScore : 100;
                  const hsColor =
                    hs >= 80
                      ? 'bg-emerald-500/15 text-emerald-500'
                      : hs >= 50
                        ? 'bg-amber-500/15 text-amber-500'
                        : 'bg-red-500/15 text-red-500';
                  return (
                    <div key={t.id} className="py-2.5 flex items-center justify-between text-xs gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 dark:text-white">{t.name}</span>
                          <span className={`font-mono font-bold text-[10px] px-2 py-0.5 rounded-md ${hsColor}`}>
                            صحة {hs}%
                          </span>
                        </div>
                        <div className="font-mono text-slate-500 mt-0.5" dir="ltr">
                          {t.lat}, {t.lng} · {t.azimuthDeg}° ({t.beamwidthDeg}°) · RF {t.onlineRadios ?? 0}/{t.totalRadios ?? 0} · Subs {t.onlineSubs ?? 0}/{t.totalSubs ?? 0}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void onDeleteTower(t.id)}
                        className="p-2 text-slate-400 hover:text-red-500 shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Line-of-Sight & 1st Fresnel Zone Calculator Modal (#94) */}
      {showFresnelModal && (() => {
        const twr = towers.find((t) => t.id === fresnelTowerId) || towers[0] || null;
        const sub = geoSubscribers.find((s) => s.id === fresnelSubId) || geoSubscribers[0] || null;
        const freq = Math.max(0.9, Number(fresnelFreqGhz) || 5.8);
        const hTower = Math.max(1, Number(fresnelTowerMastM) || 18);
        const hCpe = Math.max(1, Number(fresnelCpeMastM) || 8);
        const distKm =
          twr && sub && sub.lat !== null && sub.lng !== null
            ? haversineKm(twr.lat, twr.lng, sub.lat, sub.lng)
            : 0;
        const azimuth =
          twr && sub && sub.lat !== null && sub.lng !== null
            ? bearingDeg(twr.lat, twr.lng, sub.lat, sub.lng)
            : 0;
        const fresnelRadiusM = distKm > 0 ? 17.32 * Math.sqrt(distKm / (4 * freq)) : 0;
        const clear60PctM = fresnelRadiusM * 0.6;
        const earthBulgeM = (distKm * distKm) / 67.9;
        const midHeightM = (hTower + hCpe) / 2;
        const netClearanceM = midHeightM - clear60PctM - earthBulgeM;

        return (
          <div className="fixed inset-0 z-[500] flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm sm:p-4">
            <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-6 shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Ruler className="w-5 h-5 text-teal-500" />
                  <h3 className="text-base font-bold text-slate-900 dark:text-white">
                    حاسبة خط النظر والمنطقة الحرة الأولى (Fresnel LoS)
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowFresnelModal(false)}
                  className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl text-slate-500"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {towers.length === 0 || geoSubscribers.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 dark:border-white/[0.12] p-6 text-center text-xs text-slate-500">
                  أضف برجاً وحدد إحداثيات مشترك واحد على الأقل لحساب المسافة وزاوية التوجيه ومنطقة Fresnel.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">البرج المرسل</label>
                      <select
                        value={twr?.id || ''}
                        onChange={(e) => setFresnelTowerId(e.target.value)}
                        className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-bold text-slate-900 dark:text-white"
                      >
                        {towers.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">المشترك الهدف</label>
                      <select
                        value={sub?.id || ''}
                        onChange={(e) => setFresnelSubId(e.target.value)}
                        className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-bold text-slate-900 dark:text-white"
                      >
                        {geoSubscribers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.username} ({s.fullName})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">التردد (GHz)</label>
                      <select
                        value={fresnelFreqGhz}
                        onChange={(e) => setFresnelFreqGhz(e.target.value)}
                        className="w-full min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-xs font-mono text-slate-900 dark:text-white"
                      >
                        <option value="2.4">2.4 GHz</option>
                        <option value="5.8">5.8 GHz</option>
                        <option value="6.0">6 GHz</option>
                        <option value="24">24 GHz</option>
                        <option value="60">60 GHz</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">ارتفاع البرج (م)</label>
                      <input
                        type="number"
                        min={1}
                        dir="ltr"
                        value={fresnelTowerMastM}
                        onChange={(e) => setFresnelTowerMastM(e.target.value)}
                        className="w-full min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-xs font-mono text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">ارتفاع النانو (م)</label>
                      <input
                        type="number"
                        min={1}
                        dir="ltr"
                        value={fresnelCpeMastM}
                        onChange={(e) => setFresnelCpeMastM(e.target.value)}
                        className="w-full min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-xs font-mono text-slate-900 dark:text-white"
                      />
                    </div>
                  </div>

                  {/* SVG Fresnel Visualization */}
                  <div className="rounded-2xl bg-[#070A10] border border-white/[0.08] p-4">
                    <svg viewBox="0 0 420 110" className="w-full h-28">
                      <line x1="20" y1="95" x2="400" y2="95" stroke="#334155" strokeWidth="2" />
                      <line x1="40" y1="95" x2="40" y2="28" stroke="#0EA5E9" strokeWidth="4" />
                      <line x1="380" y1="95" x2="380" y2="54" stroke="#10B981" strokeWidth="4" />
                      <ellipse
                        cx="210"
                        cy="41"
                        rx="170"
                        ry={Math.min(34, Math.max(8, fresnelRadiusM * 2.2))}
                        fill="rgba(14,165,233,0.14)"
                        stroke="#38BDF8"
                        strokeDasharray="4 4"
                      />
                      <line x1="40" y1="28" x2="380" y2="54" stroke="#F59E0B" strokeWidth="2" />
                      <text x="40" y="20" fill="#38BDF8" fontSize="9" textAnchor="middle">
                        برج ({hTower}m)
                      </text>
                      <text x="380" y="46" fill="#10B981" fontSize="9" textAnchor="middle">
                        CPE ({hCpe}m)
                      </text>
                      <text x="210" y="18" fill="#E2E8F0" fontSize="10" textAnchor="middle">
                        {distKm.toFixed(2)} km · {Math.round(azimuth)}°
                      </text>
                    </svg>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                    <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
                      <div className="text-slate-500">المسافة المباشرة</div>
                      <div className="font-mono font-extrabold text-sky-500 mt-0.5" dir="ltr">
                        {distKm.toFixed(2)} km
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
                      <div className="text-slate-500">زاوية البوصلة</div>
                      <div className="font-mono font-extrabold text-indigo-400 mt-0.5" dir="ltr">
                        {Math.round(azimuth)}°
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
                      <div className="text-slate-500">خلوص 60% Fresnel</div>
                      <div className="font-mono font-extrabold text-amber-500 mt-0.5" dir="ltr">
                        ±{clear60PctM.toFixed(1)} m
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
                      <div className="text-slate-500">صافي الارتفاع المتاح</div>
                      <div
                        className={`font-mono font-extrabold mt-0.5 ${
                          netClearanceM >= 2 ? 'text-emerald-500' : 'text-red-500'
                        }`}
                        dir="ltr"
                      >
                        {netClearanceM.toFixed(1)} m
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
};
