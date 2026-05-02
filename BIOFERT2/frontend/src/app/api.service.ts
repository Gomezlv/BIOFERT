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
  certification_step?: number;
};

export type AccountType = 'admin' | 'ganadero';

export type UserRow = {
  id: number;
  full_name: string;
  role: string;
  account_type?: AccountType;
  location: string | null;
  email: string | null;
  created_at?: string;
};

export type AdminOverview = {
  user_count: number;
  ganadero_count: number;
  admin_count: number;
  farm_count: number;
  sensor_count: number;
  sensors_alerta: number;
  recs_pendientes: number;
};

export type AdminUserRow = UserRow & { farm_count: number };

export type AdminFarmRow = Farm & {
  owner_email: string | null;
  owner_name: string | null;
  created_at?: string;
};

export type AdminSensorRow = Sensor & {
  farm_name: string;
  owner_user_id: number;
  owner_email: string | null;
  installed_at?: string;
};

export type AdminFarmRecommendationRow = FarmRecommendationRow & {
  farm_name: string;
  owner_email: string | null;
};

export type AdminReportsSummary = {
  total_co2eq_reduced_t: number;
  total_bonds_usd: number;
  byFarm: {
    farm_id: number;
    farm_name: string;
    certification_step: number;
    certification_label: string;
    co2eq_reduced_t: number;
    bonds_count: number;
    value_estimated_usd: number;
  }[];
};

export type AdminUserImpact = {
  user_id: number;
  co2eq_by_month: { month: string; co2eq_reduced_t: number; ch4_eq_reduced_kg: number }[];
  totals: { co2eq_reduced_t: number; bonds_count: number; value_estimated_usd: number };
};

export type AdminUserAuditEntry = {
  id: number;
  action: string;
  meta: unknown;
  created_at: string;
};

export type AdminAuditRow = {
  id: number;
  user_id: number | null;
  action: string;
  meta: unknown;
  created_at: string;
  user_email: string | null;
};

export type AdminConfigSummary = {
  googleMapsApiKeyMasked: string | null;
  port: number;
  database: string;
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

  adminOverview(): Observable<AdminOverview> {
    return this.http.get<AdminOverview>(`${this.baseUrl}/admin/overview`);
  }

  adminUsers(): Observable<AdminUserRow[]> {
    return this.http.get<AdminUserRow[]>(`${this.baseUrl}/admin/users`);
  }

  adminFarms(): Observable<AdminFarmRow[]> {
    return this.http.get<AdminFarmRow[]>(`${this.baseUrl}/admin/farms`);
  }

  adminSensors(): Observable<AdminSensorRow[]> {
    return this.http.get<AdminSensorRow[]>(`${this.baseUrl}/admin/sensors`);
  }

  adminFarmRecommendations(): Observable<AdminFarmRecommendationRow[]> {
    return this.http.get<AdminFarmRecommendationRow[]>(`${this.baseUrl}/admin/farm-recommendations`);
  }

  adminUserFarms(userId: number): Observable<Farm[]> {
    return this.http.get<Farm[]>(`${this.baseUrl}/admin/users/${userId}/farms`);
  }

  adminUserImpact(userId: number): Observable<AdminUserImpact> {
    return this.http.get<AdminUserImpact>(`${this.baseUrl}/admin/users/${userId}/impact`);
  }

  adminUserAuditLog(userId: number): Observable<AdminUserAuditEntry[]> {
    return this.http.get<AdminUserAuditEntry[]>(`${this.baseUrl}/admin/users/${userId}/audit-log`);
  }

  adminUpdateUser(
    userId: number,
    payload: {
      full_name?: string;
      role?: string;
      location?: string | null;
      email?: string;
      account_type?: AccountType;
      new_password?: string;
    }
  ): Observable<{ user: UserRow }> {
    return this.http.patch<{ user: UserRow }>(`${this.baseUrl}/admin/users/${userId}`, payload);
  }

  adminDeleteUser(userId: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.baseUrl}/admin/users/${userId}`);
  }

  adminReportsSummary(): Observable<AdminReportsSummary> {
    return this.http.get<AdminReportsSummary>(`${this.baseUrl}/admin/reports-summary`);
  }

  adminAudit(): Observable<AdminAuditRow[]> {
    return this.http.get<AdminAuditRow[]>(`${this.baseUrl}/admin/audit`);
  }

  adminConfigSummary(): Observable<AdminConfigSummary> {
    return this.http.get<AdminConfigSummary>(`${this.baseUrl}/admin/config-summary`);
  }
}

