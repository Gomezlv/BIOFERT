import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type SensorStatus = 'activo' | 'alerta' | 'inactivo';
export type RecStatus = 'pendiente' | 'aplicada' | 'descartada';
export type Difficulty = 'facil' | 'media' | 'alta';

export type Sensor = {
  id: number;
  farm_id: number;
  code: string;
  zone: string;
  status: SensorStatus;
  battery_pct: number;
  last_ch4_ppm: number | null;
  last_recorded_at: string | null;
};

export type FarmRecommendationRow = {
  farm_rec_id: number;
  farm_id: number;
  status: RecStatus;
  created_at: string;
  recommendation_id: number;
  title: string;
  expected_reduction_pct: number | null;
  difficulty: Difficulty;
  notes: string | null;
};

export type Farm = {
  id: number;
  user_id: number;
  name: string;
  location: string | null;
  area_ha: number | null;
  heads_active: number;
};

export type Profile = {
  user: { id: number; full_name: string; role: string; location: string | null; email: string | null } | null;
};

export type Dashboard = {
  farmId: number;
  alertSensor: { code: string; zone: string; ch4_ppm: number | null; recorded_at: string | null; threshold_ppm: number } | null;
  recommendationDay: { title: string; notes: string | null; expected_reduction_pct: number | null } | null;
  emissionsTodayKg: number;
  headsActive: number;
  reductionMonthPct: number;
  bondsEstimatedUsd: number;
  emissions24h: { hour_ts: string; kg_ch4: number }[];
};

export type Reports = {
  farmId: number;
  co2eqReducedT: number;
  bondsCount: number;
  valueEstimatedUsd: number;
  revenueAccumUsd: number;
  co2eqByMonth: { month: string; co2eq_reduced_t: number }[];
};

@Injectable({ providedIn: 'root' })
export class ApiService {
  private baseUrl = 'http://localhost:3000/api';

  constructor(private http: HttpClient) {}

  health(): Observable<{ ok: boolean }> {
    return this.http.get<{ ok: boolean }>(`${this.baseUrl}/health`);
  }

  listSensors(farmId = 1): Observable<Sensor[]> {
    return this.http.get<Sensor[]>(`${this.baseUrl}/sensors?farmId=${farmId}`);
  }

  createSensor(payload: {
    farm_id?: number;
    code: string;
    zone: string;
    status?: SensorStatus;
    battery_pct?: number;
  }) {
    return this.http.post<Sensor>(`${this.baseUrl}/sensors`, payload);
  }

  listRecommendations(farmId = 1): Observable<FarmRecommendationRow[]> {
    return this.http.get<FarmRecommendationRow[]>(`${this.baseUrl}/recommendations?farmId=${farmId}`);
  }

  createRecommendation(payload: {
    farm_id?: number;
    title: string;
    expected_reduction_pct?: number | null;
    difficulty?: Difficulty;
    notes?: string | null;
  }) {
    return this.http.post(`${this.baseUrl}/recommendations`, payload);
  }

  profile(): Observable<Profile> {
    return this.http.get<Profile>(`${this.baseUrl}/profile`);
  }

  listFarms(userId = 1): Observable<Farm[]> {
    return this.http.get<Farm[]>(`${this.baseUrl}/farms?userId=${userId}`);
  }

  dashboard(farmId = 1): Observable<Dashboard> {
    return this.http.get<Dashboard>(`${this.baseUrl}/dashboard?farmId=${farmId}`);
  }

  reports(farmId = 1): Observable<Reports> {
    return this.http.get<Reports>(`${this.baseUrl}/reports?farmId=${farmId}`);
  }
}

