import * as React from "react"
import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export type PageBreadcrumb = {
  label: string
  to?: string
}

export type DetailTabInput =
  | string
  | {
      count?: number
      label?: string
      value: string
    }

export type DetailContentTab = {
  content: React.ReactNode
  count?: number
  label: string
  value: string
}

const sidebarTabValue = "__details__"

export function PageHeader({
  actions,
  breadcrumbs,
  eyebrow,
  title,
}: {
  actions?: React.ReactNode
  breadcrumbs?: PageBreadcrumb[]
  eyebrow?: string
  title: string
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {breadcrumbs?.length ? <PageBreadcrumbs items={breadcrumbs} /> : null}
        {!breadcrumbs?.length && eyebrow ? (
          <div className="text-xs font-medium text-muted-foreground uppercase">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="truncate text-xl font-semibold tracking-normal">
          {title}
        </h1>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
      ) : null}
    </div>
  )
}

export function DetailTabsList({
  label,
  onValueChange,
  value,
  tabs,
}: {
  label: string
  onValueChange: (value: string) => void
  tabs: DetailTabInput[]
  value: string
}) {
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const normalizedTabs = React.useMemo(
    () =>
      tabs.map((tab) =>
        typeof tab === "string"
          ? { value: tab, label: titleCase(tab) }
          : { ...tab, label: tab.label ?? titleCase(tab.value) }
      ),
    [tabs]
  )

  React.useEffect(() => {
    const activeTab = listRef.current?.querySelector<HTMLElement>(
      "[data-state='active'], [data-active]"
    )
    activeTab?.scrollIntoView({ block: "nearest", inline: "center" })
  }, [value])

  return (
    <div className="mb-4 grid gap-2">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="w-full lg:hidden" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {normalizedTabs.map((tab) => (
            <SelectItem key={tab.value} value={tab.value}>
              <DetailTabLabel tab={tab} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative hidden overflow-hidden border-b lg:block">
        <TabsList
          ref={listRef}
          variant="line"
          className="flex w-full max-w-full touch-pan-x justify-start gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain px-3 pb-1 [mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)] [scroll-padding-inline:0.75rem] [scrollbar-width:none] sm:px-0 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden"
          aria-label={label}
        >
          {normalizedTabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="shrink-0 flex-none px-2"
            >
              <DetailTabLabel tab={tab} />
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </div>
  )
}

export function DetailPageContent({
  label,
  onValueChange,
  sidebar,
  sidebarLabel = "Details",
  tabs,
  value,
}: {
  label: string
  onValueChange: (value: string) => void
  sidebar: React.ReactNode
  sidebarLabel?: string
  tabs: DetailContentTab[]
  value: string
}) {
  const fallbackValue = tabs[0]?.value ?? ""
  const contentValue = tabs.some((tab) => tab.value === value)
    ? value
    : fallbackValue
  const [activeValue, setActiveValue] = React.useState(contentValue)
  const hasMultipleTabs = tabs.length > 1

  React.useEffect(() => {
    setActiveValue((current) =>
      current === sidebarTabValue ? current : contentValue
    )
  }, [contentValue])

  React.useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)")
    const closeSidebarTabOnDesktop = () => {
      if (mediaQuery.matches) {
        setActiveValue((current) =>
          current === sidebarTabValue ? contentValue : current
        )
      }
    }

    closeSidebarTabOnDesktop()
    mediaQuery.addEventListener("change", closeSidebarTabOnDesktop)
    return () =>
      mediaQuery.removeEventListener("change", closeSidebarTabOnDesktop)
  }, [contentValue])

  function handleValueChange(nextValue: string) {
    setActiveValue(nextValue)
    if (nextValue !== sidebarTabValue) onValueChange(nextValue)
  }

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(13rem,15rem)]">
      <Tabs value={activeValue} onValueChange={handleValueChange}>
        <DetailContentTabsList
          label={label}
          onValueChange={handleValueChange}
          sidebarLabel={sidebarLabel}
          showDesktopTabs={hasMultipleTabs}
          tabs={tabs}
          value={activeValue}
        />
        {tabs.map((tab) => (
          <TabsContent
            key={tab.value}
            value={tab.value}
            className="grid min-w-0 flex-none gap-4"
          >
            {tab.content}
          </TabsContent>
        ))}
        <TabsContent
          value={sidebarTabValue}
          className="grid flex-none gap-4 lg:hidden"
        >
          {sidebar}
        </TabsContent>
      </Tabs>
      <aside className="hidden min-w-0 content-start gap-4 lg:grid">
        {sidebar}
      </aside>
    </div>
  )
}

function DetailContentTabsList({
  label,
  onValueChange,
  sidebarLabel,
  showDesktopTabs,
  tabs,
  value,
}: {
  label: string
  onValueChange: (value: string) => void
  sidebarLabel: string
  showDesktopTabs: boolean
  tabs: DetailContentTab[]
  value: string
}) {
  const listRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const activeTab = listRef.current?.querySelector<HTMLElement>(
      "[data-state='active'], [data-active]"
    )
    activeTab?.scrollIntoView({ block: "nearest", inline: "center" })
  }, [value])

  return (
    <div className="mb-4 grid gap-2">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="w-full lg:hidden" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {tabs.map((tab) => (
            <SelectItem key={tab.value} value={tab.value}>
              <DetailTabLabel tab={tab} />
            </SelectItem>
          ))}
          <SelectItem value={sidebarTabValue}>{sidebarLabel}</SelectItem>
        </SelectContent>
      </Select>
      <div
        className={
          showDesktopTabs
            ? "relative hidden overflow-hidden border-b lg:block"
            : "hidden"
        }
      >
        <TabsList
          ref={listRef}
          variant="line"
          className="flex w-full max-w-full touch-pan-x justify-start gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain px-3 pb-1 [mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)] [scroll-padding-inline:0.75rem] [scrollbar-width:none] sm:px-0 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden"
          aria-label={label}
        >
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="shrink-0 flex-none px-2"
            >
              <DetailTabLabel tab={tab} />
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </div>
  )
}

function PageBreadcrumbs({ items }: { items: PageBreadcrumb[] }) {
  return (
    <Breadcrumb className="mb-1">
      <BreadcrumbList className="min-w-0 gap-1 uppercase">
        {items.map((item, index) => {
          const isLast = index === items.length - 1
          return (
            <React.Fragment key={`${item.label}:${index}`}>
              <BreadcrumbItem className="min-w-0">
                {item.to && !isLast ? (
                  <BreadcrumbLink asChild className="min-w-0 truncate">
                    <Link to={item.to}>{item.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="min-w-0 truncate text-muted-foreground">
                    {item.label}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {!isLast ? <BreadcrumbSeparator /> : null}
            </React.Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function DetailTabLabel({
  tab,
}: {
  tab: { count?: number; label: string; value: string }
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="truncate">{tab.label}</span>
      {typeof tab.count === "number" ? (
        <Badge
          variant="secondary"
          className="h-5 min-w-5 justify-center px-1 text-[0.65rem] font-normal tabular-nums"
        >
          {tab.count > 999 ? "999+" : numberFormatter.format(tab.count)}
        </Badge>
      ) : null}
    </span>
  )
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
}

const numberFormatter = new Intl.NumberFormat()
