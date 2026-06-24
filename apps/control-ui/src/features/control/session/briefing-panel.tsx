import { Brain, FileText, HeartPulse, Pencil, Plus, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useSessionPrompts } from "@/features/control/api/queries"
import { ConfirmButton } from "@/features/control/confirm-actions"
import {
  DetailField,
  DetailPanel,
  TableError,
} from "@/features/control/detail-primitives"
import { formatDate } from "@/features/control/formatting"
import { briefingDefaults, briefingToFormValues } from "@/features/control/forms/form-values"
import { useBriefingSheet } from "@/features/control/forms/use-control-form-sheets"
import { SESSION_PROMPT_META } from "@/features/control/session/session-prompt-meta"
import { controlApi, SESSION_PROMPT_SLUGS, type SessionPrompt, type SessionPromptSlug } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const promptIcons = {
  brief: FileText,
  memory: Brain,
  heartbeat: HeartPulse,
} satisfies Record<SessionPromptSlug, typeof FileText>

function emptyPrompt(sessionId: string, slug: SessionPromptSlug): SessionPrompt {
  return {
    content: "",
    sessionId,
    slug,
    wasSet: false,
  }
}

function isPromptSet(prompt: SessionPrompt) {
  return Boolean(prompt.wasSet && prompt.content.trim())
}

export function BriefingPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const auth = useAuth()
  const briefingSheet = useBriefingSheet()
  const promptBundle = useSessionPrompts(agentKey, sessionId)
  const promptRows = promptBundle.data?.prompts ?? []
  const promptsBySlug = new Map(promptRows.map((prompt) => [prompt.slug, prompt]))
  const prompts = SESSION_PROMPT_SLUGS.map((slug) =>
    promptsBySlug.get(slug) ?? emptyPrompt(sessionId, slug)
  )
  const clear = useToastMutation({
    mutationFn: (slug: SessionPromptSlug) =>
      controlApi.deleteSessionPrompt(agentKey, sessionId, slug, auth.csrfToken),
    success: "Prompt cleared",
    invalidate: controlKeys.agents.session(agentKey, sessionId),
  })
  if (promptBundle.error) return <TableError error={promptBundle.error} />

  function openPromptSheet(record: SessionPrompt) {
    briefingSheet.setOpen(true, {
      context: { agentKey, sessionId, promptSlug: record.slug },
      defaultData: record.wasSet ? briefingToFormValues(record) : briefingDefaults,
      entity: record,
    })
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <DetailPanel title="Session Prompts">
        {promptBundle.isLoading ? (
          <div className="grid gap-3">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : (
          <div className="grid gap-3">
            {prompts.map((prompt) => {
              const meta = SESSION_PROMPT_META[prompt.slug]
              const Icon = promptIcons[prompt.slug]
              const trimmedContent = prompt.content.trim()
              const set = isPromptSet(prompt)
              const canClear = prompt.wasSet && !clear.isPending
              return (
                <section key={prompt.slug} className="border bg-background">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b bg-muted/20 p-3">
                    <div className="flex min-w-0 items-start gap-2">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{meta.label}</div>
                        <div className="text-xs text-muted-foreground">{meta.description}</div>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                      <Button
                        disabled={promptBundle.isLoading}
                        size="sm"
                        variant={set ? "outline" : "default"}
                        onClick={() => openPromptSheet(prompt)}
                      >
                        {set ? <Pencil className="size-4" /> : <Plus className="size-4" />}
                        {set ? "Edit" : "Add"}
                      </Button>
                      {prompt.wasSet ? (
                        <ConfirmButton
                          disabled={!canClear}
                          title={`Clear ${meta.label.toLowerCase()}`}
                          description={`Remove the ${meta.label.toLowerCase()} prompt from this session.`}
                          confirmLabel={`Clear ${meta.label.toLowerCase()}`}
                          entityLabel="Session"
                          itemLabel={sessionId}
                          onConfirm={() => clear.mutateAsync(prompt.slug)}
                          variant="destructive"
                        >
                          <Trash2 className="size-4" />
                          {clear.isPending ? "Clearing" : "Clear"}
                        </ConfirmButton>
                      ) : null}
                    </div>
                  </div>
                  {set ? (
                    <div className="max-h-72 overflow-auto bg-muted/10 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                      {prompt.content}
                    </div>
                  ) : (
                    <div className="border-t border-dashed bg-muted/10 p-4 text-sm text-muted-foreground">
                      Empty
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 border-t p-3 text-xs text-muted-foreground">
                    <Badge variant={set ? "outline" : "secondary"}>
                      {set ? "Set" : "Empty"}
                    </Badge>
                    <span>{trimmedContent.length.toLocaleString()} chars</span>
                    <span>slug {prompt.slug}</span>
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </DetailPanel>
      <DetailPanel title="Prompt State">
        <div className="grid gap-3">
          {prompts.map((prompt) => {
            const set = isPromptSet(prompt)
            const trimmedContent = prompt.content.trim()
            return (
              <DetailField
                key={prompt.slug}
                loading={promptBundle.isLoading}
                label={SESSION_PROMPT_META[prompt.slug].label}
                value={`${set ? "Set" : "Empty"} · ${trimmedContent.length.toLocaleString()} chars`}
              />
            )
          })}
          <DetailField
            loading={promptBundle.isLoading}
            label="Last Updated"
            value={formatDate(
              prompts
                .filter((prompt) => prompt.updatedAt)
                .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0]
                ?.updatedAt
            )}
          />
        </div>
      </DetailPanel>
    </div>
  )
}
