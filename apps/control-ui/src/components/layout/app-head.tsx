import * as React from "react"
import { matchPath, useLocation } from "react-router-dom"

const APP_NAME = "Panda Control"
const APP_DESCRIPTION = "Panda Control operator console"
const THEME_COLOR_LIGHT = "#7de000"
const THEME_COLOR_DARK = "#0c0d0a"

const routeMatchers = [
  { pattern: "/login", title: "Sign in" },
  { pattern: "/", title: "Work Failures" },
  { pattern: "/agents", title: "Agents" },
]

export function AppHead() {
  const location = useLocation()

  React.useEffect(() => {
    const title = formatDocumentTitle(resolveRouteTitle(location.pathname, location.search))

    document.title = title
    document.documentElement.lang = "en"

    setNamedMeta("description", APP_DESCRIPTION)
    setNamedMeta("twitter:title", title)
    setNamedMeta("twitter:description", APP_DESCRIPTION)
    setPropertyMeta("og:title", title)
    setPropertyMeta("og:description", APP_DESCRIPTION)
  }, [location.pathname, location.search])

  React.useEffect(() => {
    const root = document.documentElement

    const syncThemeColor = () => {
      setNamedMeta(
        "theme-color",
        root.classList.contains("dark") ? THEME_COLOR_DARK : THEME_COLOR_LIGHT
      )
    }

    syncThemeColor()

    const observer = new MutationObserver(syncThemeColor)
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })

    return () => observer.disconnect()
  }, [])

  return null
}

function resolveRouteTitle(pathname: string, search: string) {
  const staticTitle = routeMatchers.find(({ pattern }) =>
    matchPath({ path: pattern, end: true }, pathname)
  )?.title
  if (staticTitle) return staticTitle

  const sessionMatch = matchPath(
    { path: "/agents/:agentKey/sessions/:sessionId", end: true },
    pathname
  )
  if (sessionMatch) {
    const agentKey = safeDecode(sessionMatch.params.agentKey ?? "agent")
    const sessionId = safeDecode(sessionMatch.params.sessionId ?? "session")
    return `${agentKey} / ${shortIdentifier(sessionId)} / ${activeTab(search, "overview")}`
  }

  const agentMatch = matchPath({ path: "/agents/:agentKey", end: true }, pathname)
  if (agentMatch) {
    const agentKey = safeDecode(agentMatch.params.agentKey ?? "agent")
    return `${agentKey} / ${activeTab(search, "sessions")}`
  }

  return "Control"
}

function activeTab(search: string, fallback: string) {
  const tab = new URLSearchParams(search).get("tab") ?? fallback
  return titleCase(tab)
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function shortIdentifier(value: string) {
  return value.length > 8 ? value.slice(0, 8) : value
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function formatDocumentTitle(pageTitle: string | null) {
  return pageTitle ? `${pageTitle} | ${APP_NAME}` : APP_NAME
}

function setNamedMeta(name: string, content: string) {
  const existing = document.head.querySelector<HTMLMetaElement>(
    `meta[name="${name}"]`
  )
  const meta = existing ?? document.createElement("meta")

  meta.setAttribute("name", name)
  meta.content = content

  if (!existing) document.head.append(meta)
}

function setPropertyMeta(property: string, content: string) {
  const existing = document.head.querySelector<HTMLMetaElement>(
    `meta[property="${property}"]`
  )
  const meta = existing ?? document.createElement("meta")

  meta.setAttribute("property", property)
  meta.content = content

  if (!existing) document.head.append(meta)
}
