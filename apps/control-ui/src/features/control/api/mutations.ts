import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

export function useToastMutation<TData, TVariables>(options: {
  mutationFn: (variables: TVariables) => Promise<TData>
  success: string
  invalidate: readonly unknown[]
}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async () => {
      toast.success(options.success)
      await queryClient.invalidateQueries({ queryKey: options.invalidate })
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Control write failed"
      )
    },
  })
}
