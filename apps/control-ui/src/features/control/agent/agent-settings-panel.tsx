import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useAgent, useLiveVoiceCatalog } from "@/features/control/api/queries"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

function voiceLabel(voice: string) {
  return voice.charAt(0).toUpperCase() + voice.slice(1)
}

export function AgentSettingsPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const agent = useAgent(agentKey)
  const catalog = useLiveVoiceCatalog()
  const currentVoice = agent.data?.agent.liveVoice
  const [voice, setVoice] = React.useState("")

  React.useEffect(() => {
    if (currentVoice) setVoice(currentVoice)
  }, [currentVoice])

  const save = useToastMutation({
    mutationFn: (nextVoice: string) =>
      controlApi.setAgentLiveVoice(agentKey, nextVoice, auth.csrfToken),
    success: "Live voice updated",
    invalidate: controlKeys.agents.detail(agentKey),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live voice</CardTitle>
        <CardDescription>
          Select the voice used when this agent starts a live call.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex max-w-xl flex-col gap-4">
        <Select
          value={voice}
          onValueChange={setVoice}
          disabled={catalog.isPending || catalog.isError || save.isPending}
        >
          <SelectTrigger aria-label="Live voice">
            <SelectValue placeholder="Select a voice" />
          </SelectTrigger>
          <SelectContent>
            {(catalog.data?.voices ?? []).map((value) => (
              <SelectItem key={value} value={value}>
                {voiceLabel(value)}
                {value === catalog.data?.defaultVoice ? " (default)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          Applies the next time this agent joins a live call. Active calls keep their current voice.
        </p>
        {catalog.isError ? (
          <p className="text-sm text-destructive">Could not load the live voice catalogue.</p>
        ) : null}
        <div>
          <Button
            type="button"
            disabled={!voice || voice === currentVoice || save.isPending}
            onClick={() => save.mutate(voice)}
          >
            {save.isPending ? "Saving…" : "Save voice"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
