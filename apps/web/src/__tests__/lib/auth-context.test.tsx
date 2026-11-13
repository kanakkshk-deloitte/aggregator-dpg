import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/lib/auth-context';

function Consumer() {
  const { user, isAuthenticated, isHydrated, supportEnabled, signOut } = useAuth();
  return (
    <div>
      <span data-testid="name">{user?.name ?? 'anon'}</span>
      <span data-testid="authed">{String(isAuthenticated)}</span>
      <span data-testid="hydrated">{String(isHydrated)}</span>
      <span data-testid="support">{String(supportEnabled)}</span>
      <button onClick={() => void signOut()}>sign-out</button>
    </div>
  );
}

describe('AuthProvider / useAuth', () => {
  const origLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, href: '' } as Location,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: origLocation,
    });
  });

  it('defaults to an unauthenticated, unsupported state', () => {
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    expect(screen.getByTestId('name')).toHaveTextContent('anon');
    expect(screen.getByTestId('authed')).toHaveTextContent('false');
    expect(screen.getByTestId('hydrated')).toHaveTextContent('true');
    expect(screen.getByTestId('support')).toHaveTextContent('false');
  });

  it('exposes the supplied initialUser + supportEnabled', () => {
    render(
      <AuthProvider initialUser={{ id: '1', name: 'Asha', org: 'a@b.c' }} supportEnabled>
        <Consumer />
      </AuthProvider>,
    );
    expect(screen.getByTestId('name')).toHaveTextContent('Asha');
    expect(screen.getByTestId('authed')).toHaveTextContent('true');
    expect(screen.getByTestId('support')).toHaveTextContent('true');
  });

  it('signOut redirects to the BFF logout endpoint', () => {
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText('sign-out'));
    expect(window.location.href).toBe('/api/auth/logout');
  });

  it('useAuth throws when used outside an AuthProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useAuth())).toThrow(
      /useAuth must be used within an AuthProvider/,
    );
    spy.mockRestore();
  });
});
