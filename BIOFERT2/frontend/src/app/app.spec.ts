import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render app title', () => {
    const httpMock = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    // ngOnInit() primero carga profile + farms.
    httpMock.expectOne('http://localhost:3000/api/profile').flush({
      user: { id: 1, full_name: 'Carlos', role: 'Ganadero', location: 'Córdoba', email: 'carlos@example.com' },
    });
    httpMock.expectOne('http://localhost:3000/api/farms?userId=1').flush([
      { id: 1, user_id: 1, name: 'Finca El Porvenir', location: 'Córdoba', area_ha: 320, heads_active: 280 },
    ]);

    // Luego refreshAll() dispara dashboard + sensors + recommendations + reports.
    httpMock.expectOne('http://localhost:3000/api/dashboard?farmId=1').flush({
      farmId: 1,
      emissionsTodayKg: 42.3,
      headsActive: 280,
      reductionMonthPct: 12.4,
      bondsEstimatedUsd: 180,
      emissions24h: [],
    });
    httpMock.expectOne('http://localhost:3000/api/sensors?farmId=1').flush([]);
    httpMock.expectOne('http://localhost:3000/api/recommendations?farmId=1').flush([]);
    httpMock.expectOne('http://localhost:3000/api/reports?farmId=1').flush({
      farmId: 1,
      co2eqReducedT: 4.8,
      bondsCount: 4,
      valueEstimatedUsd: 160,
      revenueAccumUsd: 160,
      co2eqByMonth: [],
    });
    httpMock.verify();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.app-title')?.textContent).toContain('MetaGanado');
  });
});
