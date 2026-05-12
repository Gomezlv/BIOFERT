import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize, forkJoin } from 'rxjs';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import {
  AdminConfigSummary,
  AdminFarmRow,
  AdminOverview,
  AdminReportsSummary,
  AdminSensorRow,
  AdminUserAuditEntry,
  AdminUserImpact,
  AdminUserRow,
  ApiService,
  Difficulty,
  Farm,
  FarmRecommendationRow,
  Profile,
  RecStatus,
  Reports,
  Sensor,
} from './api.service';
import { AuthService } from './auth.service';

type AdminTab = 'panel' | 'usuarios' | 'fincas' | 'sensores' | 'reportes' | 'config';

type AiRecommendation = {
  id: string;
  title: string;
  expected_reduction_pct: number;
  difficulty: 'facil' | 'media' | 'alta';
  status: 'pendiente' | 'aplicada' | 'descartada';
  short: string;
  response: {
    resumen: string;
    porQueFunciona: string[];
    pasos: string[];
    riesgos: string[];
    metricas: string[];
    costoTiempo: string[];
  };
};

@Component({
  selector: 'app-root',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly fb = inject(FormBuilder);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly authScreen = signal(true);
  protected readonly authTab = signal<'login' | 'register'>('login');
  protected readonly authStep = signal<'welcome' | 'forms'>('welcome');
  protected readonly authError = signal<string | null>(null);
  protected readonly authBusy = signal(false);

  protected readonly showCredentialsEditor = signal(false);
  protected readonly credentialsMessage = signal<{ type: 'ok' | 'err'; text: string } | null>(null);
  protected readonly credentialsBusy = signal(false);

  protected readonly showProfileEditor = signal(false);
  protected readonly profileEditBusy = signal(false);
  protected readonly profileEditMessage = signal<{ type: 'ok' | 'err'; text: string } | null>(null);

  protected readonly loginForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  protected readonly registerForm = this.fb.nonNullable.group({
    full_name: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
    location: [''],
  });

  protected readonly credentialsForm = this.fb.nonNullable.group({
    email: [''],
    current_password: ['', Validators.required],
    new_password: [''],
  });

  protected readonly profileEditForm = this.fb.nonNullable.group({
    // usuario
    full_name: ['', Validators.required],
    role: ['', Validators.required],
    user_location: [''],
    // predio (finca seleccionada)
    farm_name: ['', Validators.required],
    farm_location: [''],
    area_ha: [0],
    heads_active: [0],
    breeds_text: [''],
    thermal_floor: [''],
    altitude_m: [0],
    production_model: [''],
  });

  protected readonly screen = signal<'inicio' | 'sensores' | 'reportes' | 'recomendaciones' | 'perfil'>('inicio');

  protected readonly layoutMode = signal<'admin' | 'ganadero'>('ganadero');
  protected readonly adminTab = signal<AdminTab>('panel');
  protected readonly previewOwnerLabel = signal<string | null>(null);
  protected readonly adminLoadError = signal<string | null>(null);
  protected readonly adminOverview = signal<AdminOverview | null>(null);
  protected readonly adminUsers = signal<AdminUserRow[]>([]);
  protected readonly adminFarms = signal<AdminFarmRow[]>([]);
  protected readonly adminSensors = signal<AdminSensorRow[]>([]);
  protected readonly adminReports = signal<AdminReportsSummary | null>(null);
  protected readonly adminConfig = signal<AdminConfigSummary | null>(null);

  protected readonly profile = signal<Profile | null>(null);
  protected readonly farms = signal<Farm[]>([]);
  protected readonly selectedFarmId = signal<number | null>(null);
  protected readonly pendingFarmId = signal<number | null>(null);

  protected readonly expandedAdminUserId = signal<number | null>(null);
  protected readonly adminUserImpact = signal<AdminUserImpact | null>(null);
  protected readonly adminUserAuditDetail = signal<AdminUserAuditEntry[]>([]);
  protected readonly adminUserDetailBusy = signal(false);

  protected readonly expandedAdminFarmId = signal<number | null>(null);
  protected readonly adminFarmReportsExtra = signal<Reports | null>(null);
  protected readonly adminFarmDetailBusy = signal(false);

  protected readonly showAdminUserEditor = signal(false);
  protected readonly adminUserEditorId = signal<number | null>(null);
  protected readonly adminUserEditorBusy = signal(false);
  protected readonly adminUserEditorMessage = signal<string | null>(null);
  protected readonly adminProfileEditorOnly = signal(false);

  protected readonly adminUserEditForm = this.fb.nonNullable.group({
    full_name: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    role: ['', Validators.required],
    location: [''],
    account_type: this.fb.nonNullable.control<'admin' | 'ganadero'>('ganadero'),
    new_password: [''],
  });

  protected readonly sensors = signal<Sensor[]>([]);
  protected readonly reports = signal<Reports | null>(null);
  protected readonly farmRecommendations = signal<FarmRecommendationRow[]>([]);
  protected readonly selectedFarmRecDetailId = signal<number | null>(null);
  /** Filtro de lista en la pestaña Recomendaciones (aplicada = implementada en UI). */
  protected readonly recListFilter = signal<'todas' | 'pendiente' | 'aplicada' | 'descartada'>('todas');

  protected readonly dashboard = signal<{
    alertSensor: { code: string; zone: string; ch4_ppm: number | null; threshold_ppm: number } | null;
    recommendationDay: { title: string; notes: string | null; expected_reduction_pct: number | null } | null;
    emissionsTodayKg: number;
    headsActive: number;
    reductionMonthPct: number;
    bondsEstimatedUsd: number;
    emissions24h: { hour_ts: string; kg_ch4: number }[];
  } | null>(null);

  protected readonly sensorFilter = signal<'todos' | 'activo' | 'alerta' | 'inactivo'>('todos');

  protected readonly selectedFarm = computed(() => this.farms().find(f => f.id === this.selectedFarmId()) ?? null);

  protected readonly filteredFarmRecommendations = computed(() => {
    const f = this.recListFilter();
    const list = this.farmRecommendations();
    if (f === 'todas') return list;
    return list.filter(r => r.status === f);
  });

  protected readonly activeFarmRecommendationDetail = computed(() => {
    const id = this.selectedFarmRecDetailId();
    if (id == null) return null;
    return this.farmRecommendations().find(r => r.farm_rec_id === id) ?? null;
  });

  /** Panel admin: conteo de sensores por estado */
  protected readonly adminPanelSensorCounts = computed(() => {
    const s = this.adminSensors();
    const activo = s.filter(x => x.status === 'activo').length;
    const alerta = s.filter(x => x.status === 'alerta').length;
    const inactivo = s.filter(x => x.status === 'inactivo').length;
    const total = s.length;
    return { activo, alerta, inactivo, total };
  });

  /** Sensores en alerta (prioridad para el panel) */
  protected readonly adminPanelAlertSensors = computed(() =>
    this.adminSensors().filter(x => x.status === 'alerta').slice(0, 14)
  );

  protected readonly adminPanelInactiveSensors = computed(() =>
    this.adminSensors().filter(x => x.status === 'inactivo').slice(0, 8)
  );

  /** Top fincas por t CO₂eq acumulado (barra horizontal %) */
  protected readonly adminPanelCo2eqByFarm = computed(() => {
    const rows = [...(this.adminReports()?.byFarm ?? [])].sort((a, b) => b.co2eq_reduced_t - a.co2eq_reduced_t).slice(0, 10);
    const max = Math.max(...rows.map(r => r.co2eq_reduced_t), 0.01);
    return rows.map(r => ({
      farm_id: r.farm_id,
      name: r.farm_name.length > 22 ? `${r.farm_name.slice(0, 20)}…` : r.farm_name,
      fullName: r.farm_name,
      t: r.co2eq_reduced_t,
      pct: Math.min(100, Math.round((r.co2eq_reduced_t / max) * 100)),
    }));
  });

  /** Top fincas por cabezas */
  protected readonly adminPanelHeadsByFarm = computed(() => {
    const rows = [...this.adminFarms()].sort((a, b) => b.heads_active - a.heads_active).slice(0, 8);
    const max = Math.max(...rows.map(r => r.heads_active), 1);
    return rows.map(r => ({
      id: r.id,
      name: r.name.length > 20 ? `${r.name.slice(0, 18)}…` : r.name,
      heads: r.heads_active,
      pct: Math.min(100, Math.round((r.heads_active / max) * 100)),
    }));
  });

  protected readonly adminPanelAccountMix = computed(() => {
    const u = this.adminUsers();
    const gan = u.filter(x => (x.account_type ?? 'ganadero') === 'ganadero').length;
    const adm = u.filter(x => x.account_type === 'admin').length;
    const total = Math.max(u.length, 1);
    return {
      gan,
      adm,
      ganPct: Math.round((gan / total) * 100),
      admPct: Math.round((adm / total) * 100),
    };
  });

  protected readonly isAdminUser = computed(() => (this.profile()?.user?.account_type ?? 'ganadero') === 'admin');

  protected readonly userInitials = computed(() => {
    const name = (this.profile()?.user?.full_name ?? '').trim();
    if (!name) return '—';
    const parts = name.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? '';
    const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
    return (a + b).toUpperCase();
  });

  protected readonly interventionsApplied = computed(() => this.aiRecs.filter(r => r.status === 'aplicada').length);
  protected readonly feedbackCount = computed(() => this.aiRecs.length);
  protected readonly monthsInSystem = computed(() => {
    const created = this.profile()?.user?.created_at;
    if (!created) return 0;
    const d = new Date(created);
    if (Number.isNaN(d.getTime())) return 0;
    const now = new Date();
    const months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    return Math.max(0, months);
  });

  protected readonly aiRecFilter = signal<'todas' | 'pendiente' | 'aplicada' | 'descartada'>('todas');

  protected readonly aiRecs: AiRecommendation[] = [
    {
      id: 'r1',
      title: 'Suplementación con 3‑NOP (Bovaer®) en animales en producción',
      expected_reduction_pct: 25,
      difficulty: 'media',
      status: 'pendiente',
      short: 'Reduce metano entérico inhibiendo la enzima clave en la metanogénesis. Recomendado para lotes con dieta estable.',
      response: {
        resumen:
          'Implementar 3‑NOP en el concentrado de animales en producción para reducir emisiones entéricas sin afectar el desempeño cuando se dosifica correctamente.',
        porQueFunciona: [
          'Bloquea parcialmente la formación de metano en el rumen (reduce CH₄ por unidad de alimento).',
          'Suele mantener (o mejorar ligeramente) la eficiencia energética al disminuir pérdidas como CH₄.',
        ],
        pasos: [
          'Selecciona un lote piloto (30–60 días) con dieta estable.',
          'Asegura mezclado homogéneo en el concentrado y control de consumo.',
          'Monitorea consumo, condición corporal y producción.',
          'Escala gradualmente a más lotes si los indicadores se mantienen.',
        ],
        riesgos: [
          'Efecto menor si la dieta es muy variable o si el consumo del concentrado es irregular.',
          'Costo por cabeza puede ser significativo: prioriza animales con mayor impacto.',
        ],
        metricas: [
          'CH₄ promedio (ppm) en sensores cercanos a comederos/corrales.',
          'Consumo de concentrado (kg/día) y variación entre animales.',
          'Producción/ganancia de peso y condición corporal.',
        ],
        costoTiempo: ['Piloto: 2 semanas de preparación + 4–8 semanas de ejecución.', 'Costo: medio/alto, depende del proveedor y dosis.'],
      },
    },
    {
      id: 'r2',
      title: 'Lino (linaza) en ración para elevar ácidos grasos insaturados',
      expected_reduction_pct: 15,
      difficulty: 'facil',
      status: 'aplicada',
      short: 'Aumenta lípidos insaturados en la dieta, desplazando parte de la fermentación productora de metano.',
      response: {
        resumen:
          'Incorporar linaza o subproductos ricos en lípidos insaturados en la ración para reducir emisiones y, en algunos casos, mejorar la energía de la dieta.',
        porQueFunciona: [
          'Los lípidos pueden reducir la producción de hidrógeno disponible para metanógenos.',
          'Puede disminuir la digestión de fibra si se excede: requiere balance.',
        ],
        pasos: [
          'Define un porcentaje objetivo en materia seca con un nutricionista.',
          'Introduce de forma gradual (7–10 días) para evitar rechazo.',
          'Ajusta fibra efectiva para mantener rumia adecuada.',
        ],
        riesgos: ['Excesos de grasa pueden afectar digestión de fibra y consumo.', 'Necesita control de calidad para evitar rancidez.'],
        metricas: ['Consumo diario', 'Variación de CH₄ en horas post-alimentación', 'Condición ruminal (observación y registros).'],
        costoTiempo: ['Implementación: 1–2 semanas.', 'Costo: bajo/medio (según disponibilidad local).'],
      },
    },
    {
      id: 'r3',
      title: 'Rotación intensiva de potreros con descansos medidos',
      expected_reduction_pct: 12,
      difficulty: 'alta',
      status: 'pendiente',
      short: 'Mejora calidad del forraje y eficiencia, reduce CH₄ por unidad de producto. Requiere manejo y cercas.',
      response: {
        resumen:
          'Aplicar rotación intensiva para mantener pasto en estado vegetativo, mejorando digestibilidad y reduciendo emisiones por kg de carne/leche.',
        porQueFunciona: [
          'Forraje más digestible suele reducir CH₄ por unidad de energía ingerida.',
          'Mejora desempeño animal (más ganancia/producción con el mismo tiempo).',
        ],
        pasos: [
          'Divide potreros y define carga animal por franja.',
          'Define altura de entrada/salida (regla simple: no “raspar” el potrero).',
          'Registra días de descanso y ajusta según lluvias.',
        ],
        riesgos: ['Sobrecarga puede degradar el suelo y empeorar emisiones a mediano plazo.', 'Requiere agua y sombra planificada.'],
        metricas: ['Altura de pasto', 'Días de descanso', 'Ganancia diaria/peso', 'Tendencia CH₄ en sensores perimetrales.'],
        costoTiempo: ['Diseño y cercas: 2–6 semanas.', 'Costo: medio/alto (infraestructura).'],
      },
    },
    {
      id: 'r4',
      title: 'Taninos condensados (Acacia / leguminosas con taninos)',
      expected_reduction_pct: 10,
      difficulty: 'media',
      status: 'descartada',
      short: 'Los taninos pueden modular fermentación ruminal y reducir metano, con cuidado para no afectar consumo.',
      response: {
        resumen:
          'Introducir fuentes de taninos condensados como aditivo o mediante forrajes específicos para reducir CH₄ y, en ocasiones, mejorar el uso de proteína.',
        porQueFunciona: [
          'Modula microorganismos ruminales, reduciendo metanogénesis.',
          'Puede disminuir degradación ruminal de proteína (mejor aprovechamiento).',
        ],
        pasos: [
          'Inicia con dosis baja y evalúa consumo.',
          'Preferir lotes con dieta estable para medir efecto.',
          'Revisa interacción con otros aditivos (evita duplicar efectos).',
        ],
        riesgos: ['Exceso reduce palatabilidad y digestibilidad.', 'Variabilidad de extractos/forraje según origen.'],
        metricas: ['Consumo', 'Variación de CH₄ en periodos definidos', 'Indicadores productivos.'],
        costoTiempo: ['Piloto: 4 semanas.', 'Costo: medio.'],
      },
    },
    {
      id: 'r5',
      title: 'Mejora de calidad de forraje (fertilización y corte/pastoreo oportuno)',
      expected_reduction_pct: 8,
      difficulty: 'facil',
      status: 'aplicada',
      short: 'Forraje joven y bien nutrido suele ser más digestible: menos metano por unidad producida.',
      response: {
        resumen:
          'Optimizar fertilización, manejo de corte y ventanas de pastoreo para sostener alta digestibilidad del forraje durante el año.',
        porQueFunciona: [
          'Mayor digestibilidad reduce pérdidas de energía como CH₄.',
          'Suele aumentar consumo útil y desempeño del animal.',
        ],
        pasos: ['Haz un diagnóstico básico del suelo.', 'Ajusta fertilización y calendario de manejo.', 'Prioriza áreas críticas cercanas a corrales.'],
        riesgos: ['Fertilización sin diagnóstico puede ser ineficiente o contaminar.', 'Ventanas mal manejadas reducen persistencia del pasto.'],
        metricas: ['Producción de forraje', 'Condición corporal', 'Tendencia CH₄ estacional.'],
        costoTiempo: ['Implementación: 2–4 semanas.', 'Costo: bajo/medio.'],
      },
    },
    {
      id: 'r6',
      title: 'Aditivo en agua en lote control (ensayo 30 días)',
      expected_reduction_pct: 5,
      difficulty: 'media',
      status: 'pendiente',
      short: 'Ensayo controlado con aditivos solubles; útil cuando el suministro de concentrado es limitado.',
      response: {
        resumen:
          'Probar un aditivo soluble en agua en un lote control, comparando contra un lote similar sin aditivo para estimar efecto real.',
        porQueFunciona: [
          'Permite entrega diaria sin depender del consumo de concentrado.',
          'Facilita control experimental si hay bebederos separados.',
        ],
        pasos: [
          'Define lote control y lote tratamiento (mismo tamaño y manejo).',
          'Calibra dosificación por volumen de agua.',
          'Registra consumo de agua y eventos de lluvia/temperatura.',
        ],
        riesgos: ['Variabilidad alta si el agua no se consume uniformemente.', 'Posibles rechazos por sabor.'],
        metricas: ['Consumo de agua', 'CH₄ en horas cercanas al bebedero', 'Productividad (peso/condición).'],
        costoTiempo: ['Preparación: 1 semana.', 'Ensayo: 4 semanas.', 'Costo: medio.'],
      },
    },
    {
      id: 'r7',
      title: 'Sombras y bebederos estratégicos para reducir estrés térmico',
      expected_reduction_pct: 6.5,
      difficulty: 'facil',
      status: 'aplicada',
      short: 'Menos estrés → mejor eficiencia → menos emisiones por unidad. También ordena la distribución del rebaño.',
      response: {
        resumen:
          'Instalar/optimizar sombras y acceso a agua para reducir estrés térmico, sostener consumo y mejorar eficiencia en horas críticas.',
        porQueFunciona: [
          'Con estrés térmico baja el consumo y cambia la fermentación.',
          'Mejor bienestar puede mejorar conversión y reducir emisiones por unidad producida.',
        ],
        pasos: ['Ubica zonas de alta permanencia y corrige puntos sin sombra.', 'Asegura caudal de agua.', 'Evita “barro crónico” alrededor de bebederos.'],
        riesgos: ['Concentración excesiva puede degradar suelo si no se maneja.', 'Requiere mantenimiento continuo.'],
        metricas: ['Tiempo en sombra (observación)', 'Consumo en horas de calor', 'CH₄ en picos diarios.'],
        costoTiempo: ['Implementación: 1–3 semanas.', 'Costo: bajo/medio.'],
      },
    },
    {
      id: 'r8',
      title: 'Selección de animales y manejo de reemplazos (eficiencia)',
      expected_reduction_pct: 7,
      difficulty: 'alta',
      status: 'descartada',
      short: 'A mediano plazo: mantener animales más eficientes reduce emisiones por kg producido.',
      response: {
        resumen:
          'Orientar reemplazos y decisiones de descarte hacia animales con mejor eficiencia (peso/producción por unidad de alimento) para disminuir la intensidad de emisiones.',
        porQueFunciona: [
          'La intensidad de CH₄ baja cuando sube la productividad por animal.',
          'Mejor eficiencia reduce días “improductivos” por kg producido.',
        ],
        pasos: [
          'Define métricas simples: ganancia/peso/edad al destete, intervalos reproductivos.',
          'Registra y clasifica animales (top, medio, bajo).',
          'Decide reemplazos y descartes con criterio económico + emisiones.',
        ],
        riesgos: ['Requiere disciplina de registro.', 'Efecto no es inmediato.'],
        metricas: ['Edad al destete', 'Ganancia diaria', 'Tasa de preñez', 'Tendencia anual de CH₄ por kg producido (estimada).'],
        costoTiempo: ['Implementación: 2–3 meses para ver señal.', 'Costo: medio (gestión y registros).'],
      },
    },
  ];

  protected readonly expandedAiRecId = signal<string | null>(null);

  protected readonly filteredAiRecs = computed(() => {
    const f = this.aiRecFilter();
    if (f === 'todas') return this.aiRecs;
    return this.aiRecs.filter(r => r.status === f);
  });

  protected readonly dashboardAiRec = computed(() => {
    const farmId = this.selectedFarmId() ?? 1;
    const idx = Math.abs(Number(farmId)) % this.aiRecs.length;
    return this.aiRecs[idx];
  });

  protected readonly googleMapsApiKey = signal<string | null>(null);
  protected readonly googleMapsQuery = computed(() => {
    const f = this.selectedFarm();
    const u = this.profile()?.user;
    const parts = [f?.name, f?.location, u?.location].filter(Boolean);
    return parts.length ? String(parts.join(', ')) : 'Córdoba, Colombia';
  });
  protected readonly googleMapsEmbedUrl = computed<SafeResourceUrl | null>(() => {
    const key = (this.googleMapsApiKey() ?? '').trim();
    if (!key) return null;
    const q = encodeURIComponent(this.googleMapsQuery());
    const url = `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key)}&q=${q}` as const;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  ngOnInit(): void {
    if (this.auth.isLoggedIn()) {
      this.bootstrapAfterAuth();
    } else {
      this.authScreen.set(true);
      this.authStep.set('welcome');
    }
  }

  private bootstrapAfterAuth(): void {
    this.authScreen.set(false);
    this.api.profile().subscribe({
      next: p => {
        this.profile.set(p);
        this.api.config().subscribe({
          next: cfg => this.googleMapsApiKey.set(cfg.googleMapsApiKey),
          error: () => this.googleMapsApiKey.set(null),
        });
        const admin = (p.user?.account_type ?? 'ganadero') === 'admin';
        if (admin) {
          this.layoutMode.set('admin');
          this.adminTab.set('panel');
          this.previewOwnerLabel.set(null);
          this.farms.set([]);
          this.selectedFarmId.set(null);
          this.dashboard.set(null);
          this.sensors.set([]);
          this.reports.set(null);
          this.farmRecommendations.set([]);
          this.selectedFarmRecDetailId.set(null);
          this.loadAdminData();
        } else {
          this.layoutMode.set('ganadero');
          this.api.listFarms().subscribe({
            next: rows => {
              this.farms.set(rows);
              const cur = this.selectedFarmId();
              if (rows.length === 0) {
                this.selectedFarmId.set(null);
              } else if (!cur || !rows.some(r => r.id === cur)) {
                this.selectedFarmId.set(rows[0].id);
              }
              this.refreshAll();
            },
            error: () => this.failSession(),
          });
        }
      },
      error: () => this.failSession(),
    });
  }

  protected loadAdminData(): void {
    if (!this.isAdminUser()) return;
    this.adminLoadError.set(null);
    forkJoin({
      overview: this.api.adminOverview(),
      users: this.api.adminUsers(),
      farms: this.api.adminFarms(),
      sensors: this.api.adminSensors(),
      reports: this.api.adminReportsSummary(),
      config: this.api.adminConfigSummary(),
    }).subscribe({
      next: v => {
        this.adminOverview.set(v.overview);
        this.adminUsers.set(v.users);
        this.adminFarms.set(v.farms);
        this.adminSensors.set(v.sensors);
        this.adminReports.set(v.reports);
        this.adminConfig.set(v.config);
      },
      error: err => {
        const msg = err?.error?.error ?? 'No se pudieron cargar los datos de administración';
        this.adminLoadError.set(msg);
      },
    });
  }

  protected navigateAdmin(tab: AdminTab): void {
    this.adminTab.set(tab);
  }

  protected openFarmAsOperator(row: AdminFarmRow): void {
    const owner = [row.owner_name, row.owner_email].filter(Boolean).join(' · ');
    this.api.adminUserFarms(row.user_id).subscribe({
      next: rows => {
        this.farms.set(rows);
        this.selectedFarmId.set(row.id);
        this.layoutMode.set('ganadero');
        this.previewOwnerLabel.set(owner || null);
        this.refreshAll();
        this.navigate('inicio');
      },
      error: () => {
        const farm: Farm = {
          id: row.id,
          user_id: row.user_id,
          name: row.name,
          location: row.location,
          area_ha: row.area_ha,
          heads_active: row.heads_active,
          breeds_text: row.breeds_text,
          thermal_floor: row.thermal_floor,
          altitude_m: row.altitude_m,
          production_model: row.production_model,
          certification_step: row.certification_step,
        };
        this.farms.set([farm]);
        this.selectedFarmId.set(farm.id);
        this.layoutMode.set('ganadero');
        this.previewOwnerLabel.set(owner || null);
        this.refreshAll();
        this.navigate('inicio');
      },
    });
  }

  protected backToAdminPanel(): void {
    this.layoutMode.set('admin');
    this.previewOwnerLabel.set(null);
    this.farms.set([]);
    this.selectedFarmId.set(null);
    this.pendingFarmId.set(null);
    this.dashboard.set(null);
    this.sensors.set([]);
    this.reports.set(null);
    this.farmRecommendations.set([]);
    this.selectedFarmRecDetailId.set(null);
    this.screen.set('inicio');
    this.loadAdminData();
  }

  private failSession(): void {
    this.auth.clearSession();
    this.authScreen.set(true);
    this.authStep.set('welcome');
    this.profile.set(null);
    this.farms.set([]);
    this.selectedFarmId.set(null);
    this.dashboard.set(null);
    this.sensors.set([]);
    this.reports.set(null);
    this.farmRecommendations.set([]);
    this.selectedFarmRecDetailId.set(null);
    this.layoutMode.set('ganadero');
    this.previewOwnerLabel.set(null);
    this.adminLoadError.set(null);
  }

  protected setAuthTab(tab: 'login' | 'register'): void {
    this.authTab.set(tab);
    this.authError.set(null);
  }

  protected submitLogin(): void {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }
    this.authBusy.set(true);
    this.authError.set(null);
    const v = this.loginForm.getRawValue();
    this.api.login(v).subscribe({
      next: res => {
        this.auth.setSession(res.token);
        this.authBusy.set(false);
        this.bootstrapAfterAuth();
      },
      error: err => {
        this.authBusy.set(false);
        const msg = err?.error?.error ?? 'No se pudo iniciar sesión';
        this.authError.set(msg);
      },
    });
  }

  protected submitRegister(): void {
    if (this.registerForm.invalid) {
      this.registerForm.markAllAsTouched();
      return;
    }
    this.authBusy.set(true);
    this.authError.set(null);
    const v = this.registerForm.getRawValue();
    this.api
      .register({
        email: v.email.trim(),
        password: v.password,
        full_name: v.full_name.trim(),
        location: v.location.trim() || undefined,
      })
      .subscribe({
        next: res => {
          this.auth.setSession(res.token);
          this.authBusy.set(false);
          this.bootstrapAfterAuth();
        },
        error: err => {
          this.authBusy.set(false);
          const msg = err?.error?.error ?? 'No se pudo registrar';
          this.authError.set(msg);
        },
      });
  }

  protected logout(): void {
    this.api
      .logout()
      .pipe(finalize(() => this.clearLocalAfterLogout()))
      .subscribe({ error: () => {} });
  }

  private clearLocalAfterLogout(): void {
    this.auth.clearSession();
    this.authScreen.set(true);
    this.authStep.set('welcome');
    this.profile.set(null);
    this.farms.set([]);
    this.selectedFarmId.set(null);
    this.pendingFarmId.set(null);
    this.dashboard.set(null);
    this.sensors.set([]);
    this.reports.set(null);
    this.farmRecommendations.set([]);
    this.selectedFarmRecDetailId.set(null);
    this.screen.set('inicio');
    this.layoutMode.set('ganadero');
    this.previewOwnerLabel.set(null);
    this.adminLoadError.set(null);
    this.adminOverview.set(null);
    this.adminUsers.set([]);
    this.adminFarms.set([]);
    this.adminSensors.set([]);
    this.adminReports.set(null);
    this.adminConfig.set(null);
    this.loginForm.reset();
    this.registerForm.reset();
  }

  protected openCredentialsEditor(): void {
    const email = this.profile()?.user?.email ?? '';
    this.credentialsForm.patchValue({ email, current_password: '', new_password: '' });
    this.credentialsMessage.set(null);
    this.showCredentialsEditor.set(true);
  }

  protected closeCredentialsEditor(): void {
    this.showCredentialsEditor.set(false);
    this.credentialsMessage.set(null);
  }

  protected submitCredentials(): void {
    if (this.credentialsForm.invalid) {
      this.credentialsForm.markAllAsTouched();
      return;
    }
    const v = this.credentialsForm.getRawValue();
    const emailNext = v.email.trim();
    const newPwd = v.new_password.trim();
    const payload: { current_password: string; email?: string; new_password?: string } = {
      current_password: v.current_password,
    };
    const currentEmail = (this.profile()?.user?.email ?? '').trim().toLowerCase();
    if (emailNext && emailNext.toLowerCase() !== currentEmail) {
      payload.email = emailNext;
    }
    if (newPwd) {
      if (newPwd.length < 6) {
        this.credentialsMessage.set({ type: 'err', text: 'La nueva contraseña debe tener al menos 6 caracteres.' });
        return;
      }
      payload.new_password = newPwd;
    }
    if (!payload.email && !payload.new_password) {
      this.credentialsMessage.set({ type: 'err', text: 'Indica un nuevo email o una nueva contraseña.' });
      return;
    }

    this.credentialsBusy.set(true);
    this.credentialsMessage.set(null);
    this.api.updateProfile(payload).subscribe({
      next: p => {
        this.profile.set(p);
        this.credentialsBusy.set(false);
        this.credentialsMessage.set({ type: 'ok', text: 'Cambios guardados correctamente.' });
        this.credentialsForm.patchValue({ current_password: '', new_password: '' });
      },
      error: err => {
        this.credentialsBusy.set(false);
        const msg = err?.error?.error ?? 'No se pudo actualizar';
        this.credentialsMessage.set({ type: 'err', text: msg });
      },
    });
  }

  protected openProfileEditor(): void {
    const u = this.profile()?.user;
    const f = this.selectedFarm();
    if (!u) return;
    if (this.layoutMode() === 'admin') {
      this.openAdminProfileEditor();
      return;
    }
    if (!f) return;

    this.adminProfileEditorOnly.set(false);
    this.profileEditMessage.set(null);
    this.profileEditForm.patchValue({
      full_name: u.full_name ?? '',
      role: u.role ?? 'Ganadero',
      user_location: u.location ?? '',
      farm_name: f.name ?? '',
      farm_location: f.location ?? '',
      area_ha: Number(f.area_ha ?? 0),
      heads_active: Number(f.heads_active ?? 0),
      breeds_text: (f as any).breeds_text ?? '',
      thermal_floor: (f as any).thermal_floor ?? '',
      altitude_m: Number((f as any).altitude_m ?? 0),
      production_model: (f as any).production_model ?? '',
    });
    this.showProfileEditor.set(true);
  }

  protected closeProfileEditor(): void {
    this.showProfileEditor.set(false);
    this.profileEditMessage.set(null);
    this.adminProfileEditorOnly.set(false);
  }

  protected submitProfileEdit(): void {
    if (this.profileEditForm.invalid) {
      this.profileEditForm.markAllAsTouched();
      return;
    }
    const v = this.profileEditForm.getRawValue();
    this.profileEditBusy.set(true);
    this.profileEditMessage.set(null);

    if (this.adminProfileEditorOnly()) {
      this.api
        .updateProfileDetails({
          full_name: v.full_name.trim(),
          role: v.role.trim(),
          location: v.user_location.trim() || null,
        })
        .subscribe({
          next: p => {
            this.profile.set(p);
            this.profileEditBusy.set(false);
            this.profileEditMessage.set({ type: 'ok', text: 'Perfil actualizado correctamente.' });
          },
          error: err => {
            this.profileEditBusy.set(false);
            const msg = err?.error?.error ?? 'No se pudo actualizar el perfil';
            this.profileEditMessage.set({ type: 'err', text: msg });
          },
        });
      return;
    }

    const farm = this.selectedFarm();
    if (!farm) {
      this.profileEditBusy.set(false);
      return;
    }

    this.api
      .updateProfileDetails({
        full_name: v.full_name.trim(),
        role: v.role.trim(),
        location: v.user_location.trim() || null,
      })
      .subscribe({
        next: p => {
          this.profile.set(p);
          this.api
            .updateFarm(farm.id, {
              name: v.farm_name.trim(),
              location: v.farm_location.trim() || null,
              area_ha: Number(v.area_ha) || null,
              heads_active: Number(v.heads_active) || 0,
              breeds_text: v.breeds_text.trim() || null,
              thermal_floor: v.thermal_floor.trim() || null,
              altitude_m: Number(v.altitude_m) || null,
              production_model: v.production_model.trim() || null,
            })
            .subscribe({
              next: updated => {
                const next = this.farms().map(ff => (ff.id === updated.id ? { ...ff, ...updated } : ff));
                this.farms.set(next);
                this.profileEditBusy.set(false);
                this.profileEditMessage.set({ type: 'ok', text: 'Perfil actualizado correctamente.' });
              },
              error: err => {
                this.profileEditBusy.set(false);
                const msg = err?.error?.error ?? 'No se pudo actualizar la finca';
                this.profileEditMessage.set({ type: 'err', text: msg });
              },
            });
        },
        error: err => {
          this.profileEditBusy.set(false);
          const msg = err?.error?.error ?? 'No se pudo actualizar el perfil';
          this.profileEditMessage.set({ type: 'err', text: msg });
        },
      });
  }

  protected navigate(id: 'inicio' | 'sensores' | 'reportes' | 'recomendaciones' | 'perfil') {
    this.screen.set(id);
    if (id !== 'recomendaciones') {
      this.selectedFarmRecDetailId.set(null);
    }
  }

  protected selectFarm(farmId: number): void {
    if (!this.farms().some(f => f.id === farmId)) return;
    this.selectedFarmId.set(farmId);
    this.refreshAll();
  }

  protected toggleAdminUserRow(userId: number): void {
    if (this.expandedAdminUserId() === userId) {
      this.expandedAdminUserId.set(null);
      this.adminUserImpact.set(null);
      this.adminUserAuditDetail.set([]);
      return;
    }
    this.expandedAdminUserId.set(userId);
    this.adminUserDetailBusy.set(true);
    this.adminUserImpact.set(null);
    this.adminUserAuditDetail.set([]);
    forkJoin({
      impact: this.api.adminUserImpact(userId),
      audit: this.api.adminUserAuditLog(userId),
    }).subscribe({
      next: v => {
        this.adminUserImpact.set(v.impact);
        this.adminUserAuditDetail.set(v.audit);
        this.adminUserDetailBusy.set(false);
      },
      error: () => {
        this.adminUserDetailBusy.set(false);
        this.adminUserImpact.set(null);
        this.adminUserAuditDetail.set([]);
      },
    });
  }

  protected toggleAdminFarmRow(farmId: number): void {
    if (this.expandedAdminFarmId() === farmId) {
      this.expandedAdminFarmId.set(null);
      this.adminFarmReportsExtra.set(null);
      return;
    }
    this.expandedAdminFarmId.set(farmId);
    this.adminFarmDetailBusy.set(true);
    this.adminFarmReportsExtra.set(null);
    this.api.reports(farmId).subscribe({
      next: r => {
        this.adminFarmReportsExtra.set(r);
        this.adminFarmDetailBusy.set(false);
      },
      error: () => {
        this.adminFarmDetailBusy.set(false);
        this.adminFarmReportsExtra.set(null);
      },
    });
  }

  protected co2eqBarsFromSeries(series: { month: string; co2eq_reduced_t: number }[]) {
    const values = series.map(s => s.co2eq_reduced_t);
    const max = Math.max(...values, 0.001);
    return series.map(s => ({
      month: new Date(String(s.month)).toLocaleDateString('es-CO', { month: 'short' }),
      value: s.co2eq_reduced_t,
      h: Math.round((s.co2eq_reduced_t / max) * 110),
    }));
  }

  protected ch4EqBarsFromImpact(series: { month: string; ch4_eq_reduced_kg: number }[]) {
    const values = series.map(s => s.ch4_eq_reduced_kg);
    const max = Math.max(...values, 0.001);
    return series.map(s => ({
      month: new Date(String(s.month)).toLocaleDateString('es-CO', { month: 'short' }),
      value: s.ch4_eq_reduced_kg,
      h: Math.round((s.ch4_eq_reduced_kg / max) * 110),
    }));
  }

  protected farmMapEmbedUrl(farm: AdminFarmRow): SafeResourceUrl | null {
    const key = (this.googleMapsApiKey() ?? '').trim();
    if (!key) return null;
    const q = encodeURIComponent([farm.name, farm.location].filter(Boolean).join(', ') || 'Colombia');
    const url = `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key)}&q=${q}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  protected openAdminUserEditor(u: AdminUserRow, ev?: Event): void {
    ev?.stopPropagation?.();
    this.adminUserEditorMessage.set(null);
    this.adminUserEditorId.set(u.id);
    this.adminUserEditForm.patchValue({
      full_name: u.full_name,
      email: (u.email ?? '').trim(),
      role: u.role,
      location: u.location ?? '',
      account_type: (u.account_type ?? 'ganadero') as 'admin' | 'ganadero',
      new_password: '',
    });
    this.showAdminUserEditor.set(true);
  }

  protected closeAdminUserEditor(): void {
    this.showAdminUserEditor.set(false);
    this.adminUserEditorId.set(null);
    this.adminUserEditorMessage.set(null);
  }

  protected submitAdminUserEditor(): void {
    if (this.adminUserEditForm.invalid) {
      this.adminUserEditForm.markAllAsTouched();
      return;
    }
    const id = this.adminUserEditorId();
    if (!id) return;
    const v = this.adminUserEditForm.getRawValue();
    const payload: {
      full_name: string;
      role: string;
      location: string | null;
      email: string;
      account_type: 'admin' | 'ganadero';
      new_password?: string;
    } = {
      full_name: v.full_name.trim(),
      role: v.role.trim(),
      location: v.location.trim() || null,
      email: v.email.trim(),
      account_type: v.account_type,
    };
    const np = v.new_password.trim();
    if (np) payload.new_password = np;

    this.adminUserEditorBusy.set(true);
    this.adminUserEditorMessage.set(null);
    this.api.adminUpdateUser(id, payload).subscribe({
      next: () => {
        this.adminUserEditorBusy.set(false);
        this.closeAdminUserEditor();
        this.loadAdminData();
      },
      error: err => {
        this.adminUserEditorBusy.set(false);
        this.adminUserEditorMessage.set(err?.error?.error ?? 'No se pudo guardar');
      },
    });
  }

  protected deleteAdminUserFromEditor(): void {
    const id = this.adminUserEditorId();
    if (!id) return;
    if (!confirm('¿Eliminar este usuario y todas sus fincas asociadas?')) return;
    this.adminUserEditorBusy.set(true);
    this.api.adminDeleteUser(id).subscribe({
      next: () => {
        this.adminUserEditorBusy.set(false);
        this.closeAdminUserEditor();
        this.expandedAdminUserId.set(null);
        this.loadAdminData();
      },
      error: err => {
        this.adminUserEditorBusy.set(false);
        this.adminUserEditorMessage.set(err?.error?.error ?? 'No se pudo eliminar');
      },
    });
  }

  protected openAdminProfileEditor(): void {
    const u = this.profile()?.user;
    if (!u) return;
    this.adminProfileEditorOnly.set(true);
    this.profileEditMessage.set(null);
    this.profileEditForm.patchValue({
      full_name: u.full_name ?? '',
      role: u.role ?? 'Administración',
      user_location: u.location ?? '',
      farm_name: '',
      farm_location: '',
      area_ha: 0,
      heads_active: 0,
      breeds_text: '',
      thermal_floor: '',
      altitude_m: 0,
      production_model: '',
    });
    this.showProfileEditor.set(true);
  }

  protected refreshAll() {
    const farmId = this.selectedFarmId();
    if (farmId == null) return;
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
    this.api.reports(farmId).subscribe(r => this.reports.set(r));
    this.api.listRecommendations(farmId).subscribe({
      next: rows => this.farmRecommendations.set(rows),
      error: () => this.farmRecommendations.set([]),
    });
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

  protected readonly recStatusLabel: Record<RecStatus, string> = {
    pendiente: 'Pendiente',
    aplicada: 'Implementada',
    descartada: 'Descartada',
  };

  protected setRecListFilter(f: 'todas' | 'pendiente' | 'aplicada' | 'descartada'): void {
    this.recListFilter.set(f);
  }

  protected openFarmRecDetail(farmRecId: number): void {
    this.selectedFarmRecDetailId.set(farmRecId);
  }

  protected closeFarmRecDetail(): void {
    this.selectedFarmRecDetailId.set(null);
  }

  protected difficultyLabel(d: Difficulty): string {
    const m: Record<Difficulty, string> = { facil: 'Fácil', media: 'Media', alta: 'Alta' };
    return m[d] ?? d;
  }

  protected recStatusBadgeClasses(status: RecStatus): string {
    const suf = status === 'pendiente' ? 'pending' : status === 'aplicada' ? 'applied' : 'rejected';
    return `badge ${suf}`;
  }

  /** Bloques de texto estilo “respuesta de IA” con cifras del predio y del tablero. */
  protected farmRecommendationAiNarrative(rd: FarmRecommendationRow): { heading: string; paragraphs: string[]; list?: string[] }[] {
    const farm = this.selectedFarm();
    const dash = this.dashboard();
    const sensors = this.sensors();
    const heads = Math.max(1, farm?.heads_active ?? dash?.headsActive ?? 1);
    const areaHa =
      farm?.area_ha != null && !Number.isNaN(Number(farm.area_ha)) ? Number(farm.area_ha) : null;
    const name = farm?.name?.trim() || 'Tu finca';
    const loc = farm?.location?.trim();
    const breeds = farm?.breeds_text?.trim();
    const model = farm?.production_model?.trim();
    const pctRaw = rd.expected_reduction_pct != null ? Number(rd.expected_reduction_pct) : NaN;
    const pctDisp = Number.isFinite(pctRaw) ? pctRaw : 12;
    const emissionsToday = dash?.emissionsTodayKg ?? 0;
    const em24 = dash?.emissions24h ?? [];
    const sum24 = em24.reduce((a, x) => a + x.kg_ch4, 0);
    const avgHourly = em24.length > 0 ? sum24 / em24.length : emissionsToday > 0 ? emissionsToday / 24 : 0;
    const baselineDaily = emissionsToday > 0 ? emissionsToday : avgHourly * 24;
    const deltaCh4 = baselineDaily * (pctDisp / 100);
    const co2eqKgDay = deltaCh4 * 28;

    const locPhrase = loc ? ` (${loc})` : '';
    const pilotHeads = Math.max(12, Math.min(heads, Math.round(heads * (0.13 + (rd.farm_rec_id % 7) * 0.015))));
    const pilotPct = (pilotHeads / heads) * 100;
    const phaseDays = 18 + (rd.recommendation_id % 14);
    const reviewDays = 7 + (rd.farm_rec_id % 5);
    const doseNote = rd.notes?.trim();
    const m2PerHead =
      areaHa != null && areaHa > 0 ? Math.round(((areaHa * 10000) / heads) * 10) / 10 : null;
    const alertSensors = sensors.filter(s => s.status === 'alerta').length;
    const fmt = (n: number, d = 2) =>
      Number.isFinite(n) ? n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

    const ctx: string[] = [];
    ctx.push(
      `Se analiza la recomendación «${rd.title}» aplicada a ${name}${locPhrase}, con ${heads.toLocaleString('es-CO')} cabezas registradas en el sistema.`
    );
    if (areaHa != null) {
      ctx.push(
        `Superficie declarada: ${fmt(areaHa, 1)} ha` +
          (m2PerHead != null ? ` (aprox. ${fmt(m2PerHead, 1)} m²/cabeza a campo).` : '.')
      );
    }
    if (breeds) ctx.push(`Composición racial declarada: ${breeds}.`);
    if (model) ctx.push(`Modelo productivo: ${model}.`);

    const paramList: string[] = [
      `Cabezas de referencia para el cálculo: ${heads.toLocaleString('es-CO')}.`,
      `Lote piloto sugerido (antes de escalar al 100%): ${pilotHeads.toLocaleString('es-CO')} animales (${fmt(pilotPct, 1)} % del rodeo).`,
      `Ventana de implementación tipo: ${phaseDays} días de fase activa + ${reviewDays} días de revisión nutricional o de manejo.`,
      `Dificultad operativa calificada como ${this.difficultyLabel(rd.difficulty)} (ajuste de mano de obra, infraestructura y riesgo de desviación).`,
    ];
    if (doseNote) {
      paramList.unshift(`Parámetro o nota técnica del catálogo: ${doseNote}.`);
    } else {
      paramList.push(
        `No hay una dosis escrita en el catálogo para esta ficha: conviene acordar materia seca, consumo y forraje disponible con un asesor zootécnico antes de fijar gramos por cabeza.`
      );
    }

    const impact: string[] = [];
    impact.push(
      `La ficha indica una reducción relativa de emisiones de metano entérico del orden del ${fmt(pctDisp, 2)} % respecto al escenario base, manteniendo el resto de variables de producción estables.`
    );
    if (baselineDaily > 0) {
      impact.push(
        `Tomando como referencia las emisiones agregadas del predio (${fmt(baselineDaily, 2)} kg CH₄/día ` +
          `${emissionsToday > 0 ? 'según el acumulado «hoy» del tablero' : 'estimadas a partir del promedio horario de las últimas 24 h'}), ` +
          `una fracción del ${fmt(pctDisp, 2)} % se traduce en un orden de magnitud de ${fmt(deltaCh4, 3)} kg CH₄/día evitados en ese mismo baseline.`
      );
      impact.push(
        `A título ilustrativo (factor GWP₁₀₀ de 28 kg CO₂eq por kg CH₄, simplificado para comunicación), sería del orden de ${fmt(co2eqKgDay, 1)} kg CO₂eq/día asociados a esa misma fracción de metano.`
      );
    } else {
      impact.push(
        `Aún no hay una línea base de kg CH₄/día suficientemente estable en el tablero; cuando existan series de 24 h o el acumulado diario, se podrá acotar el ahorro absoluto en kg CH₄/día y no solo el porcentaje (${fmt(pctDisp, 2)} %).`
      );
    }

    const monitorList: string[] = [
      `Sensores activos en la finca: ${sensors.length}${sensors.length ? ` (${alertSensors} en alerta)` : ''}.`,
      `Registrar consumo de materia seca (kg/cabeza/día) y condición corporal al inicio, a mitad y al cierre de los ${phaseDays} días.`,
      `Contrastar lecturas de CH₄ cercanas a comederos o corrales con el patrón horario habitual (${em24.length ? `${em24.length} puntos en la curva de 24 h` : 'sin curva de 24 h cargada aún'}).`,
    ];
    if (sum24 > 0 && em24.length) {
      monitorList.push(
        `Promedio horario reciente (serie cargada): ${fmt(avgHourly, 3)} kg CH₄/h (suma 24 h ≈ ${fmt(sum24, 2)} kg CH₄).`
      );
    }

    const risk: string[] = [];
    if (rd.difficulty === 'alta') {
      risk.push(
        `Intervención alta en complejidad: riesgo elevado de sobrepastoreo, estrés térmico o heterogeneidad entre animales si no se segmentan lotes homogéneos.`
      );
    } else if (rd.difficulty === 'media') {
      risk.push(
        `Complejidad media: el principal riesgo suele ser la variación de la dieta entre días; conviene protocolizar mezclado y orden de ingesta.`
      );
    } else {
      risk.push(
        `Complejidad baja relativa, pero sigue siendo necesario documentar el cambio (lotes, fechas, producto y responsable) para trazabilidad ante auditoría.`
      );
    }
    risk.push(
      `Estado actual de la recomendación en plataforma: ${this.recStatusLabel[rd.status]}. ` +
        (rd.status === 'pendiente'
          ? 'Si se implementa, registre evidencias (pesajes, raciones, fotos de mezclado) antes de marcar cierre en su flujo interno.'
          : rd.status === 'aplicada'
            ? 'Figura como implementada: revise que el monitoreo post-intervención confirme la tendencia esperada en las series.'
            : 'Figura como descartada: conserve el motivo (costo, logística, rechazo al consumo) para futuras priorizaciones.')
    );

    const blocks: { heading: string; paragraphs: string[]; list?: string[] }[] = [
      { heading: 'Contexto del predio (datos operativos)', paragraphs: ctx },
      {
        heading: 'Síntesis técnica (modelo asistido)',
        paragraphs: [
          `La recomendación «${rd.title}» se alinea con prácticas de mitigación de metano ruminal descritas en literatura técnica y en fichas de intervención. ` +
            `El objetivo es reducir la intensidad de emisión (CH₄ por unidad de producto o por día) sin comprometer de forma inaceptable el desempeño productivo, ` +
            `priorizando el lote piloto de ${pilotHeads} cabezas y escalando solo tras ${reviewDays} días de evaluación intermedia.`,
        ],
      },
      { heading: 'Parámetros cuantitativos propuestos', paragraphs: [], list: paramList },
      { heading: 'Impacto esperado (orden de magnitud)', paragraphs: impact },
      { heading: 'Vigilancia y métricas concretas', paragraphs: [], list: monitorList },
      { heading: 'Riesgos, condicionantes y seguimiento', paragraphs: risk },
    ];

    if (doseNote) {
      const m = doseNote.match(/(\d+(?:[.,]\d+)?)\s*mg\s*\/\s*cabeza/i);
      let extraPara = '';
      if (m) {
        const mg = Number(String(m[1]).replace(',', '.'));
        if (Number.isFinite(mg) && mg > 0) {
          const mgPilotDay = mg * pilotHeads;
          const mgHerdDay = mg * heads;
          extraPara =
            ` Si se adopta de forma literal la dosis de ${fmt(mg, 0)} mg/cabeza/día indicada en catálogo, el lote piloto de ${pilotHeads} cabezas representaría un consumo agregado aproximado de ${fmt(mgPilotDay, 0)} mg/día de principio activo a nivel de grupo (≈ ${fmt(mgPilotDay / 1000, 2)} g/día), frente a ${fmt(mgHerdDay, 0)} mg/día (≈ ${fmt(mgHerdDay / 1000, 2)} g/día) si se escalara al 100 % del rodeo (${heads} cabezas). ` +
            `Estas cifras sirven para dimensionar pedidos, mezclas en planta y controles de inventario; la dosificación final debe validarse con el nutricionista según materia seca real ingerida.`;
        }
      }
      blocks.push({
        heading: 'Especificación del catálogo y lectura operativa',
        paragraphs: [
          `El sistema conserva la siguiente anotación asociada a la ficha de catálogo: «${doseNote}». ` +
            `Crúcela con el plan de alimentación real (forraje, concentrado, minerales, agua y sales) y con el registro de consumo por lote antes de ejecutar en campo.${extraPara}`,
        ],
      });
    }

    return blocks;
  }

  protected readonly formatUsd = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

  protected readonly filteredSensors = computed(() => {
    const f = this.sensorFilter();
    const list = this.sensors();
    if (f === 'todos') return list;
    return list.filter(s => s.status === f);
  });

  protected toggleAiRec(id: string): void {
    this.expandedAiRecId.set(this.expandedAiRecId() === id ? null : id);
  }

  protected applyAiRec(id: string): void {
    const r = this.aiRecs.find(x => x.id === id);
    if (!r) return;
    if (r.status !== 'pendiente') return;
    r.status = 'aplicada';
    // fuerza recomputación de signals que dependen del array
    this.expandedAiRecId.set(this.expandedAiRecId());
  }

  protected discardAiRec(id: string): void {
    const r = this.aiRecs.find(x => x.id === id);
    if (!r) return;
    if (r.status !== 'pendiente') return;
    r.status = 'descartada';
    this.expandedAiRecId.set(this.expandedAiRecId());
  }

  protected startLogin(): void {
    this.authStep.set('forms');
    this.setAuthTab('login');
  }

  protected startRegister(): void {
    this.authStep.set('forms');
    this.setAuthTab('register');
  }

  protected backToWelcome(): void {
    this.authStep.set('welcome');
    this.authError.set(null);
  }

  private formatHourLabel(iso: string): string {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    return `${hh}h`;
  }

  protected readonly chartModel = computed(() => {
    const pts = this.dashboard()?.emissions24h ?? [];
    if (pts.length === 0) return null;

    const values = pts.map(p => p.kg_ch4);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);

    const w = 360;
    const h = 150;
    const padL = 38;
    const padR = 10;
    const padT = 10;
    const padB = 38;
    const cw = w - padL - padR;
    const ch = h - padT - padB;
    const span = Math.max(max - min, 0.001);

    const maxVal = max;
    const minVal = min;
    const peakThreshold = min + (max - min) * 0.75;

    const points = pts.map((p, i) => {
      const x = padL + (i * cw) / Math.max(pts.length - 1, 1);
      const y = padT + (1 - (p.kg_ch4 - min) / span) * ch;
      const isMax = p.kg_ch4 === maxVal;
      const isMin = p.kg_ch4 === minVal;
      const isPeak = p.kg_ch4 >= peakThreshold;
      return {
        i,
        x,
        y,
        v: p.kg_ch4,
        hour: this.formatHourLabel(p.hour_ts),
        isMax,
        isMin,
        isPeak,
      };
    });

    const polyline = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    const yTicks = 4;
    const ticksY = Array.from({ length: yTicks + 1 }).map((_, idx) => {
      const t = idx / yTicks;
      const v = min + (1 - t) * (max - min);
      const y = padT + t * ch;
      return { y, label: v.toFixed(1) };
    });

    const ticksXIdx = [0, 6, 12, 18, 23].filter(i => i < points.length);
    const ticksX = ticksXIdx.map(i => ({ x: points[i].x, label: points[i].hour }));

    const avgY = padT + (1 - (avg - min) / span) * ch;

    return {
      w,
      h,
      padL,
      padR,
      padT,
      padB,
      polyline,
      avg,
      avgY,
      min,
      max,
      ticksY,
      ticksX,
      points,
    };
  });

  protected readonly certTypeLabel = 'Gold Standard';
  protected readonly certSteps = [
    { id: 'medicion', label: 'Medición' },
    { id: 'analisis', label: 'Análisis' },
    { id: 'reporte', label: 'Reporte' },
    { id: 'auditoria', label: 'Auditoría externa' },
    { id: 'certifica', label: 'Certificación' },
    { id: 'pago', label: 'Pago / monetización' },
  ] as const;

  protected readonly adminCertStepLabels = [
    'Medición',
    'Análisis',
    'Reporte',
    'Auditoría externa',
    'Certificación',
    'Pago / monetización',
  ] as const;

  protected certTimelineStates(currentStep: number): { label: string; state: 'done' | 'active' | 'todo' }[] {
    const idx = Math.min(Math.max(Math.round(currentStep), 1), 6) - 1;
    return this.adminCertStepLabels.map((label, i) => ({
      label,
      state: i < idx ? 'done' : i === idx ? 'active' : 'todo',
    }));
  }
  protected readonly certCurrentStepIndex = 2; // 0-based: "Reporte" actual

  protected readonly reportActionMessage = signal<string | null>(null);
  protected readonly reportGenerating = signal(false);
  protected readonly todayLabel = new Date().toLocaleDateString('es-CO');
  private async fetchAsDataUrl(path: string): Promise<string | null> {
    try {
      const res = await fetch(path);
      if (!res.ok) return null;
      const blob = await res.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  private certStepState(idx: number): 'done' | 'active' | 'todo' {
    if (idx < this.certCurrentStepIndex) return 'done';
    if (idx === this.certCurrentStepIndex) return 'active';
    return 'todo';
  }

  protected async generateCertificationReport(): Promise<void> {
    if (this.reportGenerating()) return;
    this.reportGenerating.set(true);
    this.reportActionMessage.set(null);

    try {
      const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
      const autoTable = (autoTableMod as any).default ?? autoTableMod;

      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const margin = 42;

      const user = this.profile()?.user ?? null;
      const farm = this.selectedFarm();
      const dash = this.dashboard();
      const sensors = this.sensors();
      const reports = this.reports();

      const now = new Date();
      const stamp = now.toLocaleString('es-CO');
      const farmName = farm?.name ?? '—';
      const location = farm?.location ?? user?.location ?? '—';

      const emissions = dash?.emissions24h ?? [];
      const emValues = emissions.map(e => e.kg_ch4);
      const emAvg = emValues.length ? emValues.reduce((a, b) => a + b, 0) / emValues.length : 0;
      const emMin = emValues.length ? Math.min(...emValues) : 0;
      const emMax = emValues.length ? Math.max(...emValues) : 0;

      const logo = await this.fetchAsDataUrl('logo.png');

      // ── Portada / Encabezado
      doc.setFillColor(15, 61, 42);
      doc.rect(0, 0, pageW, 110, 'F');
      if (logo) {
        try {
          doc.addImage(logo, 'PNG', margin, 26, 48, 48);
        } catch {
          // ignore image errors
        }
      }
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.text('Biofert — Reporte para certificación', margin + 62, 52);
      doc.setFontSize(11);
      doc.text(`Tipo: ${this.certTypeLabel}  ·  Generado: ${stamp}`, margin + 62, 74);

      doc.setTextColor(15, 43, 26);
      doc.setFontSize(12);
      doc.text('Resumen del proyecto', margin, 140);

      const summaryRows = [
        ['Finca', farmName],
        ['Ubicación', location],
        ['Propietario', user?.full_name ?? '—'],
        ['Email', user?.email ?? '—'],
        ['Periodo', 'Últimas 24h (emisiones) · Histórico mensual (CO₂eq)'],
      ];

      autoTable(doc, {
        startY: 150,
        head: [['Campo', 'Valor']],
        body: summaryRows,
        styles: { fontSize: 10, cellPadding: 6 },
        headStyles: { fillColor: [45, 122, 79] },
        margin: { left: margin, right: margin },
        theme: 'grid',
      });

      let y = (doc as any).lastAutoTable?.finalY + 18;

      // ── Estado de certificación
      doc.setFontSize(12);
      doc.text('Estado de certificación', margin, y);
      y += 10;

      const stepsBody = this.certSteps.map((s, idx) => [
        String(idx + 1),
        s.label,
        this.certStepState(idx) === 'done' ? 'Completado' : this.certStepState(idx) === 'active' ? 'Actual' : 'Pendiente',
      ]);

      autoTable(doc, {
        startY: y,
        head: [['#', 'Etapa', 'Estado']],
        body: stepsBody,
        styles: { fontSize: 10, cellPadding: 6 },
        headStyles: { fillColor: [15, 61, 42] },
        margin: { left: margin, right: margin },
        theme: 'grid',
      });

      y = (doc as any).lastAutoTable?.finalY + 18;

      // ── Métricas de impacto
      doc.setFontSize(12);
      doc.text('Métricas de impacto', margin, y);
      y += 10;

      const impactRows = [
        ['CO₂eq reducido total (t)', (reports?.co2eqReducedT ?? 0).toFixed(2)],
        ['Bonos verificados (unid.)', String(reports?.bondsCount ?? 0)],
        ['Valor estimado (USD)', this.formatUsd(reports?.valueEstimatedUsd ?? 0)],
        ['Ingresos acumulados (USD)', this.formatUsd(reports?.revenueAccumUsd ?? 0)],
      ];

      autoTable(doc, {
        startY: y,
        head: [['Indicador', 'Valor']],
        body: impactRows,
        styles: { fontSize: 10, cellPadding: 6 },
        headStyles: { fillColor: [45, 122, 79] },
        margin: { left: margin, right: margin },
        theme: 'grid',
      });

      y = (doc as any).lastAutoTable?.finalY + 18;

      // ── Emisiones últimas 24h
      doc.setFontSize(12);
      doc.text('Emisiones (últimas 24h)', margin, y);
      y += 10;

      const emRows = [
        ['Promedio (kg CH₄/h)', emAvg.toFixed(2)],
        ['Mínimo (kg CH₄/h)', emMin.toFixed(2)],
        ['Máximo (kg CH₄/h)', emMax.toFixed(2)],
        ['Emisiones hoy (kg)', (dash?.emissionsTodayKg ?? 0).toFixed(2)],
      ];

      autoTable(doc, {
        startY: y,
        head: [['Métrica', 'Valor']],
        body: emRows,
        styles: { fontSize: 10, cellPadding: 6 },
        headStyles: { fillColor: [15, 61, 42] },
        margin: { left: margin, right: margin },
        theme: 'grid',
      });

      // Nueva página para tablas largas
      doc.addPage();
      y = margin;

      // ── Inventario de sensores
      doc.setFontSize(12);
      doc.text('Inventario de sensores (IoT)', margin, y);
      y += 10;

      const sensorsBody = sensors.map(s => [
        s.code,
        s.zone,
        s.status,
        `${s.battery_pct}%`,
        s.last_ch4_ppm != null ? String(s.last_ch4_ppm) : '—',
      ]);

      autoTable(doc, {
        startY: y,
        head: [['Código', 'Zona', 'Estado', 'Batería', 'Último CH₄ (ppm)']],
        body: sensorsBody.length ? sensorsBody : [['—', '—', '—', '—', '—']],
        styles: { fontSize: 10, cellPadding: 6 },
        headStyles: { fillColor: [45, 122, 79] },
        margin: { left: margin, right: margin },
        theme: 'grid',
      });

      y = (doc as any).lastAutoTable?.finalY + 18;

      // ── Recomendaciones IA (resumen)
      doc.setFontSize(12);
      doc.text('Recomendaciones IA (resumen)', margin, y);
      y += 10;

      const recsBody = this.aiRecs.map(r => [
        r.title,
        this.recStatusLabel[r.status],
        r.difficulty,
        `-${r.expected_reduction_pct}%`,
      ]);

      autoTable(doc, {
        startY: y,
        head: [['Recomendación', 'Estado', 'Dificultad', 'Reducción esperada']],
        body: recsBody,
        styles: { fontSize: 9, cellPadding: 6 },
        headStyles: { fillColor: [15, 61, 42] },
        margin: { left: margin, right: margin },
        theme: 'grid',
      });

      doc.addPage();
      y = margin;

      // ── CO₂eq por mes
      doc.setFontSize(12);
      doc.text('CO₂eq reducido por mes', margin, y);
      y += 10;

      const byMonth = reports?.co2eqByMonth ?? [];
      const byMonthBody = byMonth.map(m => [
        new Date(String(m.month)).toLocaleDateString('es-CO', { year: 'numeric', month: 'short' }),
        Number(m.co2eq_reduced_t).toFixed(2),
      ]);

      autoTable(doc, {
        startY: y,
        head: [['Mes', 'CO₂eq reducido (t)']],
        body: byMonthBody.length ? byMonthBody : [['—', '0.00']],
        styles: { fontSize: 10, cellPadding: 6 },
        headStyles: { fillColor: [45, 122, 79] },
        margin: { left: margin, right: margin },
        theme: 'grid',
      });

      y = (doc as any).lastAutoTable?.finalY + 18;

      // ── Declaración / firma
      doc.setFontSize(11);
      doc.text('Declaración', margin, y);
      doc.setFontSize(10);
      doc.text(
        'Este reporte consolida datos operativos y métricas de impacto ambiental provenientes del sistema Biofert (sensores IoT, estimaciones de emisiones y agregados mensuales). ' +
          'El documento se presenta como insumo para procesos de certificación, sujeto a auditoría y verificación independiente.',
        margin,
        y + 14,
        { maxWidth: pageW - margin * 2 }
      );

      const safeFarm = farmName.replaceAll(' ', '_').replaceAll('/', '-');
      const fileName = `Biofert_Reporte_Certificacion_${safeFarm}_${now.toISOString().slice(0, 10)}.pdf`;
      doc.save(fileName);

      this.reportActionMessage.set('PDF generado y descargado correctamente.');
    } catch (e) {
      this.reportActionMessage.set(`No se pudo generar el PDF: ${String((e as any)?.message ?? e)}`);
    } finally {
      this.reportGenerating.set(false);
      setTimeout(() => this.reportActionMessage.set(null), 5000);
    }
  }

  protected readonly co2eqBarHeights = computed(() => {
    const series = this.reports()?.co2eqByMonth ?? [];
    const values = series.map(s => s.co2eq_reduced_t);
    const max = Math.max(...values, 0.001);
    return series.map(s => ({
      month: new Date(String(s.month)).toLocaleDateString('es-CO', { month: 'short' }),
      value: s.co2eq_reduced_t,
      h: Math.round((s.co2eq_reduced_t / max) * 110),
    }));
  });
}
