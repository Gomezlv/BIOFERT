import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize } from 'rxjs';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ApiService, Farm, Profile, Reports, Sensor } from './api.service';
import { AuthService } from './auth.service';

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

  protected readonly screen = signal<'inicio' | 'sensores' | 'recomendaciones' | 'reportes' | 'perfil'>('inicio');

  protected readonly profile = signal<Profile | null>(null);
  protected readonly farms = signal<Farm[]>([]);
  protected readonly selectedFarmId = signal<number | null>(null);
  protected readonly pendingFarmId = signal<number | null>(null);

  protected readonly sensors = signal<Sensor[]>([]);
  protected readonly reports = signal<Reports | null>(null);

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
      },
      error: () => this.failSession(),
    });
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
    this.screen.set('inicio');
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
    if (!u || !f) return;

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
  }

  protected submitProfileEdit(): void {
    if (this.profileEditForm.invalid) {
      this.profileEditForm.markAllAsTouched();
      return;
    }
    const farm = this.selectedFarm();
    if (!farm) return;

    const v = this.profileEditForm.getRawValue();
    this.profileEditBusy.set(true);
    this.profileEditMessage.set(null);

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

  protected navigate(id: 'inicio' | 'sensores' | 'recomendaciones' | 'reportes' | 'perfil') {
    this.screen.set(id);
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
    { id: 'auditoria', label: 'Auditoría' },
    { id: 'certifica', label: 'Certifica' },
    { id: 'pago', label: 'Pago' },
  ] as const;
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
