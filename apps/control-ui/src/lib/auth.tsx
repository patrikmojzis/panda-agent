import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useLocation } from "react-router-dom"

import { controlKeys } from "@/features/control/api/query-key-factory"
import { useControlSession } from "@/features/control/api/queries"
import { controlApi, readCookie, type ControlSession, type DevLoginInput } from "@/lib/api"

type AuthContextValue = {
  session: ControlSession | null
  csrfToken: string | null
  isLoading: boolean
  login: (token: string) => Promise<void>
  devLogin: (input: DevLoginInput) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = React.createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const [csrfToken, setCsrfToken] = React.useState<string | null>(() => readCookie("panda_control_csrf"))
  const shouldLoadSession = location.pathname !== "/login" || Boolean(csrfToken)
  const me = useControlSession(shouldLoadSession)

  const loginMutation = useMutation({
    mutationFn: controlApi.login,
    onSuccess: async (result) => {
      setCsrfToken(result.csrfToken)
      await queryClient.invalidateQueries({ queryKey: controlKeys.all })
    },
  })

  const devLoginMutation = useMutation({
    mutationFn: controlApi.devLogin,
    onSuccess: async (result) => {
      setCsrfToken(result.csrfToken)
      await queryClient.invalidateQueries({ queryKey: controlKeys.all })
    },
  })

  const logoutMutation = useMutation({
    mutationFn: () => controlApi.logout(csrfToken),
    onSuccess: async () => {
      setCsrfToken(null)
      await queryClient.clear()
    },
  })

  const value = React.useMemo<AuthContextValue>(
    () => ({
      session: me.data?.session ?? null,
      csrfToken,
      isLoading: shouldLoadSession && me.isLoading,
      login: async (token) => {
        await loginMutation.mutateAsync(token)
      },
      devLogin: async (input) => {
        await devLoginMutation.mutateAsync(input)
      },
      logout: async () => {
        await logoutMutation.mutateAsync()
      },
    }),
    [csrfToken, devLoginMutation, loginMutation, logoutMutation, me.data?.session, me.isLoading, shouldLoadSession]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = React.useContext(AuthContext)
  if (!context) throw new Error("useAuth must be used within AuthProvider")
  return context
}
