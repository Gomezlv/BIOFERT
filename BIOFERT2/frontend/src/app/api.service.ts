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
  breeds_text?: string | null;
  thermal_floor?: string | null;
  altitude_m?: number | null;
  production_model?: string | null;
};

export type UserRow = {
  id: number;
  full_name: string;
  role: string;
  location: string | null;
  email: string | null;
  created_at?: string;
};

export type Profile = {
  user: UserRow | null;
};

export type AuthResponse = {
  token: string;
  user: UserRow;
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

export type ClientConfig = {
  googleMapsApiKey: string | null;
};

@Injectable({ providedIn: 'root' })
export class ApiService {
  private baseUrl = 'http://localhost:3000/api';

  constructor(private http: HttpClient) {}

  health(): Observable<{ ok: boolean }> {
    return this.http.get<{ ok: boolean }>(`${this.baseUrl}/health`);
  }

  config(): Observable<ClientConfig> {
    return this.http.get<ClientConfig>(`${this.baseUrl}/config`);
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

  login(payload: { email: string; password: string }): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/auth/login`, payload);
  }

  register(payload: { email: string; password: string; full_name?: string; location?: string }): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/auth/register`, payload);
  }

  logout(): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.baseUrl}/auth/logout`, {});
  }

  profile(): Observable<Profile> {
    return this.http.get<Profile>(`${this.baseUrl}/profile`);
  }

  updateProfile(payload: { current_password: string; email?: string; new_password?: string }): Observable<Profile> {
    return this.http.patch<Profile>(`${this.baseUrl}/profile`, payload);
  }

  updateProfileDetails(payload: { full_name: string; role: string; location?: string | null }): Observable<Profile> {
    return this.http.patch<Profile>(`${this.baseUrl}/profile/details`, payload);
  }

  updateFarm(
    farmId: number,
    payload: {
      name: string;
      location?: string | null;
      area_ha?: number | null;
      heads_active?: number | null;
      breeds_text?: string | null;
      thermal_floor?: string | null;
      altitude_m?: number | null;
      production_model?: string | null;
    }
  ): Observable<Farm> {
    return this.http.patch<Farm>(`${this.baseUrl}/farms/${farmId}`, payload);
  }

  listFarms(): Observable<Farm[]> {
    return this.http.get<Farm[]>(`${this.baseUrl}/farms`);
  }

  dashboard(farmId = 1): Observable<Dashboard> {
    return this.http.get<Dashboard>(`${this.baseUrl}/dashboard?farmId=${farmId}`);
  }

  reports(farmId = 1): Observable<Reports> {
    return this.http.get<Reports>(`${this.baseUrl}/reports?farmId=${farmId}`);
  }
}

