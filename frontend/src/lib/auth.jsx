/**
 * Session state for the console.
 *
 * One question drives the whole shape of this file: on a cold load, is this
 * browser signed in? The httpOnly session cookie is unreadable from JS, so the
 * only honest answer comes from asking the server. Until that call returns the
 * app renders neither the login screen nor the dashboard — showing a login form
 * to someone who is already signed in is the flicker everyone notices.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, setUnauthorizedHandler } from "./api.js";
import { can as hasPermission, canManageTeam, isReadOnly } from "./permissions.js";

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const queryClient = useQueryClient();

  // Cold-load probe. A 401 here is the expected answer for a signed-out
  // browser, not an error worth surfacing.
  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((data) => { if (!cancelled) setUser(data.user); })
      .catch(() => { if (!cancelled) setUser(null); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(async (email, password) => {
    const data = await api.login({ email, password });
    setUser(data.user);
    // The previous occupant of this tab may have cached queries; none of it is
    // this account's to see.
    queryClient.clear();
    return data.user;
  }, [queryClient]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Even if the call failed the local session is over — the cookie is
      // gone or invalid, and keeping the UI signed in would be a lie.
      setUser(null);
      queryClient.clear();
    }
  }, [queryClient]);

  /**
   * Called when any request comes back 401: the session expired or was revoked
   * elsewhere. Drops straight to the login screen without a page reload.
   */
  const sessionExpired = useCallback(() => {
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  // Any 401 from anywhere in the app lands here.
  useEffect(() => {
    setUnauthorizedHandler(sessionExpired);
    return () => setUnauthorizedHandler(null);
  }, [sessionExpired]);

  /**
   * What this account may see, as decided by the server.
   *
   * `/auth/me` already expands a super admin's implicit "everything", so the
   * client never re-derives the rule — it only reads the answer. These checks
   * shape the UI; they are not the security boundary, and every one of them is
   * enforced again by the API.
   */
  const can = useCallback((...keys) => hasPermission(user, ...keys), [user]);

  const value = useMemo(
    () => ({
      user,
      checking,
      signIn,
      signOut,
      sessionExpired,
      can,
      canManageTeam: canManageTeam(user),
      readOnly: isReadOnly(user),
    }),
    [user, checking, signIn, signOut, sessionExpired, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an <AuthProvider>.");
  return ctx;
};
