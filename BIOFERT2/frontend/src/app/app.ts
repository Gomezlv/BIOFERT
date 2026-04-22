import { Component, computed, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { ApiService, Farm, FarmRecommendationRow, Profile, Reports, Sensor } from './api.service';

@Component({
  selector: 'app-root',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  constructor(private api: ApiService) {}

  protected readonly screen = signal<'inicio' | 'sensores' | 'recomendaciones' | 'reportes' | 'perfil'>('inicio');

  protected readonly profile = signal<Profile | null>(null);
  protected readonly farms = signal<Farm[]>([]);
  protected readonly selectedFarmId = signal<number>(1);
  protected readonly pendingFarmId = signal<number | null>(null);

  protected readonly sensors = signal<Sensor[]>([]);
  protected readonly recs = signal<FarmRecommendationRow[]>([]);

  protected readonly dashboard = signal<{
    alertSensor: { code: string; zone: string; ch4_ppm: number | null; threshold_ppm: number } | null;
    recommendationDay: { title: string; notes: string | null; expected_reduction_pct: number | null } | null;
    emissionsTodayKg: number;
    headsActive: number;
    reductionMonthPct: number;
    bondsEstimatedUsd: number;
    emissions24h: { hour_ts: string; kg_ch4: number }[];
  } | null>(null);

  protected readonly reports = signal<Reports | null>(null);
  protected readonly sensorFilter = signal<'todos' | 'activo' | 'alerta' | 'inactivo'>('todos');

  protected readonly selectedFarm = computed(() => this.farms().find(f => f.id === this.selectedFarmId()) ?? null);
  protected readonly kpiAlerts = computed(() => this.sensors().filter(s => s.status === 'alerta').length);
  protected readonly kpiPending = computed(() => this.recs().filter(r => r.status === 'pendiente').length);

  ngOnInit(): void {
    this.api.profile().subscribe(p => this.profile.set(p));
    this.api.listFarms().subscribe(rows => {
      this.farms.set(rows);
      if (rows.length > 0) this.selectedFarmId.set(rows[0].id);
      this.refreshAll();
    });
  }

  protected navigate(id: 'inicio' | 'sensores' | 'recomendaciones' | 'reportes' | 'perfil') {
    this.screen.set(id);
  }

  protected refreshAll() {
    const farmId = this.selectedFarmId();
    this.api.dashboard(farmId).subscribe(d =>
      this.dashboard.set({
        alertSensor: d.alertSensor,
        recommendationDay: d.recommendationDay,
        emissionsTodayKg: d.emissionsTodayKg,
        headsActive: d.headsActive,
        reductionMonthPct: d.reductionMonthPct,
        bondsEstimatedUsd: d.bondsEstimatedUsd,
        emissions24h: d.emissions24h,
      })
    );
    this.api.listSensors(farmId).subscribe(rows => this.sensors.set(rows));
    this.api.listRecommendations(farmId).subscribe(rows => this.recs.set(rows));
    this.api.reports(farmId).subscribe(r => this.reports.set(r));
  }

  protected onFarmSelect(nextFarmId: number) {
    this.pendingFarmId.set(Number(nextFarmId));
  }

  protected confirmFarmChange() {
    const next = this.pendingFarmId();
    if (!next) return;
    this.selectedFarmId.set(next);
    this.pendingFarmId.set(null);
    this.refreshAll();
    this.navigate('inicio');
  }

  protected readonly recStatusLabel: Record<string, string> = {
    pendiente: 'Pendiente',
    aplicada: 'Aplicada',
    descartada: 'Descartada',
  };

  protected readonly formatUsd = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

  protected readonly filteredSensors = computed(() => {
    const f = this.sensorFilter();
    const list = this.sensors();
    if (f === 'todos') return list;
    return list.filter(s => s.status === f);
  });

  protected readonly chartPoints = computed(() => {
    const d = this.dashboard();
    const pts = d?.emissions24h ?? [];
    if (pts.length === 0) return '';
    const values = pts.map(p => p.kg_ch4);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const width = 320;
    const height = 80;
    const pad = 6;
    const span = Math.max(max - min, 0.001);
    return pts
      .map((p, i) => {
        const x = pad + (i * (width - pad * 2)) / (pts.length - 1);
        const y = pad + (1 - (p.kg_ch4 - min) / span) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });

  protected readonly co2eqBarHeights = computed(() => {
    const series = this.reports()?.co2eqByMonth ?? [];
    const values = series.map(s => s.co2eq_reduced_t);
    const max = Math.max(...values, 0.001);
    return series.map(s => ({
      month: s.month,
      value: s.co2eq_reduced_t,
      h: Math.round((s.co2eq_reduced_t / max) * 80),
    }));
  });
}
