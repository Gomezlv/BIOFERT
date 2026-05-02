import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { App } from './app';
import { appConfig } from './app.config';

describe('App', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [...appConfig.providers, provideHttpClientTesting()],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render BIOFERT after sesión simulada', () => {
    localStorage.setItem('biofert_session', 'fake-token');
    const httpMock = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const profileReq = httpMock.expectOne(r => r.url === 'http://localhost:3000/api/profile');
    expect(profileReq.request.headers.get('Authorization')).toBe('Bearer fake-token');
    profileReq.flush({
      user: { id: 1, full_name: 'Carlos', role: 'Ganadero', location: 'Córdoba', email: 'carlos@example.com' },
    });

    const cfgReq = httpMock.expectOne('http://localhost:3000/api/config');
    cfgReq.flush({ googleMapsApiKey: null });

    const farmsReq = httpMock.expectOne(r => r.url === 'http://localhost:3000/api/farms');
    expect(farmsReq.request.headers.get('Authorization')).toBe('Bearer fake-token');
    farmsReq.flush([
      {
        id: 1,
        user_id: 1,
        name: 'Finca El Porvenir',
        location: 'Córdoba',
        area_ha: 320,
        heads_active: 280,
        certification_step: 2,
      },
    ]);

    httpMock.expectOne('http://localhost:3000/api/dashboard?farmId=1').flush({
      farmId: 1,
      alertSensor: null,
      recommendationDay: null,
      emissionsTodayKg: 42.3,
      headsActive: 280,
      reductionMonthPct: 12.4,
      bondsEstimatedUsd: 180,
      emissions24h: [],
    });
    httpMock.expectOne('http://localhost:3000/api/sensors?farmId=1').flush([]);
    httpMock.expectOne('http://localhost:3000/api/reports?farmId=1').flush({
      farmId: 1,
      co2eqReducedT: 0,
      bondsCount: 0,
      valueEstimatedUsd: 0,
      revenueAccumUsd: 0,
      co2eqByMonth: [],
    });
    httpMock.verify();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.app-title')?.textContent).toContain('BIOFERT');
  });
});
