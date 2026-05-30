import * as React from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {controlApi, type ControlSession} from "./api";

type AuthContextValue = {
  session: ControlSession | null;
  csrfToken: string | null;
  isBootstrapping: boolean;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({children}: {children: React.ReactNode}) {
  const queryClient = useQueryClient();
  const [csrfToken, setCsrfToken] = React.useState<string | null>(null);
  const me = useQuery({queryKey: ["control", "me"], queryFn: controlApi.me, retry: false});
  const loginMutation = useMutation({
    mutationFn: controlApi.login,
    onSuccess: (data) => {
      setCsrfToken(data.csrfToken);
      queryClient.setQueryData(["control", "me"], {session: data.session});
    },
  });
  const logoutMutation = useMutation({
    mutationFn: () => controlApi.logout(csrfToken),
    onSettled: () => {
      setCsrfToken(null);
      queryClient.clear();
    },
  });

  const value: AuthContextValue = {
    session: me.data?.session ?? null,
    csrfToken,
    isBootstrapping: me.isLoading,
    login: async (token) => { await loginMutation.mutateAsync(token); },
    logout: async () => { await logoutMutation.mutateAsync(); },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = React.useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
