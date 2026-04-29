import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'biofert_session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly token = signal<string | null>(null);

  constructor() {
    const t = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (t) this.token.set(t);
  }

  setSession(token: string): void {
    localStorage.setItem(STORAGE_KEY, token);
    this.token.set(token);
  }

  clearSession(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.token.set(null);
  }

  isLoggedIn(): boolean {
    return !!this.token();
  }
}
