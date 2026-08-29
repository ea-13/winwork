import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Role } from 'shared';
import { supabase } from './supabase';

type SessionState = {
  session: Session | null;
  loading: boolean;
  email: string | null;
  roles: Role[];
  signIn(email: string, password: string): Promise<{ error: string | null }>;
  signOut(): Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Restore first, then subscribe — otherwise a reload flashes the login page
    // before the stored session is read back.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  const value = useMemo<SessionState>(() => {
    const claims = session?.user.app_metadata as { roles?: Role[] } | undefined;
    return {
      session,
      loading,
      email: session?.user.email ?? null,
      // Display only. Every role decision is made again on the server, and
      // again by RLS — this just decides what to render.
      roles: claims?.roles ?? [],
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error?.message ?? null };
      },
      async signOut() {
        await supabase.auth.signOut();
      },
    };
  }, [session, loading]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}
